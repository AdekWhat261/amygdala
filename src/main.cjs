'use strict';
const { Plugin, Modal, PluginSettingTab, Setting, Notice, MarkdownView, requestUrl } = require('obsidian');
const { Drive, sha256, parseFolderLink } = require('./drive.cjs');
const { TeamSheetStore } = require('./team-sheet-store.cjs');
const { GoogleAuth } = require('./auth.cjs');
const { LocalVault, DeviceState } = require('./local.cjs');
const { SyncEngine } = require('./engine.cjs');
const { validateCatalog } = require('./team-plugins.cjs');
const config = require('../config.json');
// Survives plugin unload/reload within the same application window.
const LOCKS = Symbol.for('amygdala-connection.active-passes');
if (!globalThis[LOCKS]) globalThis[LOCKS] = new Set();

class EasySync extends Plugin {
  async onload() {
    this.stopped = false;
    this.running = false;
    this.label = 'Не подключено';
    this.progress = null;
    this.progressListeners = new Set();
    this.diagnosticWrite = Promise.resolve();
    this.lastDiagnosticAt = 0;
    this.device = this.loadLegacyCompatible('amygdala-connection-device', 'easy-sync-device') || globalThis.crypto.randomUUID();
    this.app.saveLocalStorage('amygdala-connection-device', this.device);
    this.prefs = this.loadLegacyCompatible('amygdala-connection-preferences', 'easy-sync-preferences') || { auto: true };
    this.app.saveLocalStorage('amygdala-connection-preferences', this.prefs);
    this.connection = this.loadLegacyCompatible('amygdala-connection-connection', 'easy-sync-connection');
    this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
    this.accountEmails = { personal: this.loadLegacyCompatible('amygdala-connection-account-personal', 'easy-sync-account-personal') || (this.connection?.kind !== 'team' ? this.connection?.email : null),
      team: this.loadLegacyCompatible('amygdala-connection-account-team', 'easy-sync-account-team') || (this.connection?.kind === 'team' ? this.connection?.email : null) };
    const makeAuth = (mode, teamFormat = 3) => {
      const isTeam = mode === 'team', legacyTeam = isTeam && teamFormat === 2;
      const secret = isTeam ? legacyTeam ? `amygdala-connection-team-${this.device}` : `amygdala-connection-team-file-${this.device}` : `amygdala-connection-${this.device}`;
      const legacySecret = isTeam ? legacyTeam ? `easy-sync-team-${this.device}` : null : `easy-sync-${this.device}`;
      return new GoogleAuth({ bridge: config.bridgeUrl, email: this.accountEmails[isTeam ? 'team' : 'personal'], mode, teamFormat, request: requestUrl,
        secrets: { get: () => mode === 'team' ? this.app.secretStorage.getSecret(secret) : this.legacyCompatibleSecret(secret, legacySecret), set: value => this.app.secretStorage.setSecret(secret, value) },
        getPending: () => { const pendingKey = `${secret}-pending`; const s = mode === 'team' ? this.app.secretStorage.getSecret(pendingKey) : this.legacyCompatibleSecret(pendingKey, `${legacySecret}-pending`); return s ? JSON.parse(s) : null; },
        savePending: p => this.app.secretStorage.setSecret(`${secret}-pending`, p ? JSON.stringify(p) : '') });
    };
    this.auth = makeAuth('personal');
    this.teamAuth = makeAuth('team');
    this.legacyTeamAuth = makeAuth('team', 2);
    const completeLogin = params => {
      void (async () => {
        let failure;
        for (const mode of ['personal', 'team', 'team-legacy']) {
          try {
            const identity = await this.authFor(mode).complete(params);
            const accountMode = mode === 'personal' ? 'personal' : 'team';
            if (identity.email) {
              this.accountEmails[accountMode] = identity.email;
              this.authFor(mode).email = identity.email;
              this.app.saveLocalStorage(`amygdala-connection-account-${accountMode}`, identity.email);
            }
            if (identity.pickedSpreadsheetId) this.pendingTeamSpreadsheetId = identity.pickedSpreadsheetId;
            if (this.connection && identity.email && (this.connection.kind === 'team' ? 'team' : 'personal') === accountMode) {
              this.connection.email = identity.email; this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
            }
            if (mode === 'team' && identity.pickedSpreadsheetId && this.accountEmails.team) {
              const drive = this.drive(null, { mode: 'team', spreadsheetId: identity.pickedSpreadsheetId });
              const team = await drive.teamInfo(); team.actor = await drive.actorFor(this.accountEmails.team);
              this.pendingTeamSpreadsheetId = null;
              await this.selectVault(team);
              new ConnectModal(this).open(); return;
            }
            this.setStatus(`Google подключён · ${accountMode === 'team' ? (mode === 'team-legacy' ? 'командный режим 0.2' : 'командный доступ') : 'личный режим'}`);
            new ConnectModal(this).open(); return;
          } catch (error) { failure = error; }
        }
        this.report(failure || new Error('Не удалось завершить вход Google.'));
      })();
    };
    this.registerObsidianProtocolHandler('amygdala-connection-oauth', completeLogin);
    const handleRun = params => {
      if (params.action !== 'sync' && params.action !== 'verify') return;
      void this.sync(true, params.action === 'verify');
    };
    this.registerObsidianProtocolHandler('amygdala-connection-run', handleRun);
    this.registerObsidianProtocolHandler('amygdala-connection-private-link', params => this.openPrivateLink(params));
    this.addRibbonIcon('refresh-cw', 'Amygdala', () => new ConnectModal(this).open());
    this.status = this.addStatusBarItem();
    this.status.addClass('easy-sync-status');
    this.status.addEventListener('click', () => new ConnectModal(this).open());
    this.addCommand({ id: 'connect', name: 'Подключить устройство', callback: () => new ConnectModal(this).open() });
    this.addCommand({ id: 'sync-now', name: 'Синхронизировать сейчас', callback: () => this.sync(true) });
    this.addCommand({ id: 'resolve-conflicts', name: 'Показать конфликты Amygdala', callback: () => this.openConflicts() });
    this.addCommand({ id: 'link-personal-note', name: 'Связать командную заметку с личной', callback: () => this.createPrivateLink() });
    this.addCommand({ id: 'rebind-personal-note-link', name: 'Переназначить личную ссылку', callback: () => this.rebindPrivateLink() });
    this.addSettingTab(new SyncSettings(this.app, this));
    this.registerInterval(window.setInterval(() => {
      if (this.prefs.auto && this.connection && !this.stopped) void this.sync(false);
    }, 60000));
    this.app.workspace.onLayoutReady(() => {
      this.setStatus(this.connection ? 'Готово к синхронизации' : 'Подключите Google Drive');
      if (this.connection && this.prefs.auto) void this.sync(false, Boolean(config.verifyOnLoad));
    });
  }
  loadLegacyCompatible(currentKey, legacyKey) {
    const current = this.app.loadLocalStorage(currentKey);
    if (current !== null && current !== undefined) return current;
    const legacy = this.app.loadLocalStorage(legacyKey);
    if (legacy !== null && legacy !== undefined) this.app.saveLocalStorage(currentKey, legacy);
    return legacy;
  }
  legacyCompatibleSecret(currentKey, legacyKey) {
    const current = this.app.secretStorage.getSecret(currentKey);
    if (current) return current;
    const legacy = this.app.secretStorage.getSecret(legacyKey);
    if (legacy) this.app.secretStorage.setSecret(currentKey, legacy);
    return legacy;
  }
  setStatus(text) {
    this.label = text; this.status?.setText(`Amygdala · ${text}`);
    for (const listener of this.progressListeners) listener(this.progress, text);
    this.persistDiagnostic(false);
  }
  persistDiagnostic(force) {
    const now = Date.now();
    if (!force && now - this.lastDiagnosticAt < 500) return;
    this.lastDiagnosticAt = now;
    const value = { label: this.label, progress: this.progress, running: this.running,
      connected: Boolean(this.connection), updatedAt: new Date(now).toISOString() };
    this.diagnosticWrite = this.diagnosticWrite.then(() => this.saveData(value)).catch(() => {});
  }
  setProgress(progress) {
    this.progress = progress;
    const text = progress?.phase === 'upload' ? `Загрузка ${progress.completed} из ${progress.total}`
      : progress?.phase === 'listing' ? 'Проверяю облако…'
      : progress?.phase === 'history' ? `Читаю историю ${progress.completed} из ${progress.total}`
      : progress?.phase === 'verify' ? `Проверяю файлы ${progress.completed} из ${progress.total}`
      : progress?.phase === 'planning' ? `Готовлю ${progress.total} файлов…`
      : progress?.phase === 'reconciling' ? 'Сверяю изменения…' : 'Синхронизация…';
    this.setStatus(text);
  }
  subscribeProgress(listener) { this.progressListeners.add(listener); return () => this.progressListeners.delete(listener); }
  report(error) { this.setStatus(error.message || 'Ошибка синхронизации'); new Notice(this.label, 10000); }
  privateLinks() {
    const value = this.app.loadLocalStorage('amygdala-connection-private-links');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  savePrivateLinks(value) { this.app.saveLocalStorage('amygdala-connection-private-links', value); }
  createPrivateLink() {
    if (this.connection?.kind !== 'team') { new Notice('Подключите командное хранилище, чтобы добавить такую ссылку.'); return; }
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!editor) { new Notice('Откройте командную заметку и повторите действие.'); return; }
    new PrivateNoteLinkModal(this, globalThis.crypto.randomUUID(), editor).open();
  }
  rebindPrivateLink() {
    if (this.connection?.kind !== 'team') { new Notice('Подключите командное хранилище, чтобы переназначить такую ссылку.'); return; }
    const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!editor) { new Notice('Откройте командную заметку и поставьте курсор на личную ссылку.'); return; }
    const text = editor.getSelection() || editor.getLine(editor.getCursor().line);
    const match = /obsidian:\/\/amygdala-connection-private-link\?id=([0-9a-f-]{36})/i.exec(text || '');
    if (!match) { new Notice('Поставьте курсор на строку с личной ссылкой или выделите её.'); return; }
    new PrivateNoteLinkModal(this, match[1]).open();
  }
  openPrivateLink(params) {
    const id = params?.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { new Notice('Некорректная ссылка на личную заметку.'); return; }
    const target = this.privateLinks()[id];
    if (!target) { new PrivateNoteLinkModal(this, id).open(); return; }
    if (typeof target.vault !== 'string' || typeof target.file !== 'string' || !target.vault || !target.file
      || target.file.startsWith('/') || target.file.includes('\\') || target.file.split('/').some(part => !part || part === '.' || part === '..')) {
      new Notice('Локальная привязка повреждена. Переназначьте её через команду Amygdala.'); return;
    }
    const uri = new URL('obsidian://open');
    uri.searchParams.set('vault', target.vault);
    uri.searchParams.set('file', target.file);
    window.open(uri.toString());
  }
  authFor(mode) { return mode === 'team-legacy' ? this.legacyTeamAuth : mode === 'team' ? this.teamAuth : this.auth; }
  drive(connection = this.connection, override = {}) {
    const mode = override.mode || (connection?.kind === 'team' ? 'team' : 'personal');
    const legacyTeam = mode === 'team' && (override.teamFormat === 2 || (connection?.kind === 'team' && !connection?.folderId && !override.spreadsheetId));
    const auth = legacyTeam ? this.legacyTeamAuth : this.authFor(mode);
    if (mode === 'team' && !legacyTeam) return new TeamSheetStore({ request: requestUrl, getAccessToken: () => auth.accessToken(),
      folderId: override.folderId || connection?.folderId || null,
      spreadsheetId: override.spreadsheetId || connection?.id || null,
      progress: progress => this.setProgress(progress) });
    return new Drive({ request: requestUrl, getAccessToken: () => auth.accessToken(), mode,
      vaultId: connection?.id, folderId: legacyTeam ? connection.id : undefined,
    progress: progress => this.setProgress(progress) }); }
  async selectVault(vault) {
    if (this.running) throw new Error('Дождитесь окончания синхронизации.');
    const kind = vault.kind === 'team' ? 'team' : 'personal';
    this.connection = { kind, id: vault.id, name: vault.name, email: this.accountEmails[kind] || '', ...(kind === 'team' ? { version: vault.version || 3 } : {}),
      ...(kind === 'team' ? { folderId: vault.folderId || null, actor: vault.actor || null,
        webViewLink: vault.webViewLink || `https://drive.google.com/drive/folders/${vault.folderId || vault.id}`,
        spreadsheetLink: vault.spreadsheetLink || `https://docs.google.com/spreadsheets/d/${vault.id}/edit` } : {}) };
    this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
    this.engine = null;
    await this.stateStore?.close(); this.stateStore = null;
    await this.sync(true);
  }
  async sync(manual = false, verify = false) {
    if (this.stopped || this.running) return;
    if (!this.connection) { if (manual) new ConnectModal(this).open(); return; }
    const mode = this.connection.kind === 'team' ? 'team' : 'personal';
    const lock = `${mode}-${this.device}-${this.connection.id}`;
    if (globalThis[LOCKS].has(lock)) return;
    globalThis[LOCKS].add(lock);
    this.running = true;
    this.setProgress({ phase: 'starting' });
    try {
      if (!this.engine) {
        await this.stateStore?.close();
        const stateKey = mode === 'team' ? `team-${this.device}-${this.connection.id}` : `${this.device}-${this.connection.id}`;
        this.stateStore = new DeviceState(stateKey);
        const state = await this.stateStore.load();
        const remote = this.drive(this.connection);
        const actor = mode === 'team' ? await remote.actorFor(this.accountEmails.team || this.connection.email) : null;
        if (mode === 'team' && JSON.stringify(actor) !== JSON.stringify(this.connection.actor || null)) {
          this.connection.actor = actor; this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
        }
        this.engine = new SyncEngine({ remote, local: new LocalVault(this.app),
          state, saveState: value => this.stateStore.save(value), randomId: () => globalThis.crypto.randomUUID(), hash: sha256,
          actor, deviceId: this.device,
          progress: progress => this.setProgress(progress) });
      }
      const result = await this.engine.sync();
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (verify && !result.conflicts.length && !result.deferred.length) {
        const checked = await this.engine.verify();
        this.setStatus(`Проверено ${checked.files} файлов · ${time}`);
      } else this.setStatus(result.conflicts.length ? `Сохранены конфликтные версии · ${time}` : result.deferred.length ? 'Есть отложенные изменения' : `Синхронизировано · ${time}`);
      if (manual) new Notice(this.label);
    } catch (error) {
      // Reload durable state on retry if saving it failed part-way through a run.
      this.engine = null;
      this.setStatus(error.message || 'Не удалось синхронизировать');
      if (manual) new Notice(this.label, 10000);
    } finally {
      this.running = false; this.progress = null;
      for (const listener of this.progressListeners) listener(null, this.label);
      this.persistDiagnostic(true);
      globalThis[LOCKS].delete(lock);
    }
  }
  async disconnect() {
    if (this.running) throw new Error('Дождитесь окончания синхронизации.');
    const mode = this.connection?.kind === 'team' ? (this.connection.folderId ? 'team' : 'team-legacy') : 'personal';
    const accountMode = mode === 'team-legacy' ? 'team' : mode;
    await this.authFor(mode).disconnect(); this.accountEmails[accountMode] = null;
    this.app.saveLocalStorage(`amygdala-connection-account-${accountMode}`, null);
    this.connection = null; this.engine = null;
    this.app.saveLocalStorage('amygdala-connection-connection', null);
    this.setStatus('Устройство отключено');
  }
  async openConflicts() {
    if (!this.connection) { new ConnectModal(this).open(); return; }
    if (!this.engine) await this.sync(true);
    if (!this.engine) return;
    try { new ConflictModal(this, await this.engine.listConflicts()).open(); }
    catch (error) { this.report(error); }
  }
  async installTeamPlugin(item) {
    if (this.connection?.kind !== 'team') throw new Error('Подключите командное хранилище.');
    const catalog = validateCatalog(await this.drive().getTeamPluginCatalog());
    const approved = catalog.find(plugin => plugin.id === item.id && plugin.version === item.version);
    if (!approved) throw new Error('Предложение команды изменилось. Обновите список и проверьте его снова.');
    const base = `https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json`;
    const registryResponse = await requestUrl({ url: base, throw: false });
    if (registryResponse.status !== 200 || !Array.isArray(registryResponse.json)) throw new Error('Не удалось проверить официальный каталог Obsidian.');
    const registry = registryResponse.json.find(entry => entry.id === item.id);
    if (!registry || registry.version !== item.version || registry.name !== item.name || registry.author !== item.author || registry.description !== item.description
      || typeof registry.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(registry.repo)) {
      throw new Error('Метаданные плагина не совпадают с официальным каталогом Obsidian. Ничего не установлено.');
    }
    const repositoryResponse = await requestUrl({ url: `https://api.github.com/repos/${registry.repo}`, throw: false });
    const branch = repositoryResponse.json?.default_branch;
    if (repositoryResponse.status !== 200 || typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes('..')) {
      throw new Error('Не удалось проверить ветку репозитория плагина. Ничего не установлено.');
    }
    const raw = `https://raw.githubusercontent.com/${registry.repo}/${encodeURIComponent(branch)}`;
    const manifestResponse = await requestUrl({ url: `${raw}/manifest.json`, throw: false });
    if (manifestResponse.status !== 200 || manifestResponse.json?.id !== item.id || manifestResponse.json?.version !== item.version) {
      throw new Error('Манифест репозитория не совпадает с предложением. Ничего не установлено.');
    }
    const pluginDir = `.obsidian/plugins/${item.id}`;
    const existed = await this.app.vault.adapter.exists(pluginDir);
    if (existed) {
      let installed;
      try { installed = JSON.parse(await this.app.vault.adapter.read(`${pluginDir}/manifest.json`)); }
      catch { throw new Error('Папка плагина уже существует или повреждена. Ничего не изменено.'); }
      if (installed.id !== item.id) throw new Error('ID установленного плагина не совпадает. Ничего не изменено.');
    }
    const files = [];
    for (const name of ['manifest.json', 'main.js', 'styles.css']) {
      const response = await requestUrl({ url: `${raw}/${name}`, throw: false });
      if (response.status === 404 && name === 'styles.css') continue;
      if (response.status !== 200 || typeof response.text !== 'string' || response.text.length > (name === 'main.js' ? 10_000_000 : 2_000_000)) throw new Error(`Не удалось безопасно получить ${name}. Ничего не установлено.`);
      if (name === 'manifest.json') {
        let downloaded;
        try { downloaded = JSON.parse(response.text); } catch { throw new Error('Манифест репозитория повреждён.'); }
        if (downloaded.id !== item.id || downloaded.version !== item.version) throw new Error('Манифест изменился во время загрузки. Ничего не установлено.');
      }
      files.push([name, response.text]);
    }
    const backupDir = `.easy-sync/recovery/team-plugins/${item.id}/${Date.now()}-${globalThis.crypto.randomUUID()}`;
    const previous = [];
    try {
      if (existed) {
        await this.ensureAdapterDirectory(backupDir);
        for (const name of ['manifest.json', 'main.js', 'styles.css']) {
          const oldPath = `${pluginDir}/${name}`;
          if (await this.app.vault.adapter.exists(oldPath)) {
            const content = await this.app.vault.adapter.read(oldPath);
            previous.push([name, content]);
            await this.app.vault.adapter.write(`${backupDir}/${name}`, content);
          }
        }
        if (!files.some(([name]) => name === 'styles.css') && await this.app.vault.adapter.exists(`${pluginDir}/styles.css`)) {
          await this.app.vault.adapter.remove(`${pluginDir}/styles.css`);
        }
      } else await this.ensureAdapterDirectory(pluginDir);
      for (const [name, content] of files) await this.app.vault.adapter.write(`${pluginDir}/${name}`, content);
    } catch (error) {
      if (existed) {
        for (const [name, content] of previous) await this.app.vault.adapter.write(`${pluginDir}/${name}`, content).catch(() => {});
      } else {
        for (const [name] of files) if (await this.app.vault.adapter.exists(`${pluginDir}/${name}`)) await this.app.vault.adapter.remove(`${pluginDir}/${name}`).catch(() => {});
        if (await this.app.vault.adapter.exists(pluginDir)) await this.app.vault.adapter.rmdir(pluginDir, true).catch(() => {});
      }
      throw new Error(`Не удалось завершить установку. ${existed ? 'Предыдущие файлы восстановлены из локальной копии.' : 'Частично записанная папка удалена.'} ${error.message}`);
    }
  }
  async ensureAdapterDirectory(path) {
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) await this.app.vault.adapter.mkdir(current);
    }
  }
  onunload() { this.stopped = true; /* In-flight writes finish with their recovery journal. */ }
}

class ConnectModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() { void this.render(); }
  async render() {
    const p = this.plugin, el = this.contentEl;
    el.empty(); el.addClass('amygdala-connection-panel');
    el.createEl('h2', { text: p.connection?.kind === 'team' ? 'Командный цеттелькастен' : 'Amygdala' });
    if (config.beta) el.createEl('p', { text: 'Закрытая beta: Google может попросить повторный вход примерно раз в неделю. Перед загрузкой подключайте копию vault.', cls: 'easy-sync-warning' });
    if (!config.bridgeUrl) {
      el.createEl('p', { text: 'Сервис входа ещё не подключён. Эта сборка подготовлена для проверки; облачная синхронизация пока недоступна.', cls: 'easy-sync-warning' });
      return;
    }
    if (p.connection) {
      el.createEl('h3', { text: p.connection.name });
      const teamLegacy = p.connection.kind === 'team' && !p.connection.folderId;
      el.createEl('p', { text: `${p.connection.kind === 'team' ? (teamLegacy ? 'Командное хранилище 0.2' : 'Командное хранилище 0.3') : 'Личное хранилище 0.1'} · ${p.connection.email || 'Google не подключён'}` });
      if (p.connection.kind === 'team') new Setting(el).setName('Папка команды').setDesc('Состав и права участников настраиваются в Google Drive.')
        .addButton(b => b.setButtonText('Открыть Drive').onClick(() => window.open(p.connection.webViewLink || `https://drive.google.com/drive/folders/${p.connection.id}`)));
      const statusText = el.createEl('p', { text: p.label });
      const progress = el.createDiv({ cls: 'easy-sync-progress' });
      const progressText = progress.createEl('div', { cls: 'easy-sync-progress-text' });
      const bar = progress.createEl('progress');
      const updateProgress = (state, text) => {
        statusText.setText(text);
        if (!p.running || !state) { progress.style.display = 'none'; return; }
        progress.style.display = '';
        progressText.setText(text);
        if ((state.phase === 'upload' || state.phase === 'history' || state.phase === 'verify') && state.total > 0) {
          bar.style.display = '';
          bar.max = state.total; bar.value = state.completed;
        } else bar.style.display = 'none';
      };
      this.unsubscribe?.(); this.unsubscribe = p.subscribeProgress(updateProgress);
      updateProgress(p.progress, p.label);
      new Setting(el).addButton(b => b.setButtonText('Синхронизировать').setCta().onClick(async () => { await p.sync(true); await this.render(); }));
      new Setting(el).setName('Проверка облачной копии').setDesc('Скачать файлы обратно и сравнить их с локальными байт в байт.')
        .addButton(b => b.setButtonText('Проверить').onClick(async () => { b.setDisabled(true); await p.sync(true, true); await this.render(); }));
      new Setting(el).setName('Конфликты заметок').setDesc('Сравнить версии и выбрать итоговую.')
        .addButton(b => b.setButtonText('Открыть').onClick(() => p.openConflicts()));
      if (p.connection.kind === 'team') new Setting(el).setName('Командные плагины').setDesc('Опубликовать предложения и выбрать, какие установить на это устройство.')
        .addButton(b => b.setButtonText('Открыть').onClick(() => new TeamPluginsModal(p).open()));
      new Setting(el).setName('Вход Google').setDesc('В тестовом режиме Google может завершить авторизацию через 7 дней.')
        .addButton(b => b.setButtonText('Переподключить').onClick(() => void this.beginLogin(p.connection.kind === 'team' ? (teamLegacy ? 'team-legacy' : 'team') : 'personal')));
      new Setting(el).setName('Отключить это устройство').setDesc('Заметки на устройстве и в облаке сохранятся.')
        .addButton(b => b.setButtonText('Отключить').onClick(async () => { try { await p.disconnect(); await this.render(); } catch (e) { p.report(e); } }));
      return;
    }
    const personalToken = p.legacyCompatibleSecret(`amygdala-connection-${p.device}`, `easy-sync-${p.device}`);
    const teamToken = p.app.secretStorage.getSecret(`amygdala-connection-team-file-${p.device}`);
    const legacyTeamToken = p.legacyCompatibleSecret(`amygdala-connection-team-${p.device}`, `easy-sync-team-${p.device}`);
    if (!legacyTeamToken) new Setting(el).setName('Существующее командное хранилище 0.2')
      .setDesc('Используйте только если у вас уже есть папка старого формата. Доступ сохранится отдельно от формата 0.3.')
      .addButton(b => b.setButtonText('Войти в старый режим').onClick(() => void this.beginLogin('team-legacy')));
    if (!personalToken) new Setting(el).setName('Личное хранилище 0.1').setDesc('Подключается через служебный раздел вашего Google Drive.')
      .addButton(b => b.setButtonText('Войти в личный режим').onClick(() => void this.beginLogin('personal')));
    if (personalToken) {
      el.createEl('h3', { text: 'Личное хранилище 0.1' });
      const loading = el.createEl('p', { text: 'Ищу личные хранилища…' });
      try {
        const drive = p.drive(null, { mode: 'personal' }), vaults = await drive.listVaults(); loading.remove();
        for (const vault of vaults) new Setting(el).setName(vault.name)
          .addButton(b => b.setButtonText('Подключить').onClick(async () => {
            b.setDisabled(true); try { await p.selectVault({ ...vault, kind: 'personal' }); await this.render(); } catch (e) { p.report(e); b.setDisabled(false); }
          }));
        let name = 'Мой цеттелькастен';
        new Setting(el).setName('Новое личное хранилище').addText(t => t.setValue(name).onChange(v => { name = v; }))
          .addButton(b => b.setButtonText('Создать').onClick(async () => {
            b.setDisabled(true); try { const v = await drive.createVault(name); await p.selectVault({ ...v, kind: 'personal' }); await this.render(); }
            catch (e) { p.report(e); b.setDisabled(false); }
          }));
      } catch (e) { loading.setText(e.message); }
    }
    el.createEl('h3', { text: 'Командное хранилище 0.3' });
    el.createEl('p', { text: 'Командная папка содержит одну служебную Google Таблицу с историей и вложениями. Каждый участник выбирает эту таблицу в Google Picker; Amygdala получает доступ только к выбранному файлу.' });
    let teamEmail = p.accountEmails.team || '';
    const saveTeamEmail = () => {
      teamEmail = teamEmail.trim();
      p.accountEmails.team = teamEmail || null;
      p.teamAuth.email = p.accountEmails.team;
      p.app.saveLocalStorage('amygdala-connection-account-team', p.accountEmails.team);
      return teamEmail;
    };
    new Setting(el).setName('Email Google участника').addText(t => t.setPlaceholder('name@example.com').setValue(teamEmail).onChange(v => {
      teamEmail = v; p.accountEmails.team = v.trim() || null; p.teamAuth.email = p.accountEmails.team;
      p.app.saveLocalStorage('amygdala-connection-account-team', p.accountEmails.team);
    }));
    if (legacyTeamToken) {
      el.createEl('h3', { text: 'Существующее командное хранилище 0.2' });
      el.createEl('p', { text: 'Старый формат остаётся отдельным. Он подключается к прежней папке Google Drive; для нового командного хранилища 0.3 создайте новую служебную таблицу.' });
      let link = '';
      new Setting(el).setName('Ссылка на старую командную папку').addText(t => t.setPlaceholder('https://drive.google.com/drive/folders/…').onChange(value => { link = value; }))
        .addButton(b => b.setButtonText('Подключить формат 0.2').onClick(async () => {
          b.setDisabled(true);
          try {
            const folderId = parseFolderLink(link), drive = p.drive(null, { mode: 'team', teamFormat: 2, folderId });
            const team = await drive.teamInfo(); team.actor = await drive.actorFor(p.accountEmails.team || '');
            team.version = 2; await p.selectVault(team); await this.render();
          } catch (error) { p.report(error); b.setDisabled(false); }
        }));
    }
    if (teamToken) {
      let name = 'Командный цеттелькастен';
      new Setting(el).setName('Создать командное хранилище').addText(t => t.setValue(name).onChange(v => { name = v; }))
        .addButton(b => b.setButtonText('Создать').setCta().onClick(async () => {
          b.setDisabled(true);
          try {
            const email = saveTeamEmail(); if (!email.includes('@')) throw new Error('Укажите email Google участника.');
            const drive = p.drive(null, { mode: 'team' }); const team = await drive.createTeamVault(name);
            team.actor = await drive.actorFor(email); await p.selectVault(team); await this.render();
          } catch (e) { p.report(e); b.setDisabled(false); }
        }));
      new Setting(el).setName('Подключиться к общей папке').setDesc('Владелец должен сначала выдать этому Google-аккаунту доступ редактора к папке.')
        .addButton(b => b.setButtonText('Выбрать таблицу команды').setCta().onClick(async () => {
          const email = saveTeamEmail(); if (!email.includes('@')) { p.report(new Error('Сначала укажите email Google участника.')); return; }
          await this.beginLogin('team', { pickTeamStore: true });
        }));
    } else {
      new Setting(el).setName('Создать командное хранилище')
        .addButton(b => b.setButtonText('Войти в Google').setCta().onClick(async () => {
          const email = saveTeamEmail(); if (!email.includes('@')) { p.report(new Error('Сначала укажите email Google участника.')); return; }
          await this.beginLogin('team');
        }));
      new Setting(el).setName('Подключиться к общей папке')
        .addButton(b => b.setButtonText('Войти и выбрать таблицу').onClick(async () => {
          const email = saveTeamEmail(); if (!email.includes('@')) { p.report(new Error('Сначала укажите email Google участника.')); return; }
          await this.beginLogin('team', { pickTeamStore: true });
        }));
    }
    if (p.pendingTeamSpreadsheetId) new Setting(el).setName('Таблица команды выбрана в Google Picker')
      .addButton(b => b.setButtonText('Проверить и подключить').setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          const email = saveTeamEmail(); if (!email.includes('@')) throw new Error('Укажите email Google участника.');
          const drive = p.drive(null, { mode: 'team', spreadsheetId: p.pendingTeamSpreadsheetId });
          const team = await drive.teamInfo(); team.actor = await drive.actorFor(email);
          p.pendingTeamSpreadsheetId = null; await p.selectVault(team); await this.render();
        } catch (e) { p.report(e); b.setDisabled(false); }
      }));
    el.createEl('p', { text: 'Настройки и включённые плагины устройств не синхронизируются. Командные плагины можно предлагать отдельно; каждый участник сам принимает или отклоняет предложение.' });
  }
  async beginLogin(mode, options = {}) {
    try {
      const url = await this.plugin.authFor(mode).start(options); window.open(url);
    }
    catch (error) { this.plugin.report(error); }
  }
  onClose() { this.unsubscribe?.(); this.unsubscribe = null; this.contentEl.empty(); }
}

class SyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin; el.empty();
    el.createEl('h2', { text: 'Amygdala' });
    el.createEl('p', { text: p.label });
    const account = p.accountEmails[p.connection?.kind === 'team' ? 'team' : 'personal'];
    new Setting(el).setName('Google Drive').setDesc(account || 'Аккаунт не подключён')
      .addButton(b => b.setButtonText('Подключение').onClick(() => new ConnectModal(p).open()));
    new Setting(el).setName('Автоматическая синхронизация').setDesc('Раз в минуту, пока Obsidian открыт.')
      .addToggle(t => t.setValue(p.prefs.auto).onChange(v => { p.prefs.auto = v; p.app.saveLocalStorage('amygdala-connection-preferences', p.prefs); }));
    el.createEl('p', { text: 'Синхронизируются заметки, теги, ссылки, рисунки и вложения. Настройки и включённые плагины устройств не синхронизируются.' });
    el.createEl('p', { text: 'Перед использованием отключите другие плагины синхронизации для этого хранилища. История заменённых файлов хранится локально в .easy-sync/recovery.' });
  }
}

function lineDiff(before, after) {
  const left = before.split('\n'), right = after.split('\n');
  if (left.length * right.length > 200000) return 'Файл слишком велик для встроенного сравнения. Откройте обе версии и сравните их в редакторе.';
  const width = right.length + 1, table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1
      : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const lines = []; let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { lines.push(`  ${left[i++]}`); j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) lines.push(`− ${left[i++]}`);
    else lines.push(`+ ${right[j++]}`);
  }
  while (i < left.length) lines.push(`− ${left[i++]}`);
  while (j < right.length) lines.push(`+ ${right[j++]}`);
  return lines.join('\n');
}

class ConflictModal extends Modal {
  constructor(plugin, conflicts) { super(plugin.app); this.plugin = plugin; this.conflicts = conflicts; }
  onOpen() { void this.render(); }
  async render() {
    const el = this.contentEl, p = this.plugin;
    el.empty(); el.addClass('amygdala-connection-conflicts');
    el.createEl('h2', { text: 'Конфликты Amygdala' });
    if (!this.conflicts.length) { el.createEl('p', { text: 'Активных конфликтов нет.' }); return; }
    for (const conflict of this.conflicts) {
      el.createEl('h3', { text: conflict.path });
      const live = conflict.variants.filter(variant => !variant.deleted);
      if (live.length > 1) {
        const firstText = new TextDecoder('utf-8', { fatal: false }).decode(await p.engine.local.readConflict(conflict.path, live[0].hash));
        for (const variant of live.slice(1)) {
          const otherText = new TextDecoder('utf-8', { fatal: false }).decode(await p.engine.local.readConflict(conflict.path, variant.hash));
          el.createEl('h4', { text: `Сравнение: ${live[0].actorName} / ${variant.actorName}` });
          el.createEl('pre', { text: lineDiff(firstText, otherText), cls: 'easy-sync-diff' });
        }
      }
      for (const variant of conflict.variants) {
        const info = [variant.actorName, variant.deviceId ? `устройство ${variant.deviceId.slice(0, 8)}` : '', variant.createdAt ? new Date(variant.createdAt).toLocaleString() : '', variant.deleted ? 'удаление' : ''].filter(Boolean).join(' · ');
        el.createEl('p', { text: `${info || 'Неизвестный участник'} · ${variant.deleted ? 'версия удаляет заметку' : variant.hash.slice(0, 12)}` });
        if (!variant.deleted) new Setting(el).setName('Версия').addButton(b => b.setButtonText('Открыть копию').onClick(() => void p.app.workspace.openLinkText(variant.copyPath, '', true)))
          .addButton(b => b.setButtonText('Оставить эту').setCta().onClick(async () => {
            b.setDisabled(true);
            try { await p.engine.resolveConflict(conflict.path, variant.id); await p.sync(true); this.conflicts = await p.engine.listConflicts(); await this.render(); }
            catch (error) { p.report(error); b.setDisabled(false); }
          }));
        else new Setting(el).setName('Версия удаления').addButton(b => b.setButtonText('Принять удаление').onClick(async () => {
          b.setDisabled(true);
          try { await p.engine.resolveConflict(conflict.path, variant.id); await p.sync(true); this.conflicts = await p.engine.listConflicts(); await this.render(); }
          catch (error) { p.report(error); b.setDisabled(false); }
        }));
      }
      new Setting(el).setName('Объединить вручную').setDesc('Откройте оригинал и варианты, отредактируйте оригинал, затем сохраните его как объединённую версию.')
        .addButton(b => b.setButtonText('Открыть оригинал').onClick(() => void p.app.workspace.openLinkText(conflict.path, '', true)))
        .addButton(b => b.setButtonText('Сохранить объединение').onClick(async () => {
          b.setDisabled(true);
          try {
            const data = await p.engine.local.read(conflict.path);
            if (data === null) throw new Error('Оригинальная заметка удалена. Восстановите её или выберите версию удаления.');
            await p.engine.resolveConflict(conflict.path, 'manual', data); await p.sync(true);
            this.conflicts = await p.engine.listConflicts(); await this.render();
          } catch (error) { p.report(error); b.setDisabled(false); }
        }));
    }
  }
}

class TeamPluginsModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() { void this.render(); }
  async render() {
    const p = this.plugin, el = this.contentEl;
    el.empty(); el.addClass('amygdala-connection-team-plugins');
    el.createEl('h2', { text: 'Командные плагины' });
    if (p.connection?.kind !== 'team') { el.createEl('p', { text: 'Подключите командное хранилище.' }); return; }
    if (!p.app.vault.adapter.read || !p.app.vault.adapter.write || !p.app.vault.adapter.list) {
      el.createEl('p', { text: 'Чтение установленных плагинов недоступно в этой версии Obsidian.' }); return;
    }
    const status = el.createEl('p', { text: 'Загружаю список…' });
    const drive = p.drive();
    let catalog;
    try { catalog = validateCatalog(await drive.getTeamPluginCatalog()); }
    catch (error) { status.setText(error.message); return; }
    status.setText('Установленные плагины с этого устройства можно предложить команде. На других устройствах они только скачиваются после согласия и не включаются автоматически.');
    let pluginFolders = [];
    try {
      if (await p.app.vault.adapter.exists('.obsidian/plugins')) pluginFolders = (await p.app.vault.adapter.list('.obsidian/plugins')).folders || [];
    } catch { status.setText('Список предложений команды доступен, но перечень локальных плагинов прочитать не удалось.'); }
    const manifests = new Map();
    for (const folder of pluginFolders) {
      const folderPath = folder.startsWith('.obsidian/plugins/') ? folder : `.obsidian/plugins/${folder}`;
      const id = folderPath.split('/').at(-1);
      try {
        const manifest = JSON.parse(await p.app.vault.adapter.read(`${folderPath}/manifest.json`));
        if (manifest.id === id && typeof manifest.name === 'string' && typeof manifest.version === 'string'
          && typeof manifest.author === 'string' && typeof manifest.description === 'string') manifests.set(id, {
          id, name: manifest.name.slice(0, 120), version: manifest.version, author: manifest.author.slice(0, 120), description: manifest.description.slice(0, 500)
        });
      } catch { /* Ignore incomplete or invalid plugin folders. */ }
    }
    const proposed = new Set(catalog.map(item => item.id));
    for (const item of manifests.values()) {
      const setting = new Setting(el).setName(item.name).setDesc(`${item.id} · версия ${item.version} · ${item.author || 'автор не указан'}`);
      if (proposed.has(item.id)) {
        const current = catalog.find(value => value.id === item.id);
        if (current.proposedById === p.connection.actor?.actorId) setting.addButton(button => button.setButtonText('Убрать предложение').onClick(async () => {
          button.setDisabled(true);
          try { await this.publishCatalog(catalog.filter(value => value.id !== item.id)); await this.render(); }
          catch (error) { p.report(error); button.setDisabled(false); }
        }));
        if (current.version !== item.version) setting.addButton(button => button.setButtonText(`Предложить версию ${item.version}`).onClick(async () => {
          button.setDisabled(true);
          try { await this.publishCatalog(catalog.map(value => value.id === item.id ? item : value)); await this.render(); }
          catch (error) { p.report(error); button.setDisabled(false); }
        }));
      }
      else setting.addButton(button => button.setButtonText('Предложить команде').onClick(async () => {
        button.setDisabled(true);
        try { await this.publishCatalog([...catalog, item]); await this.render(); }
        catch (error) { p.report(error); button.setDisabled(false); }
      }));
    }
    if (!manifests.size) el.createEl('p', { text: 'На устройстве не найдено установленных community plugins.' });
    el.createEl('h3', { text: 'Предложения команды' });
    const acceptedValue = p.app.loadLocalStorage(`amygdala-connection-team-plugin-accepted-${p.connection.id}`);
    const declinedValue = p.app.loadLocalStorage(`amygdala-connection-team-plugin-declined-${p.connection.id}`);
    const accepted = new Set(Array.isArray(acceptedValue) ? acceptedValue : []);
    const declined = new Set(Array.isArray(declinedValue) ? declinedValue : []);
    for (const item of catalog) {
      const choiceKey = `${item.id}@${item.version}`;
      const installedPath = `.obsidian/plugins/${item.id}/manifest.json`;
      let installed = null;
      try { if (await p.app.vault.adapter.exists(installedPath)) installed = JSON.parse(await p.app.vault.adapter.read(installedPath)); } catch { /* Display invalid installs for manual recovery. */ }
      const isInstalled = Boolean(installed?.id === item.id);
      const needsUpdate = isInstalled && installed.version !== item.version;
      const state = isInstalled ? `Установлена версия ${installed.version}${needsUpdate ? '; предложена новая версия' : ''}.` : accepted.has(choiceKey) ? 'Вы приняли предложение; загрузку можно повторить.' : declined.has(choiceKey) ? 'Предложение отклонено на этом устройстве.' : 'Предлагается установить.';
      const setting = new Setting(el).setName(item.name).setDesc(`${item.description}\n${item.id} · версия ${item.version} · ${item.author} · предложил: ${item.proposedByName || 'участник'} · ${state}`);
      if (isInstalled && needsUpdate) {
        if (accepted.has(choiceKey)) setting.addButton(button => button.setButtonText('Обновить на эту версию').onClick(() => void this.install(item, button)));
        else if (declined.has(choiceKey)) setting.addButton(button => button.setButtonText('Принять обновление').onClick(() => {
          declined.delete(choiceKey); accepted.add(choiceKey); this.saveChoices(accepted, declined); void this.install(item, button);
        }));
        else setting.addButton(button => button.setButtonText('Обновить на эту версию').onClick(() => {
          accepted.add(choiceKey); declined.delete(choiceKey); this.saveChoices(accepted, declined); void this.install(item, button);
        })).addButton(button => button.setButtonText('Отказаться от обновления').onClick(() => {
          declined.add(choiceKey); accepted.delete(choiceKey); this.saveChoices(accepted, declined); void this.render();
        }));
        continue;
      }
      if (isInstalled) continue;
      if (accepted.has(choiceKey)) setting.addButton(button => button.setButtonText('Скачать ещё раз').onClick(() => void this.install(item, button)));
      else if (declined.has(choiceKey)) setting.addButton(button => button.setButtonText('Принять предложение').onClick(() => {
        declined.delete(choiceKey); accepted.add(choiceKey); this.saveChoices(accepted, declined); void this.install(item, button);
      }));
      else setting.addButton(button => button.setButtonText('Установить').setCta().onClick(() => {
        accepted.add(choiceKey); declined.delete(choiceKey); this.saveChoices(accepted, declined); void this.install(item, button);
      })).addButton(button => button.setButtonText('Отказаться').onClick(() => {
        declined.add(choiceKey); accepted.delete(choiceKey); this.saveChoices(accepted, declined); void this.render();
      }));
    }
    if (!catalog.length) el.createEl('p', { text: 'Пока никто не предложил командные плагины.' });
  }
  saveChoices(accepted, declined) {
    const key = `amygdala-connection-team-plugin-accepted-${this.plugin.connection.id}`;
    const declinedKey = `amygdala-connection-team-plugin-declined-${this.plugin.connection.id}`;
    this.plugin.app.saveLocalStorage(key, [...accepted]);
    this.plugin.app.saveLocalStorage(declinedKey, [...declined]);
  }
  async publishCatalog(plugins) {
    const p = this.plugin, clean = validateCatalog({ schema: 1, plugins });
    const before = validateCatalog(await p.drive().getTeamPluginCatalog());
    const oldById = new Map(before.map(item => [item.id, item]));
    const nextById = new Map(clean.map(item => [item.id, item]));
    for (const [id, item] of nextById) {
      const old = oldById.get(id);
      if (!old || old.version !== item.version || old.name !== item.name || old.author !== item.author || old.description !== item.description) {
        await p.drive().putTeamPluginChange('propose', item, p.connection.actor, p.device);
      }
    }
    for (const [id, item] of oldById) if (!nextById.has(id)) await p.drive().putTeamPluginChange('withdraw', item, p.connection.actor, p.device);
  }
  async install(item, button) {
    button.setDisabled(true);
    try {
      await this.plugin.installTeamPlugin(item);
      new Notice(`${item.name} скачан. Проверьте код перед включением в настройках Obsidian.`);
      await this.render();
    } catch (error) { this.plugin.report(error); button.setDisabled(false); }
  }
}

class PrivateNoteLinkModal extends Modal {
  constructor(plugin, id, editor = null) { super(plugin.app); this.plugin = plugin; this.id = id; this.editor = editor; }
  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: 'Личная заметка' });
    el.createEl('p', { text: 'Укажите имя отдельного личного Obsidian-хранилища и путь к заметке. Эти данные сохранятся только на этом устройстве; в командной заметке будет лишь случайный ID ссылки.' });
    let vault = '', file = '';
    new Setting(el).setName('Название личного хранилища').setDesc('Как оно называется в Obsidian').addText(input => input
      .setPlaceholder('Мои заметки').onChange(value => { vault = value.trim(); }));
    new Setting(el).setName('Путь к заметке').setDesc('Путь внутри личного хранилища, например Идеи/Тема.md').addText(input => input
      .setPlaceholder('Идеи/Тема.md').onChange(value => { file = value.trim(); }));
    new Setting(el).addButton(button => button.setButtonText(this.editor ? 'Добавить ссылку' : 'Сохранить связь').setCta().onClick(() => {
      if (!vault || !file || vault.length > 160 || file.length > 1024 || /[\u0000-\u001f\u007f]/u.test(vault + file)
        || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) {
        new Notice('Укажите название хранилища и корректный путь к заметке.'); return;
      }
      const links = this.plugin.privateLinks();
      links[this.id] = { vault, file };
      this.plugin.savePrivateLinks(links);
      if (this.editor) this.editor.replaceSelection(`[Личная заметка](obsidian://amygdala-connection-private-link?id=${this.id})`);
      this.close();
      new Notice(this.editor ? 'Личная ссылка добавлена. Её назначение хранится только на этом устройстве.' : 'Личная заметка привязана на этом устройстве.');
    }));
    new Setting(el).addButton(button => button.setButtonText('Отмена').onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = EasySync;
