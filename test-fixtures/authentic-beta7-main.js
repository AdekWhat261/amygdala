'use strict';
const modules = {
"auth.cjs": function(module, exports, load) {
'use strict';

function randomToken() {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Сервис входа не ответил вовремя.')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
class GoogleAuth {
  constructor({ bridge, request, secrets, savePending, getPending, email, mode = 'personal', teamFormat = 3 }) {
    if (!['personal', 'team'].includes(mode)) throw new Error('Некорректный режим входа.');
    if (![2, 3, 4].includes(teamFormat)) throw new Error('Некорректный формат командного входа.');
    this.bridge = bridge.replace(/\/$/, ''); this.request = request; this.secrets = secrets;
    this.savePending = savePending; this.getPending = getPending; this.email = email; this.personalEmail = mode === 'personal' ? email : null; this.mode = mode; this.teamFormat = teamFormat;
    this.token = null; this.expires = 0; this.refreshing = null;
  }
  async post(path, body) {
    if (!this.bridge) throw new Error('Сервис входа ещё не опубликован.');
    const url = new URL(this.bridge);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Сервис входа должен использовать HTTPS.');
    let r;
    try { r = await deadline(this.request({ url: this.bridge + path, method: 'POST',
      contentType: 'application/json', body: JSON.stringify(body), throw: false }), 30000); }
    catch { throw new Error('Не удалось связаться с сервисом входа.'); }
    if (r.status < 200 || r.status >= 300) throw new Error('Не удалось выполнить вход Google. Попробуйте снова.');
    return r.json;
  }
  async start({ pickTeamStore = false } = {}) {
    this.requireTeamPicker = this.mode === 'team' && Boolean(pickTeamStore);
    const verifier = randomToken(), state = randomToken();
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await this.savePending({ verifier, state, created: Date.now(), pickTeamStore: this.requireTeamPicker });
    const r = await this.post('/auth/start', { challenge, state, mode: this.mode,
      ...(this.mode === 'team' ? { teamFormat: this.teamFormat } : {}), pickTeamStore });
    const url = new URL(r.url || r.authorizeUrl || r.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Неожиданный адрес входа.');
    const loginHint = this.email || this.personalEmail;
    if (loginHint) url.searchParams.set('login_hint', loginHint);
    return url.toString();
  }
  async complete({ code, state, picked_file_ids: pickedFileIds, scope: callbackScope }) {
    const pending = await this.getPending();
    if (!pending || typeof state !== 'string' || state !== pending.state || !Number.isFinite(pending.created) || pending.created > Date.now() || Date.now() - pending.created > 10 * 60 * 1000) throw new Error('Ссылка входа устарела или относится к другому устройству.');
    const pickedSpreadsheetIds = typeof pickedFileIds === 'string' && pickedFileIds ? pickedFileIds.split(',') : [];
    if (pickedFileIds !== undefined && pickedFileIds !== '' && (this.mode !== 'team' || typeof pickedFileIds !== 'string'
      || pickedSpreadsheetIds.length > (this.teamFormat === 4 ? 9 : 1)
      || new Set(pickedSpreadsheetIds).size !== pickedSpreadsheetIds.length
      || pickedSpreadsheetIds.some(id => !/^[A-Za-z0-9_-]{8,128}$/.test(id)))) throw new Error('Google Picker вернул некорректные или повторяющиеся таблицы.');
    const r = await this.post('/auth/exchange', { code, verifier: pending.verifier, state });
    if (!r.access_token || !r.refresh_token) throw new Error('Google не предоставил постоянный доступ. Повторите вход с подтверждением доступа.');
    if (this.mode === 'team' && this.teamFormat >= 3) {
      const granted = typeof r.scope === 'string' ? r.scope.split(/\s+/) : typeof callbackScope === 'string' ? callbackScope.split(/\s+/) : [];
      if (!granted.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google не подтвердил доступ drive.file. Разрешение не сохранено; повторите подключение командной таблицы.');
      if (callbackScope && !callbackScope.split(/\s+/).includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google Picker завершился без разрешения drive.file. Повторите подключение командной таблицы.');
      if (!pickedSpreadsheetIds.length && (pending.pickTeamStore || this.requireTeamPicker)) throw new Error('Google Picker не вернул выбранную таблицу. Повторите подключение и выберите таблицу Amygdala.');
    }
    let email = null, name = '';
    if (this.mode === 'personal') {
      let me;
      try { me = await this.request({ url: 'https://openidconnect.googleapis.com/v1/userinfo',
        headers: { Authorization: `Bearer ${r.access_token}` }, throw: false }); }
      catch { throw new Error('Не удалось проверить аккаунт Google.'); }
      if (me.status !== 200 || me.json?.email_verified !== true || typeof me.json.email !== 'string') {
        throw new Error('Не удалось подтвердить аккаунт Google.');
      }
      email = me.json.email; name = typeof me.json.name === 'string' ? me.json.name : '';
    }
    await this.secrets.set(r.refresh_token);
    this.token = r.access_token; this.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
    await this.savePending(null);
    const pickedSpreadsheetId = pickedSpreadsheetIds[0] || null;
    return { email, name, pickedSpreadsheetId, pickedSpreadsheetIds };
  }
  async accessToken(forceRefresh = false) {
    if (forceRefresh) { this.token = null; this.expires = 0; }
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const refreshToken = await this.secrets.get();
      if (!refreshToken) throw new Error('Подключите Google Drive.');
      const r = await this.post('/auth/refresh', { refreshToken });
      if (!r.access_token) throw new Error('Google не выдал доступ. Повторите вход.');
      if (r.refresh_token) await this.secrets.set(r.refresh_token);
      this.token = r.access_token; this.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
      return this.token;
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async disconnect() { await this.secrets.set(''); this.token = null; this.expires = 0; await this.savePending(null); }
}
module.exports = { GoogleAuth, randomToken };

},
"drive.cjs": function(module, exports, load) {
'use strict';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN = /^[a-zA-Z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function bytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
async function sha256(value) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes(value))))
    .map(n => n.toString(16).padStart(2, '0')).join('');
}
function safeId(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Некорректный идентификатор хранилища.');
  return value;
}
function parseFolderLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Вставьте ссылку на папку Google Drive.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Ссылка на папку Google Drive выглядит некорректно.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !['usp', 'resourcekey'].includes(key)) || [...url.searchParams].some(([key, item]) => !item || item.length > 512)) throw new Error('Нужна обычная ссылка вида https://drive.google.com/drive/folders/…');
  const match = url.pathname.match(/^\/drive\/folders\/([a-zA-Z0-9_-]{8,128})\/?$/);
  if (!match) throw new Error('Нужна ссылка именно на папку Google Drive.');
  return safeId(match[1]);
}
function queryLiteral(value) { return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

class Drive {
  constructor({ request, getAccessToken, vaultId, folderId, mode = 'personal', progress = () => {}, requestTimeout = 120000 }) {
    if (!['personal', 'team'].includes(mode)) throw new Error('Некорректный режим хранилища.');
    this.request = request;
    this.getAccessToken = getAccessToken;
    this.vaultId = vaultId ? safeId(vaultId) : null;
    this.mode = mode;
    const selectedFolder = folderId || vaultId;
    this.folderId = mode === 'team' && selectedFolder ? safeId(selectedFolder) : null;
    this.vaultId = mode === 'team' ? this.folderId : this.vaultId;
    this.progress = progress;
    this.requestTimeout = requestTimeout;
    this.eventCache = new Map();
  }
  async call(url, { method = 'GET', body, contentType } = {}) {
    const token = await this.getAccessToken();
    let result;
    try { result = await deadline(this.request({ url, method, body, contentType,
      headers: { Authorization: `Bearer ${token}` }, throw: false }), this.requestTimeout,
      'Google Drive не ответил за две минуты. Изменения сохранены локально.'); }
    catch { throw new Error('Не удалось связаться с Google Drive. Изменения сохранены локально.'); }
    if (result.status < 200 || result.status >= 300) {
      const error = result.status === 401 ? new Error('Вход Google истёк. Подключите аккаунт снова.')
        : result.status === 403 ? new Error('Google запретил операцию. Проверьте доступ и свободное место.')
          : result.status === 429 ? new Error('Google просит подождать. Синхронизация повторится позже.')
            : new Error(`Google Drive недоступен (HTTP ${result.status}). Изменения сохранены локально.`);
      error.status = result.status;
      throw error;
    }
    return result;
  }
  async list(kind, extra = '') {
    const clauses = ["trashed = false", `appProperties has { key='easySync' and value='1' }`,
      `appProperties has { key='kind' and value='${queryLiteral(kind)}' }`];
    if (this.mode === 'team') clauses.push(`'${this.folderId}' in parents`);
    if (this.vaultId) clauses.push(`appProperties has { key='vault' and value='${this.vaultId}' }`);
    if (extra) clauses.push(extra);
    const files = [];
    let pageToken;
    const seen = new Set();
    do {
      const q = new URLSearchParams({ spaces: this.mode === 'team' ? 'drive' : 'appDataFolder', q: clauses.join(' and '),
        fields: 'nextPageToken,incompleteSearch,files(id,name,size,appProperties,parents)', pageSize: '1000' });
      if (this.mode === 'team') { q.set('supportsAllDrives', 'true'); q.set('includeItemsFromAllDrives', 'true'); }
      if (pageToken) q.set('pageToken', pageToken);
      const result = (await this.call(`${API}/files?${q}`)).json;
      if (!result || !Array.isArray(result.files) || result.incompleteSearch) throw new Error('Google вернул неполный список. Синхронизация остановлена.');
      for (const file of result.files) {
        if (!file || typeof file !== 'object') throw new Error('Некорректный список Google Drive.');
        safeId(file.id);
        if (this.mode === 'team' && (!Array.isArray(file.parents) || !file.parents.includes(this.folderId))) throw new Error('Google вернул файл вне выбранной папки. Синхронизация остановлена.');
      }
      if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !result.nextPageToken || result.nextPageToken.length > 8192)) throw new Error('Некорректная страница Google Drive.');
      files.push(...result.files);
      pageToken = result.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('Ошибка постраничного чтения Google Drive.');
      seen.add(pageToken);
    } while (pageToken);
    return files;
  }
  async create(kind, key, data, name) {
    const content = bytes(data);
    if (content.byteLength > 100 * 1024 * 1024) throw new Error('Файл больше 100 МБ: эта версия пока его не синхронизирует.');
    const props = { easySync: '1', kind, key };
    if (this.vaultId) props.vault = this.vaultId;
    const parents = this.mode === 'team' ? [this.folderId] : ['appDataFolder'];
    const boundary = `easy_sync_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
    const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents, appProperties: props })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + content.length + tail.length);
    body.set(head); body.set(content, head.length); body.set(tail, head.length + content.length);
    const response = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST', contentType: `multipart/related; boundary=${boundary}`, body: body.buffer
    });
    if (!response.json?.id) throw new Error('Google не подтвердил загрузку.');
    return safeId(response.json.id);
  }
  async raw(id) {
    safeId(id);
    const value = (await this.call(`${API}/files/${id}?alt=media`)).arrayBuffer;
    if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) throw new Error('Google вернул некорректное содержимое файла.');
    return bytes(value);
  }
  async listVaults() {
    const result = [];
    for (const file of await this.list('vault')) {
      const value = JSON.parse(decoder.decode(await this.raw(file.id)));
      safeId(value.id);
      if (typeof value.name !== 'string' || value.name.length > 200) throw new Error('Некорректное описание хранилища.');
      result.push(value);
    }
    return result;
  }
  async createVault(name) {
    const id = globalThis.crypto.randomUUID();
    const value = { id, name: String(name).trim().slice(0, 200) || 'Мои заметки', version: 1 };
    const previous = this.vaultId;
    this.vaultId = id;
    try { await this.create('vault', id, encoder.encode(JSON.stringify(value)), `Amygdala — ${value.name}`); }
    finally { this.vaultId = previous; }
    return value;
  }
  async createTeamVault(name) {
    if (this.mode !== 'team') throw new Error('Создайте командное хранилище в командном режиме.');
    const folderName = `Amygdala — ${String(name).trim().slice(0, 180) || 'Командные заметки'}`;
    const response = await this.call(`${API}/files?fields=id,name,webViewLink,mimeType,capabilities(canListChildren,canAddChildren)`, {
      method: 'POST', contentType: 'application/json', body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' })
    });
    const folder = response.json;
    this.folderId = this.vaultId = safeId(folder?.id);
    if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Google не создал папку командного хранилища.');
    const manifest = { id: this.folderId, name: folderName, version: 2, type: 'easy-sync-team' };
    await this.create('teamManifest', this.folderId, encoder.encode(JSON.stringify(manifest)), 'easy-sync-team.json');
    const info = await this.teamInfo();
    return { ...info, webViewLink: folder.webViewLink || `https://drive.google.com/drive/folders/${this.folderId}` };
  }
  async teamInfo() {
    if (this.mode !== 'team' || !this.folderId) throw new Error('Выберите папку командного хранилища.');
    let folder;
    try {
      folder = (await this.call(`${API}/files/${this.folderId}?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities(canListChildren,canAddChildren)`)).json;
    } catch (error) {
      if ([403, 404].includes(error.status)) throw new Error('Доступ к папке не подтверждён или был отозван. Проверьте общий доступ Google Drive.');
      throw error;
    }
    if (!folder || folder.id !== this.folderId || folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed || folder.capabilities?.canListChildren !== true || folder.capabilities?.canAddChildren !== true) {
      throw new Error('Для командного хранилища нужны права редактора на выбранную папку Google Drive.');
    }
    const manifests = await this.list('teamManifest');
    if (manifests.length !== 1) throw new Error('В папке нет корректного манифеста Easy Sync 0.2. Проверьте ссылку на хранилище.');
    let manifest;
    try { manifest = JSON.parse(decoder.decode(await this.raw(manifests[0].id))); } catch { throw new Error('Не удалось прочитать манифест командного хранилища.'); }
    if (manifest?.type !== 'easy-sync-team' || manifest.version !== 2 || manifest.id !== this.folderId || typeof manifest.name !== 'string') throw new Error('Формат папки не поддерживается Easy Sync.');
    return { id: this.folderId, name: manifest.name, version: 2, kind: 'team', folderName: folder.name };
  }
  async assertAccess() { if (this.mode === 'team') await this.teamInfo(); }
  async actorFor(email) {
    if (this.mode !== 'team' || !this.folderId) return null;
    await this.teamInfo();
    if (typeof email !== 'string' || !email.includes('@')) throw new Error('Повторно войдите в Google, чтобы определить участника команды.');
    let pageToken;
    const found = [];
    const seen = new Set();
    do {
      const query = new URLSearchParams({ fields: 'nextPageToken,permissions(id,type,emailAddress,displayName,role)', pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const result = (await this.call(`${API}/files/${this.folderId}/permissions?${query}`)).json;
      if (!Array.isArray(result?.permissions)) throw new Error('Google не вернул права участников папки.');
      found.push(...result.permissions);
      pageToken = result.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('Некорректная страница списка участников.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    const permission = found.find(item => item.type === 'user' && item.emailAddress?.toLowerCase() === email.toLowerCase());
    if (!permission || !['owner', 'writer', 'organizer', 'fileOrganizer'].includes(permission.role)) throw new Error('Доступ ещё не подтверждён владельцем или у вас нет прав редактора.');
    if (typeof permission.id !== 'string' || !permission.id || permission.id.length > 256) throw new Error('Google не вернул стабильный ID участника.');
    return { actorId: permission.id, actorName: typeof permission.displayName === 'string' && permission.displayName.trim() ? permission.displayName.trim().slice(0, 120) : 'Участник' };
  }
  async getTeamPluginCatalog() {
    if (this.mode !== 'team') throw new Error('Командные плагины доступны только в командном хранилище.');
    await this.teamInfo();
    const files = await this.list('teamPluginChange');
    if (files.length > 5000) throw new Error('История командных плагинов слишком велика для этой beta.');
    if (files.some(file => !Number.isFinite(Number(file.size)) || Number(file.size) < 0 || Number(file.size) > 64 * 1024)) throw new Error('В истории командных плагинов есть слишком большая или некорректная запись.');
    const changes = [];
    for (const file of files) {
      let value;
      try { value = JSON.parse(decoder.decode(await this.raw(file.id))); }
      catch { throw new Error('Запись командного плагина повреждена.'); }
      if (!value || value.schema !== 1 || value.type !== 'team-plugin-change' || !['propose', 'withdraw'].includes(value.action)
        || typeof value.changeId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.changeId)
        || typeof value.actorId !== 'string' || value.actorId.length > 256
        || typeof value.actorName !== 'string' || value.actorName.length > 120
        || typeof value.deviceId !== 'string' || value.deviceId.length > 128
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Формат записи командного плагина не поддерживается.');
      changes.push(value);
    }
    changes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || String(a.actorId).localeCompare(String(b.actorId))
      || String(a.deviceId).localeCompare(String(b.deviceId)) || a.changeId.localeCompare(b.changeId));
    const current = new Map();
    for (const change of changes) {
      if (change.action === 'withdraw') {
        if (current.get(change.plugin?.id)?.proposedById === change.actorId) current.delete(change.plugin?.id);
      } else current.set(change.plugin?.id, { ...change.plugin, proposedById: change.actorId, proposedByName: change.actorName });
    }
    return { schema: 1, updatedAt: changes.at(-1)?.createdAt || null, plugins: [...current.values()] };
  }
  async putTeamPluginChange(action, plugin, actor, deviceId) {
    if (this.mode !== 'team') throw new Error('Командные плагины доступны только в командном хранилище.');
    await this.teamInfo();
    if (!['propose', 'withdraw'].includes(action)) throw new Error('Некорректное действие с командным плагином.');
    const changeId = globalThis.crypto.randomUUID();
    const value = { schema: 1, type: 'team-plugin-change', changeId, action, plugin, actorId: actor?.actorId || 'unknown',
      actorName: actor?.actorName || 'Участник', deviceId: String(deviceId || 'unknown').slice(0, 128), createdAt: new Date().toISOString() };
    await this.create('teamPluginChange', changeId, encoder.encode(JSON.stringify(value)), `amygdala-team-plugin-${changeId}.json`);
  }
  async listEvents() {
    if (!this.vaultId) throw new Error('Хранилище не выбрано.');
    const result = [];
    // Fail closed if any committed revision cannot be read.
    const files = await this.list('event');
    let completed = 0;
    this.progress({ phase: 'history', completed, total: files.length });
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const index = next++;
        result[index] = await this.readEvent(files[index].id);
        completed += 1;
        this.progress({ phase: 'history', completed, total: files.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
    return result;
  }
  async readEvent(id) {
    safeId(id);
    if (!this.eventCache.has(id)) {
      let value;
      try { value = JSON.parse(decoder.decode(await this.raw(id))); }
      catch { throw new Error('Не удалось прочитать изменение из Google Drive.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректное изменение Google Drive.');
      this.eventCache.set(id, JSON.stringify(value));
    }
    return JSON.parse(this.eventCache.get(id));
  }
  async putEvent(event) {
    safeId(event.id);
    const key = `appProperties has { key='key' and value='${event.id}' }`;
    const existing = await this.list('event', key);
    const text = JSON.stringify(event);
    for (const file of existing) {
      if (canonical(await this.readEvent(file.id)) !== canonical(event)) throw new Error('Конфликт идентификатора изменения.');
    }
    if (!existing.length) {
      const id = await this.create('event', event.id, encoder.encode(text), `es-event-${event.id}`);
      this.eventCache.set(id, text);
    }
  }
  async putBlob(hash, data) {
    if (!HASH.test(hash) || await sha256(data) !== hash) throw new Error('Файл изменился перед загрузкой.');
    const existing = await this.list('blob', `appProperties has { key='key' and value='${hash}' }`);
    if (!existing.length) await this.create('blob', hash, data, `es-blob-${hash}`);
  }
  async getBlob(hash) {
    if (!HASH.test(hash)) throw new Error('Некорректная контрольная сумма.');
    const existing = await this.list('blob', `appProperties has { key='key' and value='${hash}' }`);
    if (!existing.length) throw new Error('В облаке отсутствует содержимое изменения. Локальные файлы не заменены.');
    const data = await this.raw(existing[0].id);
    if (await sha256(data) !== hash) throw new Error('Проверка загруженного файла не прошла.');
    return data;
  }
}
module.exports = { Drive, sha256, bytes, parseFolderLink };

},
"engine.cjs": function(module, exports, load) {
'use strict';
const { materialize, resolveHeads, planLocalRevisions, validateRevision } = load("journal.cjs");
const { planSync } = load("planner.cjs");

class SyncEngine {
  constructor({ remote, local, state, saveState, randomId, hash, actor = null, deviceId = null, progress = () => {} }) {
    Object.assign(this, { remote, local, state, saveState, randomId, hash, actor, deviceId, progress });
    this.state.baseline = Object.assign(Object.create(null),this.state.baseline || {});
    this.state.outbox ||= [];
    this.running = null;
  }
  sync() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async persist() { await this.saveState(this.state); }
  async flush(progress = {}) {
    const total = progress.total ?? this.state.outbox.length;
    let completed = progress.completed ?? 0;
    if (this.state.outbox.length) this.progress({ phase: 'upload', completed, total });
    if (this.state.outbox.length) await this.persist();
    while (this.state.outbox.length) {
      const batch = []; let queuedBytes = 0;
      for (const item of this.state.outbox) {
        const event = validateRevision(item.event);
        const bytes = event.hash === null ? null : Uint8Array.from(item.bytes || []);
        if (event.hash !== null && await this.hash(bytes) !== event.hash) throw new Error('Corrupt pending upload');
        if (batch.length && (batch.length >= 100 || queuedBytes + (bytes?.byteLength || 0) > 1024 * 1024)) break;
        batch.push({ event, bytes }); queuedBytes += bytes?.byteLength || 0;
        if (batch.length >= 100 || queuedBytes >= 1024 * 1024) break;
      }
      const blobs = batch.filter(item => item.event.hash !== null).map(item => ({ hash: item.event.hash, data: item.bytes }));
      if (this.remote.putBlobs) await this.remote.putBlobs(blobs);
      else for (const blob of blobs) await this.remote.putBlob(blob.hash, blob.data);
      const events = batch.map(item => item.event);
      if (this.remote.putEvents) await this.remote.putEvents(events);
      else for (const event of events) await this.remote.putEvent(event);
      // Acknowledge the whole batch only after every blob and event is durable.
      for (const { event } of batch) this.state.baseline[event.path] = { hash: event.hash, heads: [event.id] };
      this.state.outbox.splice(0, batch.length);
      await this.persist();
      completed += batch.length;
      this.progress({ phase: 'upload', completed, total });
    }
  }
  async checkedBlob(hash) {
    const bytes = await this.remote.getBlob(hash);
    if (!(bytes instanceof Uint8Array) || await this.hash(bytes) !== hash) throw new Error(`Blob integrity failure: ${hash}`);
    return bytes;
  }
  assertHistory(events) {
    const knownIds = new Set([...events, ...this.state.outbox.map(item => item.event)].map(event => event.id));
    for (const base of Object.values(this.state.baseline)) {
      if (!Array.isArray(base.heads) || base.heads.some(id => !knownIds.has(id)))
        throw new Error('Remote history missing previously synchronized revisions');
    }
  }
  async verify() {
    if (this.remote.beginPass) await this.remote.beginPass();
    else await this.remote.assertAccess?.();
    this.progress({ phase: 'listing' });
    const events = await this.remote.listEvents();
    const merged = materialize(events);
    const snapshot = await this.local.scan();
    const expected = new Map();
    const hashes = new Set();
    for (const [path, heads] of merged) {
      const { canonical, conflicts, hasConflict } = resolveHeads(heads);
      if (canonical) { expected.set(path, canonical.hash); hashes.add(canonical.hash); }
      if (hasConflict) for (const variant of [canonical, ...conflicts].filter(Boolean)) hashes.add(variant.hash);
    }
    if (expected.size !== Object.keys(snapshot).length) throw new Error('Количество локальных и облачных файлов различается. Повторите синхронизацию.');
    for (const [path, hash] of expected) if (snapshot[path] !== hash) throw new Error(`Облачная копия не совпадает: ${path}`);
    for (const [path, heads] of merged) {
      const resolution = resolveHeads(heads);
      if (resolution.hasConflict) for (const variant of [resolution.canonical, ...resolution.conflicts].filter(Boolean)) {
        const copy = await this.local.readConflict(path, variant.hash);
        if (!copy || await this.hash(copy) !== variant.hash) throw new Error(`Не найдена локальная версия конфликта: ${path}`);
      }
    }
    let completed = 0;
    this.progress({ phase: 'verify', completed, total: hashes.size });
    const queue = [...hashes];
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const index = next++;
        await this.checkedBlob(queue[index]);
        completed += 1;
        this.progress({ phase: 'verify', completed, total: hashes.size });
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return { files: expected.size, conflicts: [...merged.values()].filter(heads => resolveHeads(heads).hasConflict).length, blobs: hashes.size };
  }
  async run() {
    // A failed/incomplete listing cannot authorize local edits or deletion.
    if (this.remote.beginPass) await this.remote.beginPass();
    else await this.remote.assertAccess?.();
    this.progress({ phase: 'listing' });
    let events = await this.remote.listEvents();
    materialize([...events,...this.state.outbox.map(item=>item.event)]);
    this.assertHistory(events);
    await this.flush();
    events = await this.remote.listEvents();
    this.assertHistory(events);
    const remoteHeads = materialize(events);
    const snapshot = await this.local.scan();
    this.progress({ phase: 'planning', total: Object.keys(snapshot).length });
    const remotePaths = Object.fromEntries([...remoteHeads].filter(([,heads]) => heads.some(h => h.hash !== null)).map(([path]) => [path,'remote']));
    planSync({local:snapshot, remote:remotePaths});
    const drafts = planLocalRevisions({local:snapshot, baseline:this.state.baseline, remoteHeads});
    if (this.remote.preflightInitialUpload && events.length === 0 && this.state.outbox.length === 0 && Object.keys(this.state.baseline).length === 0) {
      const sizes = [], eventByteSizes = [], seen = new Set();
      for (const draft of drafts) {
        if (draft.hash === null) { eventByteSizes.push(0); continue; }
        const data = await this.local.read(draft.path);
        if (!data || await this.hash(data) !== draft.hash) throw new Error('Файл изменился во время проверки ёмкости v4.');
        eventByteSizes.push(data.byteLength);
        if (!seen.has(draft.hash)) { sizes.push(data.byteLength); seen.add(draft.hash); }
      }
      const candidates = drafts.map((draft, index) => validateRevision({ id: `preflight_${index}`, ...draft, ...this.revisionMetadata() }));
      await this.remote.preflightInitialUpload({ blobSizes: sizes, events: candidates, eventByteSizes });
    }
    const deferred = [];
    let uploaded = 0, queuedCount = 0, queuedBytes = 0;
    this.progress({ phase: 'upload', completed: uploaded, total: drafts.length });
    for (const draft of drafts) {
      let bytes = null;
      if (draft.hash !== null) {
        bytes = await this.local.read(draft.path);
        if (!bytes || await this.hash(bytes) !== draft.hash) { deferred.push(draft.path); continue; }
      }
      this.state.outbox.push({event:validateRevision({id:this.randomId(), ...draft, ...this.revisionMetadata()}), bytes:bytes === null ? null : bytes.slice()});
      // Bound the durable upload batch by both bytes and event count. This
      // keeps recovery safe while allowing append-oriented remotes to batch.
      queuedCount += 1; queuedBytes += bytes?.byteLength || 0;
      await this.persist();
      materialize([...events,...this.state.outbox.map(item=>item.event)]);
      // Legacy per-record stores keep the original one-file-at-a-time
      // durability and memory behavior. Append-oriented stores may batch.
      if (!this.remote.putEvents || queuedCount >= 100 || queuedBytes >= 1024 * 1024) {
        await this.flush({ completed: uploaded, total: drafts.length });
        uploaded += queuedCount; queuedCount = 0; queuedBytes = 0;
      }
    }
    if (queuedCount) { await this.flush({ completed: uploaded, total: drafts.length }); uploaded += queuedCount; }
    this.progress({ phase: 'reconciling' });
    events = await this.remote.listEvents();
    this.assertHistory(events);
    const merged = materialize(events);
    await this.remote.validateSnapshot?.(events);
    // Recheck team permissions after remote reads and before any local replacement or deletion.
    await this.remote.assertAccess?.();
    const destinations = Object.fromEntries(Object.keys(snapshot).map(path=>[path,'local']));
    for (const [path,heads] of merged) {
      const resolution = resolveHeads(heads);
      if (resolution.canonical) destinations[path] = 'remote';
      for (const conflict of resolution.conflicts) destinations[conflict.conflictPath] = 'conflict';
    }
    planSync({local:destinations});
    const applied = []; const conflicts = [];
    for (const [path,heads] of merged) {
      const resolution = resolveHeads(heads);
      const { canonical, conflicts:copies, heads:ids } = resolution;
      const expected = Object.hasOwn(snapshot,path) ? snapshot[path] : null;
      if (canonical && canonical.hash === expected && !resolution.hasConflict) {
        const current = await this.local.read(path);
        if (current === null || await this.hash(current) !== expected) {
          deferred.push(path);
          continue;
        }
        const base = this.state.baseline[path];
        if (!base || base.hash !== expected || JSON.stringify(base.heads) !== JSON.stringify(ids)) {
          this.state.baseline[path] = {hash:expected, heads:ids};
          await this.persist();
        }
        applied.push(path);
        continue;
      }
      // Fetch and validate all variants before touching this note.
      const hashes = [...new Set([canonical, ...copies].filter(Boolean).map(e=>e.hash))];
      const blobs = new Map();
      for (const hash of hashes) blobs.set(hash,await this.checkedBlob(hash));
      if (resolution.hasConflict) {
        for (const variant of [canonical, ...copies].filter(Boolean)) await this.local.writeConflict(path, variant.hash, blobs.get(variant.hash));
        conflicts.push(path);
      }
      let accepted;
      if (canonical) {
        accepted = await this.local.writeIfUnchanged(path, blobs.get(canonical.hash), expected);
      } else if (expected !== null) {
        // Only a previously tracked note can be removed. The adapter must
        // retain a recovery copy before deleting or replacing any local file.
        accepted = Object.hasOwn(this.state.baseline,path) && await this.local.removeIfUnchanged(path,expected);
      } else {
        accepted = await this.local.read(path) === null;
      }
      if (!accepted) { deferred.push(path); continue; }
      this.state.baseline[path] = {hash:canonical?.hash ?? null, heads:ids};
      await this.persist();
      applied.push(path);
    }
    return { applied, conflicts:[...new Set(conflicts)], deferred:[...new Set(deferred)] };
  }
  revisionMetadata() {
    if (!this.actor) return {};
    return { actorId: this.actor.actorId, actorName: this.actor.actorName, ...(this.deviceId ? { deviceId: this.deviceId } : {}), createdAt: new Date().toISOString() };
  }
  async listConflicts() {
    await this.remote.assertAccess?.();
    const events = await this.remote.listEvents();
    const merged = materialize(events), result = [];
    for (const [path, heads] of merged) {
      const resolution = resolveHeads(heads);
      if (!resolution.hasConflict) continue;
      const variants = [resolution.canonical, ...resolution.conflicts, ...resolution.tombstones].filter(Boolean);
      for (const variant of variants) if (variant.hash !== null) {
        const data = await this.checkedBlob(variant.hash);
        await this.local.writeConflict(path, variant.hash, data);
      }
      result.push({ path, variants: variants.map(variant => ({ id: variant.id, hash: variant.hash, deleted: variant.hash === null,
        actorId: variant.actorId || '', actorName: variant.actorName || (variant.actorId ? 'Участник' : 'Старое изменение'),
        deviceId: variant.deviceId || '', createdAt: variant.createdAt || '',
        copyPath: variant.hash === null ? null : this.local.conflictPath(path, variant.hash) })) });
    }
    return result;
  }
  async resolveConflict(path, variantId, manualBytes = null) {
    await this.remote.assertAccess?.();
    const events = await this.remote.listEvents();
    const headsByPath = materialize(events), heads = headsByPath.get(path);
    if (!heads) throw new Error('Эта заметка больше не содержит конфликта. Синхронизируйте и обновите список.');
    const resolution = resolveHeads(heads);
    if (!resolution.hasConflict) throw new Error('Конфликт уже разрешён. Синхронизируйте и обновите список.');
    let hash, data = null;
    if (variantId === 'manual') {
      if (!(manualBytes instanceof Uint8Array)) throw new Error('Не удалось прочитать итоговую заметку.');
      data = manualBytes.slice(); hash = await this.hash(data);
      await this.remote.putBlob(hash, data);
    } else {
      const variant = heads.find(head => head.id === variantId);
      if (!variant) throw new Error('Версия конфликта больше недоступна. Обновите список.');
      hash = variant.hash;
      if (hash !== null) data = await this.checkedBlob(hash);
    }
    const current = await this.local.read(path), currentHash = current === null ? null : await this.hash(current);
    if (hash === null) {
      if (!await this.local.removeIfUnchanged(path, currentHash)) throw new Error('Закройте или сохраните изменённую заметку и повторите разрешение конфликта.');
    } else if (!await this.local.writeIfUnchanged(path, data, currentHash)) {
      throw new Error('Заметка изменилась во время разрешения конфликта. Синхронизируйте и повторите.');
    }
    const event = validateRevision({ id: this.randomId(), path, hash, parents: [...resolution.heads].sort(), ...this.revisionMetadata() });
    this.state.outbox.push({ event, bytes: data });
    await this.flush();
    return event;
  }
}
module.exports = { SyncEngine };

},
"journal.cjs": function(module, exports, load) {
'use strict';
const { validatePath, isExcluded, planSync } = load("planner.cjs");
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
function validateRevision(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid revision');
  if (typeof event.id !== 'string' || !TOKEN.test(event.id)) throw new Error('Invalid revision id');
  validatePath(event.path);
  if (isExcluded(event.path)) throw new Error('Reserved revision path');
  if (event.hash !== null && (typeof event.hash !== 'string' || !/^[a-f0-9]{64}$/.test(event.hash))) throw new Error('Invalid revision hash');
  if (!Array.isArray(event.parents) || event.parents.some(id => typeof id !== 'string' || !TOKEN.test(id)) || new Set(event.parents).size !== event.parents.length) throw new Error('Invalid revision parents');
  const result = {id:event.id,path:event.path,hash:event.hash,parents:[...event.parents].sort()};
  if (event.actorId !== undefined) {
    if (typeof event.actorId !== 'string' || !/^[a-zA-Z0-9._@+-]{1,256}$/.test(event.actorId)) throw new Error('Invalid revision actor');
    result.actorId = event.actorId;
  }
  if (event.actorName !== undefined) {
    if (typeof event.actorName !== 'string' || !event.actorName.trim() || event.actorName.length > 120 || /[\u0000-\u001f\u007f]/.test(event.actorName)) throw new Error('Invalid revision actor name');
    result.actorName = event.actorName;
  }
  if (event.deviceId !== undefined) {
    if (typeof event.deviceId !== 'string' || !TOKEN.test(event.deviceId)) throw new Error('Invalid revision device');
    result.deviceId = event.deviceId;
  }
  if (event.createdAt !== undefined) {
    if (typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) || new Date(event.createdAt).toISOString() !== event.createdAt) throw new Error('Invalid revision timestamp');
    result.createdAt = event.createdAt;
  }
  return result;
}
function materialize(events) {
  if (!Array.isArray(events)) throw new Error('Events must be an array');
  const byId = new Map();
  for (const raw of events) {
    const event = validateRevision(raw);
    if (byId.has(event.id) && JSON.stringify(byId.get(event.id)) !== JSON.stringify(event)) throw new Error('Conflicting duplicate revision id');
    byId.set(event.id,event);
  }
  for (const event of byId.values()) for (const id of event.parents) {
    if (!byId.has(id)) throw new Error(`Missing parent: ${id}`);
    if (byId.get(id).path !== event.path) throw new Error('Parent path mismatch');
  }
  const visited = new Set(); const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Revision cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id).parents) visit(parent);
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const superseded = new Set([...byId.values()].flatMap(event => event.parents));
  const result = new Map();
  for (const event of byId.values()) if (!superseded.has(event.id)) {
    if (!result.has(event.path)) result.set(event.path,[]);
    result.get(event.path).push(event);
  }
  const active = Object.create(null);
  for (const [path,heads] of result) {
    heads.sort(compareHeads);
    if (heads.some(head => head.hash !== null)) active[path] = 'active';
  }
  planSync({local:active});
  return new Map([...result.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
}
function compareHeads(a,b) {
  const ak = `${a.hash === null ? '~' : a.hash}/${a.id}`;
  const bk = `${b.hash === null ? '~' : b.hash}/${b.id}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}
function conflictPath(path,hash) {
  validatePath(path);
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid conflict hash');
  const slash = path.lastIndexOf('/'); const dot = path.lastIndexOf('.');
  const split = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0,split)} (conflict ${hash.slice(0,12)})${path.slice(split)}`;
}
function resolveHeads(heads) {
  const sorted = heads.map(validateRevision).sort(compareHeads);
  if (new Set(sorted.map(head=>head.path)).size > 1) throw new Error('Mixed head paths');
  const distinct = new Map();
  for (const head of sorted) if (head.hash !== null && !distinct.has(head.hash)) distinct.set(head.hash,head);
  const live = [...distinct.values()];
  const tombstones = sorted.filter(head => head.hash === null);
  return { canonical:live[0] || null, conflicts:live.slice(1).map(head=>({ ...head, conflictPath:conflictPath(head.path,head.hash) })), tombstones,
    heads:sorted.map(head=>head.id), hasConflict:live.length > 1 || (live.length > 0 && tombstones.length > 0) };
}
function planLocalRevisions({local = {},baseline = {},remoteHeads = new Map()} = {}) {
  planSync({local});
  const drafts = [];
  for (const path of [...new Set([...Object.keys(local),...Object.keys(baseline)])].sort()) {
    validatePath(path);
    if (isExcluded(path)) continue;
    const localHash = Object.hasOwn(local,path) ? local[path] : null;
    const base = Object.hasOwn(baseline,path) ? baseline[path] : null;
    if (base) {
      if (!Array.isArray(base.heads) || base.heads.some(id=>typeof id !== 'string' || !TOKEN.test(id)) || new Set(base.heads).size !== base.heads.length) throw new Error('Invalid baseline heads');
      if (base.hash !== null && (typeof base.hash !== 'string' || !/^[a-f0-9]{64}$/.test(base.hash))) throw new Error('Invalid baseline hash');
      if (localHash === base.hash) continue;
      drafts.push({path,hash:localHash,parents:[...base.heads].sort()});
    } else if (localHash !== null) {
      const remote = resolveHeads(remoteHeads.get(path) || []);
      if (remote.canonical?.hash === localHash) continue;
      drafts.push({path,hash:localHash,parents:[]});
    }
  }
  for (const draft of drafts) validateRevision({id:'draft',...draft});
  return drafts;
}
module.exports = {validateRevision,materialize,conflictPath,resolveHeads,planLocalRevisions};

},
"local.cjs": function(module, exports, load) {
'use strict';
const { sha256, bytes } = load("drive.cjs");
const { validatePath, isExcluded, normalizeFolderPath, isWithinFolder } = load("planner.cjs");

class DeviceState {
  constructor(id) { this.id = id; this.connection = null; this.persistedOutboxIds = new Set(); }
  async db() {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(`easy-sync-${this.id}`, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
        if (!request.result.objectStoreNames.contains('outbox')) request.result.createObjectStore('outbox');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('Не удалось открыть локальный журнал синхронизации.'));
      request.onblocked = () => reject(new Error('Перезапустите Obsidian, чтобы обновить локальный журнал синхронизации.'));
    });
    return this.connection;
  }
  async load() {
    const db = await this.db();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => resolve(request.result || { baseline: {}, outbox: [] });
      request.onerror = () => reject(new Error('Не удалось прочитать локальный журнал.'));
    });
    // Version 1 kept every pending byte array in one growing record. Migrate it
    // once so acknowledging one file never rewrites all remaining attachments.
    if (Array.isArray(stored.outbox)) {
      const migrated = { baseline: stored.baseline || {}, outbox: stored.outbox };
      await this.save(migrated);
      return migrated;
    }
    const ids = Array.isArray(stored.outboxIds) ? stored.outboxIds : [];
    const outbox = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const store = tx.objectStore('outbox');
      const values = [];
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result === undefined) { tx.abort(); return; }
          values.push(request.result);
        };
      }
      tx.oncomplete = () => resolve(values);
      tx.onerror = tx.onabort = () => reject(new Error('Локальная очередь синхронизации повреждена.'));
    });
    this.persistedOutboxIds = new Set(ids);
    const byId = new Map(outbox.map(item => [item?.event?.id, item]));
    if (byId.size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('Локальная очередь синхронизации повреждена.');
    return { baseline: stored.baseline || {}, outbox: ids.map(id => byId.get(id)) };
  }
  async save(state) {
    const db = await this.db();
    const outbox = Array.isArray(state.outbox) ? state.outbox : [];
    const ids = outbox.map(item => item?.event?.id);
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Локальная очередь синхронизации повреждена.');
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'outbox'], 'readwrite');
      tx.objectStore('state').put({ baseline: state.baseline || {}, outboxIds: ids }, 'current');
      const pending = tx.objectStore('outbox');
      for (const item of outbox) if (!this.persistedOutboxIds.has(item.event.id)) pending.put(item, item.event.id);
      for (const id of this.persistedOutboxIds) if (!ids.includes(id)) pending.delete(id);
      tx.oncomplete = () => { this.persistedOutboxIds = new Set(ids); resolve(); };
      tx.onerror = tx.onabort = () => reject(new Error('Не удалось сохранить локальный журнал. Проверьте свободное место на устройстве.'));
    });
  }
  async close() { if (this.connection) (await this.connection).close(); }
}

class LocalVault {
  constructor(app, { scopePath = null } = {}) {
    this.app = app; this.vault = app.vault;
    this.scopePath = scopePath === null ? null : normalizeFolderPath(scopePath);
  }
  localPath(path) {
    validatePath(path);
    return this.scopePath ? `${this.scopePath}/${path}` : path;
  }
  async scan() {
    const hashes = Object.create(null);
    for (const file of this.vault.getFiles()) {
      if (isExcluded(file.path)) continue;
      validatePath(file.path);
      if (this.scopePath && !isWithinFolder(file.path, this.scopePath)) continue;
      const syncPath = this.scopePath ? file.path.slice(this.scopePath.length + 1) : file.path;
      if (!syncPath) continue;
      validatePath(syncPath);
      if (file.stat.size > 100 * 1024 * 1024) throw new Error(`Файл больше 100 МБ: ${file.path}. Эта версия пока его не поддерживает.`);
      const data = await this.read(syncPath);
      if (data !== null) hashes[syncPath] = await sha256(data);
    }
    return hashes;
  }
  async read(path) {
    const file = this.vault.getFileByPath(this.localPath(path));
    if (!file) return null;
    const data = bytes(await this.vault.readBinary(file));
    if (!this.scopePath) return data;
    if (file.extension === 'canvas' || file.path.toLowerCase().endsWith('.canvas')) return this.mapCanvas(data, 'remote', file.path);
    if (file.extension === 'md' || file.path.toLowerCase().endsWith('.md')) return this.mapMarkdown(data, 'remote', file.path);
    return data;
  }
  resolveLinkedFile(linkPath, sourcePath) {
    const resolved = this.app.metadataCache?.getFirstLinkpathDest?.(linkPath, sourcePath);
    if (resolved) return resolved;
    const candidates = [linkPath, ...(linkPath.includes('.') ? [] : [`${linkPath}.md`])];
    for (const candidate of candidates) {
      const file = this.vault.getAbstractFileByPath?.(candidate);
      if (file && typeof file.path === 'string' && !Array.isArray(file.children)) return file;
    }
    return null;
  }
  mapReferenceTarget(rawTarget, direction, sourcePath) {
    const match = /^([^#]*)(#.*)?$/u.exec(rawTarget);
    const linkPath = match?.[1] || '';
    const suffix = match?.[2] || '';
    if (!linkPath || /^(?:https?:|mailto:|obsidian:)/iu.test(linkPath)) return rawTarget;
    if (/^file:/iu.test(linkPath) || linkPath.startsWith('/') || linkPath.includes('\\') || /^[a-z]:/iu.test(linkPath)) {
      throw new Error('A linked path cannot be shared safely');
    }
    if (direction === 'local') {
      validatePath(linkPath);
      if (linkPath.includes('/')) return `${this.scopePath}/${linkPath}${suffix}`;
      for (const candidate of [linkPath, ...(linkPath.includes('.') ? [] : [`${linkPath}.md`])]) {
        const scoped = this.vault.getAbstractFileByPath?.(`${this.scopePath}/${candidate}`);
        if (scoped && typeof scoped.path === 'string' && !Array.isArray(scoped.children)) return `${scoped.path}${suffix}`;
      }
      const resolved = this.resolveLinkedFile(linkPath, sourcePath);
      if (resolved) {
        if (!isWithinFolder(resolved.path, this.scopePath)) throw new Error('A linked file is outside the selected team folder; remove or replace that link before syncing');
        return `${this.scopePath}/${resolved.path.slice(this.scopePath.length + 1)}${suffix}`;
      }
      return rawTarget;
    }
    const resolved = this.resolveLinkedFile(linkPath, sourcePath);
    if (direction === 'remote') {
      if (resolved) {
        if (!isWithinFolder(resolved.path, this.scopePath)) throw new Error('A linked file is outside the selected team folder; remove or replace that link before syncing');
        return `${resolved.path.slice(this.scopePath.length + 1)}${suffix}`;
      }
      if (isWithinFolder(linkPath, this.scopePath)) return `${linkPath.slice(this.scopePath.length + 1)}${suffix}`;
      if (linkPath.split('/').includes('..')) throw new Error('A linked path cannot be shared safely');
      if (linkPath.includes('/')) throw new Error('An unresolved path link cannot be shared safely; use a link to a file inside the selected team folder');
      return rawTarget;
    }
    throw new Error('Unknown team path mapping direction');
  }
  mapMarkdown(data, direction, sourcePath) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = decoder.decode(data);
    text = text.replace(/\[\[([^\]]+)\]\]/gu, (whole, inner) => {
      const split = inner.indexOf('|');
      const target = split < 0 ? inner : inner.slice(0, split);
      return `[[${this.mapReferenceTarget(target, direction, sourcePath)}${split < 0 ? '' : inner.slice(split)}]]`;
    });
    text = text.replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^\s)]+)([^)]*\))/gu, (whole, prefix, wrappedTarget, suffix) => {
      const wrapped = wrappedTarget.startsWith('<') && wrappedTarget.endsWith('>');
      const target = wrapped ? wrappedTarget.slice(1, -1) : wrappedTarget;
      const mapped = this.mapReferenceTarget(target, direction, sourcePath);
      return `${prefix}${wrapped ? `<${mapped}>` : mapped}${suffix}`;
    });
    return new TextEncoder().encode(text);
  }
  mapCanvas(data, direction, sourcePath) {
    let canvas;
    try { canvas = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { throw new Error('Canvas JSON is invalid; sync was stopped before sharing it'); }
    if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || (canvas.nodes !== undefined && !Array.isArray(canvas.nodes))) {
      throw new Error('Canvas structure is invalid; sync was stopped before sharing it');
    }
    const mapFile = path => {
      if (typeof path !== 'string') throw new Error('Canvas contains an invalid file reference');
      if (direction === 'remote') {
        if (!isWithinFolder(path, this.scopePath)) throw new Error('Canvas references a file outside the selected team folder; remove or replace it before syncing');
        return path.slice(this.scopePath.length + 1);
      }
      validatePath(path);
      if (isExcluded(path)) throw new Error('Canvas contains a reserved file reference');
      return `${this.scopePath}/${path}`;
    };
    for (const node of canvas.nodes || []) {
      if (node?.type === 'file') node.file = mapFile(node.file);
      else if (node?.type === 'group' && node.background) node.background = mapFile(node.background);
      else if (node?.type === 'text' && typeof node.text === 'string') {
        node.text = new TextDecoder().decode(this.mapMarkdown(new TextEncoder().encode(node.text), direction, sourcePath));
      } else if (node?.type === 'link' && /^file:/iu.test(node.url || '')) {
        throw new Error('Canvas contains a local file URL that cannot be shared safely');
      }
    }
    return new TextEncoder().encode(`${JSON.stringify(canvas, null, 2)}\n`);
  }
  conflictPath(path, hash) {
    validatePath(path);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Некорректная версия конфликта.');
    return `.easy-sync/conflicts/${hash}/${path}`;
  }
  async writeConflict(path, hash, data) {
    const target = this.conflictPath(path, hash), value = bytes(data);
    if (await this.vault.adapter.exists(target)) {
      const current = bytes(await this.vault.adapter.readBinary(target));
      if (await sha256(current) !== hash) throw new Error('Локальная копия конфликта занята другими данными.');
      return target;
    }
    await this.folders(target, true);
    await this.vault.adapter.writeBinary(target, value.slice().buffer);
    const saved = bytes(await this.vault.adapter.readBinary(target));
    if (await sha256(saved) !== hash) throw new Error('Не удалось проверить локальную копию конфликта.');
    return target;
  }
  async readConflict(path, hash) {
    const target = this.conflictPath(path, hash);
    if (!await this.vault.adapter.exists(target)) return null;
    const data = bytes(await this.vault.adapter.readBinary(target));
    if (await sha256(data) !== hash) throw new Error('Локальная копия конфликта повреждена.');
    return data;
  }
  async folders(path, hidden = false) {
    const parts = path.split('/').slice(0, -1);
    let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (await this.vault.adapter.exists(parent)) continue;
      try { if (hidden) await this.vault.adapter.mkdir(parent); else await this.vault.createFolder(parent); }
      catch (error) { if (!await this.vault.adapter.exists(parent)) throw error; }
    }
  }
  async backup(path, data) {
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    await this.vault.adapter.writeBinary(target, bytes(data).slice().buffer);
    if (await sha256(await this.vault.adapter.readBinary(target)) !== await sha256(data)) throw new Error('Не удалось проверить резервную копию.');
  }
  async writeIfUnchanged(path, data, expectedHash) {
    validatePath(path);
    if (isExcluded(path)) throw new Error('Запись в служебную папку запрещена.');
    const localPath = this.localPath(path);
    let file = this.vault.getFileByPath(localPath);
    const current = await this.read(path);
    if ((current === null ? null : await sha256(current)) !== expectedHash) return false;
    if (current !== null && await sha256(data) === expectedHash) return true;
    const rawCurrent = file ? bytes(await this.vault.readBinary(file)) : null;
    let localData = bytes(data);
    if (this.scopePath && (path.toLowerCase().endsWith('.canvas') || file?.extension === 'canvas')) localData = this.mapCanvas(data, 'local', localPath);
    else if (this.scopePath && (path.toLowerCase().endsWith('.md') || file?.extension === 'md')) localData = this.mapMarkdown(data, 'local', localPath);
    if (!file) {
      await this.folders(localPath);
      if (await this.vault.adapter.exists(localPath)) return false;
      try { await this.vault.createBinary(localPath, localData.slice().buffer); }
      catch (error) { if (this.vault.getFileByPath(localPath)) return false; throw error; }
      return true;
    }
    await this.backup(path, rawCurrent);
    if (file.extension === 'md') {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const oldText = decoder.decode(rawCurrent), newText = decoder.decode(localData);
      let changed = false;
      await this.vault.process(file, text => {
        if (text !== oldText) return text;
        changed = true;
        return newText;
      });
      return changed;
    }
    // A displayed binary may be edited by another plugin: defer replacement.
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    const recovery = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(recovery, true);
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    // Preserve the actual file, including an edit arriving after the hash check.
    await this.vault.rename(file, recovery);
    try { await this.vault.createBinary(localPath, localData.slice().buffer); }
    catch (error) {
      if (!await this.vault.adapter.exists(localPath)) await this.vault.rename(file, localPath);
      return false;
    }
    return true;
  }
  async removeIfUnchanged(path, expectedHash) {
    validatePath(path);
    const localPath = this.localPath(path);
    if (isExcluded(path) || this.app.workspace.getActiveFile()?.path === localPath) return false;
    const current = await this.read(path);
    if (current === null) return true;
    if (await sha256(current) !== expectedHash) return false;
    // Moving the actual current file into recovery retains late changes too.
    const file = this.vault.getFileByPath(localPath);
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    await this.vault.rename(file, target);
    return true;
  }
}
module.exports = { DeviceState, LocalVault };

},
"main.cjs": function(module, exports, load) {
'use strict';
const { Plugin, Modal, PluginSettingTab, Setting, Notice, MarkdownView, FuzzySuggestModal, requestUrl } = require('obsidian');
const { Drive, sha256, parseFolderLink } = load("drive.cjs");
const { TeamSheetStore } = load("team-sheet-store.cjs");
const { TeamShardedStore } = load("team-sharded-store.cjs");
const { sharedSheetsReadLimiter } = load("sheets-read-limiter.cjs");
const { GoogleAuth } = load("auth.cjs");
const { LocalVault, DeviceState } = load("local.cjs");
const { SyncEngine } = load("engine.cjs");
const { validateCatalog } = load("team-plugins.cjs");
const { normalizeFolderPath, isExcluded } = load("planner.cjs");
const config = ({
  "bridgeUrl": "https://easy-sync-login.igor-ryabkov.chatgpt.site",
  "beta": true,
  "verifyOnLoad": false
}
);
// Survives plugin unload/reload within the same application window.
const LOCKS = Symbol.for('amygdala-connection.active-passes');
if (!globalThis[LOCKS]) globalThis[LOCKS] = new Set();

class EasySync extends Plugin {
  async onload() {
    this.stopped = false;
    this.running = false;
    this.label = 'Не подключено';
    this.progress = null;
    this.activeProgress = null;
    this.progressListeners = new Set();
    this.diagnosticWrite = Promise.resolve();
    this.pluginData = await this.loadData?.() || {};
    this.sheetsLimiter = sharedSheetsReadLimiter({
      load: () => this.app.loadLocalStorage('amygdala-connection-v4-sheet-reads'),
      save: starts => this.app.saveLocalStorage('amygdala-connection-v4-sheet-reads', starts)
    });
    this.pluginData.v4Operations ||= {};
    this.lastDiagnosticAt = 0;
    this.device = this.loadLegacyCompatible('amygdala-connection-device', 'easy-sync-device') || globalThis.crypto.randomUUID();
    this.defaultNoteFolderPath = this.app.loadLocalStorage('amygdala-default-new-note-folder');
    if (this.defaultNoteFolderPath !== null && this.defaultNoteFolderPath !== undefined) {
      this.applyDefaultNoteFolder(this.defaultNoteFolderPath, { persist: false, notify: false });
    }
    this.app.saveLocalStorage('amygdala-connection-device', this.device);
    this.prefs = this.loadLegacyCompatible('amygdala-connection-preferences', 'easy-sync-preferences') || { auto: true };
    this.app.saveLocalStorage('amygdala-connection-preferences', this.prefs);
    this.connection = this.loadLegacyCompatible('amygdala-connection-connection', 'easy-sync-connection');
    this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
    this.accountEmails = { personal: this.loadLegacyCompatible('amygdala-connection-account-personal', 'easy-sync-account-personal') || (this.connection?.kind !== 'team' ? this.connection?.email : null),
      team: this.loadLegacyCompatible('amygdala-connection-account-team', 'easy-sync-account-team') || (this.connection?.kind === 'team' ? this.connection?.email : null) };
    const makeAuth = (mode, teamFormat = 3) => {
      const isTeam = mode === 'team', legacyTeam = isTeam && teamFormat === 2;
      const secret = isTeam ? legacyTeam ? `amygdala-connection-team-${this.device}` : teamFormat === 4 ? `amygdala-connection-team-v4-${this.device}` : `amygdala-connection-team-file-${this.device}` : `amygdala-connection-${this.device}`;
      const legacySecret = isTeam ? legacyTeam ? `easy-sync-team-${this.device}` : null : `easy-sync-${this.device}`;
      const pendingKey = isTeam ? `amygdala-pending-t${teamFormat}-${this.device}` : `${secret}-pending`;
      return new GoogleAuth({ bridge: config.bridgeUrl, email: this.accountEmails[isTeam ? 'team' : 'personal'], mode, teamFormat, request: requestUrl,
        secrets: { get: () => mode === 'team' ? this.app.secretStorage.getSecret(secret) : this.legacyCompatibleSecret(secret, legacySecret), set: value => this.app.secretStorage.setSecret(secret, value) },
        getPending: () => { const s = mode === 'team' ? this.app.secretStorage.getSecret(pendingKey) : this.legacyCompatibleSecret(pendingKey, `${legacySecret}-pending`); return s ? JSON.parse(s) : null; },
        savePending: p => this.app.secretStorage.setSecret(pendingKey, p ? JSON.stringify(p) : '') });
    };
    this.auth = makeAuth('personal');
    this.teamAuth = makeAuth('team');
    this.v4Auth = makeAuth('team', 4);
    this.legacyTeamAuth = makeAuth('team', 2);
    this.v4Selection = this.app.loadLocalStorage('amygdala-connection-v4-selection') || null;
    const completeLogin = params => {
      void (async () => {
        let failure;
        for (const mode of ['personal', 'team', 'team-v4', 'team-legacy']) {
          try {
            const identity = await this.authFor(mode).complete(params);
            const accountMode = mode === 'personal' ? 'personal' : 'team';
            if (identity.email) {
              this.accountEmails[accountMode] = identity.email;
              this.authFor(mode).email = identity.email;
              this.app.saveLocalStorage(`amygdala-connection-account-${accountMode}`, identity.email);
            }
            if (mode === 'team' && identity.pickedSpreadsheetId) this.pendingTeamSpreadsheetId = identity.pickedSpreadsheetId;
            if (mode === 'team-v4' && identity.pickedSpreadsheetIds.length) {
              await this.acceptV4Picked(identity.pickedSpreadsheetIds);
              new ConnectModal(this).open(); return;
            }
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
            this.setStatus(`Google подключён · ${accountMode === 'team' ? (mode === 'team-legacy' ? 'командный режим 0.2' : mode === 'team-v4' ? 'командный доступ v4' : 'командный доступ') : 'личный режим'}`);
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
    this.addRibbonIcon('folder-open', 'Set default folder for new notes', () => this.chooseDefaultNoteFolder());
    this.status = this.addStatusBarItem();
    this.status.addClass('easy-sync-status');
    this.status.addEventListener('click', () => new ConnectModal(this).open());
    this.addCommand({ id: 'connect', name: 'Подключить устройство', callback: () => new ConnectModal(this).open() });
    this.addCommand({ id: 'sync-now', name: 'Синхронизировать сейчас', callback: () => this.sync(true) });
    this.addCommand({ id: 'resolve-conflicts', name: 'Показать конфликты Amygdala', callback: () => this.openConflicts() });
    this.addCommand({ id: 'link-personal-note', name: 'Связать командную заметку с личной', callback: () => this.createPrivateLink() });
    this.addCommand({ id: 'rebind-personal-note-link', name: 'Переназначить личную ссылку', callback: () => this.rebindPrivateLink() });
    this.addCommand({ id: 'choose-default-new-note-folder', name: 'Amygdala: Choose default new-note folder', callback: () => this.chooseDefaultNoteFolder() });
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
  teamScopeKey(connection = this.connection) {
    return connection?.kind === 'team' && connection.id ? `amygdala-team-scope-${connection.id}` : null;
  }
  teamScopePath(connection = this.connection) {
    const key = this.teamScopeKey(connection);
    if (!key) return null;
    const value = this.app.loadLocalStorage(key);
    if (typeof value !== 'string') return null;
    try {
      const path = normalizeFolderPath(value);
      const folder = this.app.vault.getAbstractFileByPath(path);
      return Array.isArray(folder?.children) ? path : null;
    } catch { return null; }
  }
  async setTeamScopeFolder(path) {
    if (this.connection?.kind !== 'team') throw new Error('Connect a team project before choosing its local folder');
    if (this.running) throw new Error('Wait for the current sync to finish before changing the team folder');
    const normalized = normalizeFolderPath(path);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!Array.isArray(folder?.children)) throw new Error('Choose an existing folder inside this vault');
    this.app.saveLocalStorage(this.teamScopeKey(), normalized);
    this.engine = null;
    await this.stateStore?.close();
    this.stateStore = null;
    new Notice(`Team project mapped to ${normalized}. Only files under that folder are in team sync.`);
  }
  chooseTeamScopeFolder() {
    if (this.connection?.kind !== 'team') { new Notice('Connect a team project first.'); return; }
    new VaultFolderPicker(this.app, { includeRoot: false, onChoose: path => {
      void this.setTeamScopeFolder(path).catch(error => this.report(error));
    } }).open();
  }
  chooseDefaultNoteFolder() {
    new VaultFolderPicker(this.app, { includeRoot: true, onChoose: path => {
      this.applyDefaultNoteFolder(path, { persist: true, notify: true });
    } }).open();
  }
  applyDefaultNoteFolder(path, { persist = true, notify = true } = {}) {
    let normalized;
    try {
      normalized = path === '' ? '' : normalizeFolderPath(path);
      const folder = normalized ? this.app.vault.getAbstractFileByPath(normalized) : this.app.vault.getRoot();
      if (!Array.isArray(folder?.children)) throw new Error('Choose an existing folder inside this vault');
    } catch (error) {
      if (notify) new Notice(error.message || 'Choose a valid folder inside this vault.');
      return false;
    }
    const vault = this.app.vault;
    if (typeof vault.setConfig !== 'function') {
      if (notify) new Notice('This Obsidian version does not expose the folder-setting hook Amygdala needs. Set the default in Settings → Files & Links; core New note and Ctrl+N are unchanged.');
      return false;
    }
    try {
      vault.setConfig('newFileFolderPath', normalized || '/');
      vault.setConfig('newFileLocation', normalized ? 'folder' : 'root');
    } catch {
      if (notify) new Notice('Amygdala could not update the default-folder setting. Set it in Settings → Files & Links; core New note and Ctrl+N are unchanged.');
      return false;
    }
    this.defaultNoteFolderPath = normalized;
    if (persist) this.app.saveLocalStorage('amygdala-default-new-note-folder', normalized);
    if (notify) new Notice(`Default folder for core new notes set to ${normalized || 'vault root'}. Ctrl+N remains Obsidian’s command.`);
    return true;
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
    this.diagnosticWrite = this.diagnosticWrite.then(() => { this.pluginData.diagnostic = value; return this.saveData?.(this.pluginData); }).catch(() => {});
  }
  async persistPluginData(change) {
    this.diagnosticWrite = this.diagnosticWrite.catch(() => {}).then(async () => {
      if (!this.saveData) throw new Error('Локальное хранилище операций v4 недоступно.');
      change(this.pluginData);
      await this.saveData(this.pluginData);
    });
    return this.diagnosticWrite;
  }
  v4OperationJournal() {
    return {
      pending: opId => this.pluginData.v4Operations?.[opId] || null,
      pendingAll: () => Object.values(this.pluginData.v4Operations || {}),
      stage: record => this.persistPluginData(data => { data.v4Operations ||= {}; data.v4Operations[record.opId] = record; }),
      ack: opId => this.persistPluginData(data => { delete data.v4Operations?.[opId]; })
    };
  }
  async provisionV4(name) {
    const info = await TeamShardedStore.provision({ request: requestUrl, getAccessToken: () => this.v4Auth.accessToken(), limiter: this.sheetsLimiter,
      refreshAccessToken: () => this.v4Auth.accessToken(true), name,
      readIntent: () => this.pluginData.v4Bootstrap || null,
      writeIntent: value => this.persistPluginData(data => { data.v4Bootstrap = value; }) });
    info.actor = await this.drive(null, { mode: 'team', teamFormat: 4, rootId: info.rootId }).actorFor();
    await this.selectVault(info);
    return info;
  }
  setProgress(progress) {
    if (progress?.phase === 'backoff') {
      this.progress = { ...(this.activeProgress || { phase: 'starting' }), waitMs: progress.waitMs };
    } else {
      this.activeProgress = progress || null;
      this.progress = progress ? { ...progress, waitMs: 0 } : null;
    }
    const state = this.progress;
    const text = state?.phase === 'upload' ? `Загрузка ${state.completed} из ${state.total}`
      : state?.phase === 'blob-upload' ? `Загрузка вложений ${state.completed} из ${state.total}`
      : state?.phase === 'listing' ? 'Проверяю облако…'
      : state?.phase === 'history' ? `Читаю историю ${state.completed} из ${state.total}`
      : state?.phase === 'index' ? `Читаю вложения ${state.completed} из ${state.total}`
      : state?.phase === 'verify' ? `Проверяю файлы ${state.completed} из ${state.total}`
      : state?.phase === 'planning' ? `Готовлю ${state.total} файлов…`
      : state?.phase === 'reconciling' ? 'Сверяю изменения…' : 'Синхронизация…';
    this.setStatus(state?.waitMs > 0 ? `${text} · Google Sheets: ожидание ${Math.ceil(state.waitMs / 1000)} с` : text);
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
  authFor(mode) { return mode === 'team-legacy' ? this.legacyTeamAuth : mode === 'team-v4' ? this.v4Auth : mode === 'team' ? this.teamAuth : this.auth; }
  async acceptV4Picked(ids) {
    const previous = this.v4Selection;
    let selection = previous;
    if (!selection) {
      for (const candidate of ids) {
        const store = new TeamShardedStore({ request: requestUrl, getAccessToken: () => this.v4Auth.accessToken(), limiter: this.sheetsLimiter,
          progress: progress => this.setProgress(progress),
          refreshAccessToken: () => this.v4Auth.accessToken(true), rootId: candidate });
        let manifest;
        try { manifest = await store.manifestFor(candidate); } catch { continue; }
        if (manifest?.type === 'amygdala-team-sharded' && manifest.version === 4 && manifest.rootId === candidate
          && Array.isArray(manifest.shardIds) && manifest.shardIds.length === 8 && new Set(manifest.shardIds).size === 8) {
          selection = { rootId: candidate, expected: [candidate, ...manifest.shardIds], picked: [] }; break;
        }
      }
      if (!selection) throw new Error('Выберите корневую таблицу Amygdala v4 вместе с восемью таблицами данных.');
    }
    for (const id of ids) {
      if (!selection.expected.includes(id) || selection.picked.includes(id)) throw new Error('Выбрана повторная или посторонняя таблица v4.');
      selection.picked.push(id);
    }
    this.v4Selection = selection;
    this.app.saveLocalStorage('amygdala-connection-v4-selection', selection);
    if (selection.picked.length === 9) {
      const store = new TeamShardedStore({ request: requestUrl, getAccessToken: () => this.v4Auth.accessToken(), limiter: this.sheetsLimiter,
        progress: progress => this.setProgress(progress),
        refreshAccessToken: () => this.v4Auth.accessToken(true), rootId: selection.rootId });
      const team = await store.teamInfo();
      const exact = [team.rootId, ...team.shardIds];
      if (new Set(selection.picked).size !== 9 || selection.picked.some(id => !exact.includes(id)))
        throw new Error('Выбранные таблицы не совпадают с манифестом v4.');
      team.actor = await store.actorFor();
      this.v4Selection = null;
      this.app.saveLocalStorage('amygdala-connection-v4-selection', null);
      await this.selectVault(team);
    }
  }
  drive(connection = this.connection, override = {}) {
    const mode = override.mode || (connection?.kind === 'team' ? 'team' : 'personal');
    const legacyTeam = mode === 'team' && (override.teamFormat === 2 || (connection?.kind === 'team' && !connection?.folderId && !override.spreadsheetId));
    if (mode === 'team' && (override.teamFormat === 4 || connection?.version === 4))
      return new TeamShardedStore({ request: requestUrl, getAccessToken: () => this.v4Auth.accessToken(), limiter: this.sheetsLimiter,
        progress: progress => this.setProgress(progress),
        refreshAccessToken: () => this.v4Auth.accessToken(true),
        rootId: override.rootId || connection?.id || null, operationJournal: this.v4OperationJournal() });
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
    this.connection = { kind, id: vault.id, name: vault.name, email: vault.version === 4 ? '' : this.accountEmails[kind] || '', ...(kind === 'team' ? { version: vault.version || 3 } : {}),
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
    const teamScope = mode === 'team' ? this.teamScopePath() : null;
    if (mode === 'team' && !teamScope) {
      this.engine = null;
      this.setStatus('Choose a local folder for this team project before syncing');
      if (manual) new Notice('Choose the local folder for this team project in Amygdala settings. No team files were synced.');
      return;
    }
    const lock = `${mode}-${this.device}-${this.connection.id}`;
    if (globalThis[LOCKS].has(lock)) return;
    globalThis[LOCKS].add(lock);
    this.running = true;
    this.setProgress({ phase: 'starting' });
    try {
      if (!this.engine) {
        await this.stateStore?.close();
        const stateKey = mode === 'team' ? `team-${this.device}-${this.connection.id}-${encodeURIComponent(teamScope)}` : `${this.device}-${this.connection.id}`;
        this.stateStore = new DeviceState(stateKey);
        const state = await this.stateStore.load();
        const remote = this.drive(this.connection);
        const actor = mode === 'team' ? await remote.actorFor(this.accountEmails.team || this.connection.email) : null;
        if (mode === 'team' && JSON.stringify(actor) !== JSON.stringify(this.connection.actor || null)) {
          this.connection.actor = actor; this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
        }
        this.engine = new SyncEngine({ remote, local: new LocalVault(this.app, { scopePath: teamScope }),
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
      this.engine.remote.finishPass?.();
      if (manual) new Notice(this.label);
    } catch (error) {
      // Keep verified immutable slots after transient Google failures. Durable
      // state still reloads on other failures, including a failed local save.
      if (!this.engine || !error.sheetsTransient) this.engine = null;
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
    const mode = this.connection?.kind === 'team' ? (this.connection.version === 4 ? 'team-v4' : this.connection.folderId ? 'team' : 'team-legacy') : 'personal';
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
      el.createEl('p', { text: `${p.connection.kind === 'team' ? (teamLegacy ? 'Командное хранилище 0.2' : p.connection.version === 4 ? 'Командное хранилище v4' : 'Командное хранилище 0.3') : 'Личное хранилище 0.1'} · ${p.connection.version === 4 ? p.connection.actor?.actorName || 'Участник Google' : p.connection.email || 'Google не подключён'}` });
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
        if ((state.phase === 'upload' || state.phase === 'blob-upload' || state.phase === 'history' || state.phase === 'index' || state.phase === 'verify') && state.total > 0) {
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
    const v4Token = p.app.secretStorage.getSecret(`amygdala-connection-team-v4-${p.device}`);
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
    el.createEl('h3', { text: 'Командное хранилище v4' });
      el.createEl('p', { text: 'Одна корневая и восемь таблиц данных в общей папке. Каждый участник явно выбирает все девять таблиц в Google Picker. Для загрузок используется не более 75% слотов данных и 50% слотов коммитов.' });
    if (!v4Token) new Setting(el).setName('Вход для v4')
      .addButton(b => b.setButtonText('Войти в Google').onClick(() => this.beginLogin('team-v4')));
    else {
      let v4Name = p.pluginData.v4Bootstrap?.name || 'Командный цеттелькастен';
      new Setting(el).setName('Создать хранилище v4').addText(t => t.setValue(v4Name).onChange(value => { v4Name = value; }))
        .addButton(b => b.setButtonText('Создать').onClick(async () => {
          b.setDisabled(true);
          try { await p.provisionV4(v4Name); await this.render(); }
          catch (error) { p.report(error); b.setDisabled(false); }
        }));
      const selected = p.v4Selection?.picked?.length || 0;
      const connectV4 = new Setting(el).setName(`Подключить v4: выбрано ${selected} из 9`)
        .setDesc(selected === 9 ? 'Все таблицы выбраны. Повторите проверку доступа.'
          : selected ? 'Выберите оставшиеся таблицы той же папки. Повторный и посторонний ID отклоняются.'
            : 'Выберите корневую и восемь таблиц данных за один раз в Google Picker.');
      if (selected === 9) connectV4.addButton(b => b.setButtonText('Проверить доступ').onClick(async () => {
        b.setDisabled(true); try { await p.acceptV4Picked([]); await this.render(); } catch (error) { p.report(error); b.setDisabled(false); }
      }));
      else connectV4.addButton(b => b.setButtonText('Выбрать таблицы').onClick(() => this.beginLogin('team-v4', { pickTeamStore: true })));
      if (selected) connectV4.addButton(b => b.setButtonText('Начать выбор заново').onClick(async () => {
        p.v4Selection = null; p.app.saveLocalStorage('amygdala-connection-v4-selection', null); await this.render();
      }));
      if (p.pluginData.v4Bootstrap) new Setting(el).setName('Незавершённое создание v4')
        .setDesc('Если результат создания Google неизвестен, проверьте папку в Drive. Сброс удалит только локальную запись; облачные файлы останутся.')
        .addButton(b => b.setButtonText('Сбросить локальную запись').onClick(async () => {
          b.setDisabled(true);
          try { await p.persistPluginData(data => { data.v4Bootstrap = null; }); await this.render(); }
          catch (error) { p.report(error); b.setDisabled(false); }
        }));
    }
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

class VaultFolderPicker extends FuzzySuggestModal {
  constructor(app, { includeRoot, onChoose }) {
    super(app);
    this.app = app; this.includeRoot = includeRoot; this.onChoose = onChoose;
  }
  getItems() {
    const folders = this.app.vault.getAllLoadedFiles().filter(item => Array.isArray(item.children)
      && (item.path === '' || !isExcluded(item.path)) && (this.includeRoot || item.path !== ''));
    if (this.includeRoot && !folders.some(folder => folder.path === '')) folders.unshift(this.app.vault.getRoot());
    return folders.sort((left, right) => left.path.localeCompare(right.path));
  }
  getItemText(folder) { return folder.path || 'Vault root'; }
  onChooseItem(folder) { this.onChoose(folder.path || ''); }
}

class SyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl, p = this.plugin; el.empty();
    el.createEl('h2', { text: 'Amygdala' });
    el.createEl('p', { text: p.label });
    new Setting(el).setName('Default folder for new notes')
      .setDesc('Changes Obsidian’s built-in new-note folder. Ctrl+N stays Obsidian’s command. This uses an undocumented Obsidian hook; if unsupported, set it in Files & Links.')
      .addButton(b => b.setButtonText(p.defaultNoteFolderPath || 'Choose folder').onClick(() => p.chooseDefaultNoteFolder()));
    if (p.connection?.kind === 'team') new Setting(el).setName('Local folder for this team project')
      .setDesc(p.teamScopePath() || 'Choose an existing folder in this vault. Only its contents sync; linked notes outside it remain private.')
      .addButton(b => b.setButtonText('Choose folder').onClick(() => p.chooseTeamScopeFolder()));
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
        if (current.version !== item.version && (p.connection.version !== 4 || current.proposedById === p.connection.actor?.actorId)) setting.addButton(button => button.setButtonText(`Предложить версию ${item.version}`).onClick(async () => {
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

},
"planner.cjs": function(module, exports, load) {
'use strict';

const EXCLUDED = new Set(['.obsidian', '.trash', '.git', '.easy-sync']);
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
// Conservative Unicode folding also catches sharp-s and final-sigma aliases.
const portableKey = path => path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

function validatePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) {
    throw new Error(`Invalid portable path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part) || /[. ]$/u.test(part) || RESERVED.test(part)) {
      throw new Error(`Invalid portable path: ${JSON.stringify(path)}`);
    }
  }
  return path;
}

function normalizeFolderPath(path) {
  if (typeof path !== 'string') throw new TypeError('Folder path must be a string');
  const normalized = path.normalize('NFC').replace(/\/+$/u, '');
  if (!normalized) throw new Error('Choose a specific folder inside the vault');
  validatePath(normalized);
  if (isExcluded(normalized)) throw new Error('This folder is reserved for Obsidian or Amygdala');
  return normalized;
}

function isWithinFolder(path, folderPath) {
  validatePath(path);
  const folder = normalizeFolderPath(folderPath);
  return path.startsWith(`${folder}/`);
}

function isExcluded(path) {
  return path.split('/').some(part => EXCLUDED.has(part.toLowerCase()));
}

function entries(value, name) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain path-to-hash object`);
  }
  return Object.entries(value).map(([path, hash]) => {
    validatePath(path);
    if (typeof hash !== 'string' || hash.length === 0) throw new TypeError(`Invalid hash for ${path}`);
    return [path, hash];
  }).filter(([path]) => !isExcluded(path));
}

function planSync({ local, remote, baseline } = {}) {
  const maps = [new Map(entries(local, 'local')), new Map(entries(remote, 'remote')), new Map(entries(baseline, 'baseline'))];
  const [l, r, b] = maps;
  const paths = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
  const canonical = new Map();
  for (const path of paths) {
    const key = portableKey(path);
    if (canonical.has(key) && canonical.get(key) !== path) throw new Error(`Path collision: ${canonical.get(key)} and ${path}`);
    canonical.set(key, path);
  }
  // A file cannot coexist with a directory of the same portable name.
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = portableKey(parts.slice(0, i).join('/'));
      if (canonical.has(prefix)) throw new Error(`File/directory collision: ${canonical.get(prefix)} and ${path}`);
    }
  }
  const operations = [];
  const unchanged = [];
  for (const path of paths) {
    const localHash = l.get(path) ?? null;
    const remoteHash = r.get(path) ?? null;
    const baselineHash = b.get(path) ?? null;
    if (localHash === remoteHash) { unchanged.push(path); continue; }
    let kind;
    let reason;
    if (baselineHash === null) {
      if (localHash === null) kind = 'download';
      else if (remoteHash === null) kind = 'upload';
      else { kind = 'conflict'; reason = 'first-merge'; }
    } else if (localHash === baselineHash) {
      kind = remoteHash === null ? 'delete-local' : 'download';
    } else if (remoteHash === baselineHash) {
      kind = localHash === null ? 'delete-remote' : 'upload';
    } else {
      kind = 'conflict';
      reason = localHash === null || remoteHash === null ? 'edit-delete' : 'both-modified';
    }
    operations.push({ path, kind, localHash, remoteHash, baselineHash, ...(reason ? { reason } : {}) });
  }
  return { operations, unchanged };
}

module.exports = { planSync, validatePath, isExcluded, normalizeFolderPath, isWithinFolder };

},
"sheets-read-limiter.cjs": function(module, exports, load) {
'use strict';

// One limiter per Obsidian process. The persisted timestamps cover a full app restart.
const KEY = Symbol.for('amygdala-connection.sheets-v4-read-limiter');
const WINDOW_MS = 60000;
const MIN_GAP_MS = 1200; // At most 50 reads/minute, with headroom below Google's 60.
const MAX_READS = 50;

class SheetsReadLimiter {
  constructor({ clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    load = () => [], save = () => {}, onWait = () => {} } = {}) {
    Object.assign(this, { clock, sleep, save, onWait });
    const now = clock();
    const stored = load();
    const starts = Array.isArray(stored) ? stored : stored?.starts;
    this.starts = Array.isArray(starts) ? starts.filter(t => Number.isFinite(t) && t > now - WINDOW_MS).sort((a, b) => a - b) : [];
    this.tail = Promise.resolve();
    this.cooldownUntil = Number.isFinite(stored?.cooldownUntil) ? stored.cooldownUntil : 0;
  }
  persist() { this.save({ starts: [...this.starts], cooldownUntil: this.cooldownUntil }); }
  acquire(onWait = this.onWait) {
    const turn = this.tail.catch(() => {}).then(async () => {
      while (true) {
        const now = this.clock();
        this.starts = this.starts.filter(t => t > now - WINDOW_MS);
        const earliest = Math.max(now, this.cooldownUntil,
          (this.starts.at(-1) ?? -Infinity) + MIN_GAP_MS,
          this.starts.length >= MAX_READS ? this.starts[this.starts.length - MAX_READS] + WINDOW_MS : 0);
        if (earliest > now) {
          onWait(earliest - now);
          await this.sleep(earliest - now);
          continue;
        }
        // Persist before dispatch: a crash may cost one unused ticket, never an extra read.
        this.starts.push(now);
        this.persist();
        return;
      }
    });
    this.tail = turn;
    return turn;
  }
  defer(ms) {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + ms);
    this.persist();
  }
}

function sharedSheetsReadLimiter(options) {
  if (!globalThis[KEY]) globalThis[KEY] = new SheetsReadLimiter(options);
  return globalThis[KEY];
}

module.exports = { SheetsReadLimiter, sharedSheetsReadLimiter };

},
"team-plugins.cjs": function(module, exports, load) {
'use strict';

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX = 200;

function validateCatalog(value) {
  if (!value || typeof value !== 'object' || value.schema !== 1 || !Array.isArray(value.plugins) || value.plugins.length > MAX) {
    throw new Error('Некорректный каталог командных плагинов.');
  }
  const seen = new Set();
  return value.plugins.map(plugin => {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string' || !ID.test(plugin.id)
      || typeof plugin.version !== 'string' || !VERSION.test(plugin.version)
      || typeof plugin.name !== 'string' || !plugin.name.trim() || plugin.name.length > 120
      || typeof plugin.author !== 'string' || plugin.author.length > 120
      || typeof plugin.description !== 'string' || plugin.description.length > 500) {
      throw new Error('В каталоге есть плагин с некорректными данными.');
    }
    if (plugin.id === 'amygdala-connection' || seen.has(plugin.id)) throw new Error('Каталог содержит повторяющийся или служебный плагин.');
    seen.add(plugin.id);
    const clean = { id: plugin.id, version: plugin.version, name: plugin.name.trim(), author: plugin.author.trim(), description: plugin.description.trim() };
    if (plugin.proposedById !== undefined && (typeof plugin.proposedById !== 'string' || plugin.proposedById.length > 256)) throw new Error('Некорректный автор предложения плагина.');
    if (plugin.proposedByName !== undefined && (typeof plugin.proposedByName !== 'string' || plugin.proposedByName.length > 120)) throw new Error('Некорректное имя автора предложения.');
    if (plugin.proposedById) clean.proposedById = plugin.proposedById;
    if (plugin.proposedByName) clean.proposedByName = plugin.proposedByName;
    return clean;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { validateCatalog };

},
"team-sharded-store.cjs": function(module, exports, load) {
'use strict';

const { sha256 } = load("drive.cjs");
const { validateRevision } = load("journal.cjs");
const { sharedSheetsReadLimiter } = load("sheets-read-limiter.cjs");
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MIME = 'application/vnd.google-apps.spreadsheet';
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PARAMS = Object.freeze({ shards: 8, dataSlots: 256, dataChunks: 16, chunkBytes: 32768,
  commitSlots: 2048, commitBlocks: 4, commitBlockBytes: 16384, maxEventsPerCommit: 100,
  maxDataClaims: 1536, maxCommitClaims: 1536, shardDataClaims: 192 });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const { validateCatalog } = load("team-plugins.cjs");
const PLUGIN_ROWS = 5000;
const clone = value => JSON.parse(JSON.stringify(value));
const b64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32766) binary += String.fromCharCode(...bytes.subarray(i, i + 32766));
  return btoa(binary);
};
const unb64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const sameBytes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const marker = (kind, slot) => `AS4_${kind}_${String(slot).padStart(3, '0')}`;
const encoded = value => encodeURIComponent(value);
const transientStatus = status => status === 429 || (status >= 500 && status < 600);
function retryAfterMs(response, now = Date.now()) {
  const headers = response?.headers;
  const value = typeof headers?.get === 'function' ? headers.get('Retry-After')
    : headers && Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const raw = Array.isArray(value) ? value[0] : value;
  if ((typeof raw === 'string' && raw.trim()) || typeof raw === 'number') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(raw));
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return null;
}
function retryDelay(response, retries) { return retryAfterMs(response) ?? Math.min(60000, 2000 * 2 ** retries); }

function validId(value) { if (typeof value !== 'string' || !ID.test(value)) throw new Error('Некорректный ID таблицы v4.'); return value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digest(value) { return sha256(encoder.encode(canonical(value))); }
function assertManifest(root, shards, rootId) {
  if (!root || root.type !== 'amygdala-team-sharded' || root.version !== 4 || root.schema !== 2 || root.rootId !== rootId
    || !ID.test(root.vaultId || '') || !ID.test(root.folderId || '') || !Array.isArray(root.shardIds)
    || root.shardIds.length !== 8 || new Set(root.shardIds).size !== 8 || root.shardIds.some(id => !ID.test(id) || id === rootId)
    || canonical(root.params) !== canonical(PARAMS) || !HASH.test(root.paramsDigest || '') || shards.length !== 8) {
    throw new Error('Манифест корневой таблицы v4 повреждён.');
  }
  for (let i = 0; i < 8; i++) {
    const shard = shards[i];
    if (!shard || shard.type !== 'amygdala-team-sharded' || shard.version !== 4 || shard.schema !== 2
      || shard.vaultId !== root.vaultId || shard.rootId !== rootId || shard.folderId !== root.folderId
      || shard.shardId !== root.shardIds[i] || shard.index !== i || shard.paramsDigest !== root.paramsDigest) {
      throw new Error(`Манифест сегмента ${i + 1} не соответствует корню v4.`);
    }
  }
}

/** v4 stores immutable payloads in fixed slots and publishes only confirmed root commits. */
class TeamShardedStore {
  static async provision({ request, getAccessToken, refreshAccessToken = null, limiter = sharedSheetsReadLimiter(), readIntent, writeIntent, name }) {
    if (typeof readIntent !== 'function' || typeof writeIntent !== 'function') throw new Error('Для создания v4 нужен устойчивый локальный журнал.');
    const cleanName = String(name || '').trim().slice(0, 160) || 'Командные заметки';
    let intent = await readIntent();
    if (intent?.creating) throw new Error('Предыдущий запрос создания v4 имеет неизвестный результат. Создание остановлено во избежание дубликата.');
    if (intent && (intent.schema !== 1 || intent.name !== cleanName || !ID.test(intent.vaultId || '')))
      throw new Error('Сохранённая операция создания v4 относится к другому хранилищу.');
    intent ||= { schema: 1, name: cleanName, vaultId: globalThis.crypto.randomUUID(), folderId: null,
      shardIds: Array(8).fill(null), rootId: null, creating: null };
    await writeIntent(intent);
    const temporary = new TeamShardedStore({ request, getAccessToken, refreshAccessToken, limiter, rootId: intent.rootId || 'temporary_12345678' });
    const create = async (step, url, body) => {
      intent.creating = step; await writeIntent(intent);
      const result = await temporary.call(url, { method: 'POST', body });
      return result;
    };
    if (!intent.folderId) {
      const folder = await create('folder', `${DRIVE}/files?fields=id,mimeType`, { name: `Amygdala — ${cleanName}`, mimeType: 'application/vnd.google-apps.folder' });
      intent.folderId = validId(folder.id);
      if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('Google не создал папку v4.');
      intent.creating = null; await writeIntent(intent);
    }
    for (let index = 0; index < 9; index++) {
      const isRoot = index === 8;
      if (isRoot ? intent.rootId : intent.shardIds[index]) continue;
      const result = await create(isRoot ? 'root' : `shard-${index}`, SHEETS, {
        properties: { title: `Amygdala — ${cleanName} — ${isRoot ? 'Control' : `Data ${index + 1}`}` },
        sheets: [{ properties: { sheetId: 1, title: 'Meta', gridProperties: { rowCount: 100, columnCount: 2 } } },
          { properties: { sheetId: 2, title: 'Payload', gridProperties: { rowCount: 1 + (isRoot ? PARAMS.commitSlots * PARAMS.commitBlocks : PARAMS.dataSlots * PARAMS.dataChunks), columnCount: 2 } } },
          ...(isRoot ? [{ properties: { sheetId: 3, title: 'TeamPlugins', gridProperties: { rowCount: PLUGIN_ROWS + 1, columnCount: 3 } } }] : [])]
      });
      const id = validId(result.spreadsheetId);
      if (isRoot) intent.rootId = id; else intent.shardIds[index] = id;
      intent.creating = null; await writeIntent(intent);
    }
    const ids = [intent.rootId, ...intent.shardIds];
    if (new Set(ids).size !== 9) throw new Error('Google вернул повторяющийся ID таблицы v4.');
    const paramsDigest = await digest(PARAMS);
    for (const id of [...intent.shardIds, intent.rootId]) {
      const file = await temporary.file(id);
      if (!Array.isArray(file.parents)) throw new Error('Google не указал папку таблицы v4.');
      if (file.parents.length !== 1 || file.parents[0] !== intent.folderId) {
        const query = new URLSearchParams({ addParents: intent.folderId, fields: 'id,parents' });
        if (file.parents.length) query.set('removeParents', file.parents.join(','));
        await temporary.call(`${DRIVE}/files/${id}?${query}`, { method: 'PATCH', body: {} });
      }
      const index = intent.shardIds.indexOf(id);
      const manifest = index < 0
        ? { schema: 2, type: 'amygdala-team-sharded', version: 4, name: cleanName, vaultId: intent.vaultId,
          rootId: intent.rootId, folderId: intent.folderId, shardIds: [...intent.shardIds], params: PARAMS, paramsDigest }
        : { schema: 2, type: 'amygdala-team-sharded', version: 4, vaultId: intent.vaultId, rootId: intent.rootId,
          folderId: intent.folderId, shardId: id, index, paramsDigest };
      await temporary.call(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data: [
        { range: 'Meta!A1:B2', values: [['key', 'value'], ['manifest', JSON.stringify(manifest)]] },
        ...(index < 0 ? [{ range: 'TeamPlugins!A1:C1', values: [['changeId', 'createdAt', 'change']] }] : [])
      ] } });
    }
    const store = new TeamShardedStore({ request, getAccessToken, refreshAccessToken, limiter, rootId: intent.rootId });
    const info = await store.teamInfo();
    await writeIntent(null);
    return info;
  }
  constructor({ request, getAccessToken, refreshAccessToken = null, rootId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    limiter = sharedSheetsReadLimiter(), progress = () => {}, operationJournal = null }) {
    this.request = request; this.getAccessToken = getAccessToken; this.refreshAccessToken = refreshAccessToken;
    this.rootId = validId(rootId); this.sleep = sleep; this.limiter = limiter; this.progress = progress;
    this.manifest = null; this.shards = null; this.operationJournal = operationJournal;
    this.blobIndex = null; this.blobIndexPromise = null; this.eventIndex = null; this.eventIndexCount = null;
    this.slotCache = new Map(); this.cachedAccountId = null; this.accountIdPromise = null;
  }
  async call(url, options = {}) {
    let token = await this.getAccessToken();
    const method = options.method || 'GET';
    const sheetsRequest = url.startsWith(SHEETS);
    const sheetsRead = method === 'GET' && sheetsRequest;
    const send = token => this.request({ url, method, headers: { Authorization: `Bearer ${token}` },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), contentType: 'application/json' }), throw: false });
    let response, refreshed = false, retries = 0;
    while (true) {
      if (sheetsRead) await this.limiter?.acquire(ms => this.progress({ phase: 'backoff', waitMs: ms }));
      try { response = await send(token); }
      catch {
        if (method !== 'GET' || retries >= (sheetsRead ? 7 : 2)) {
          const error = new Error('Google недоступен. Локальные файлы не изменены.');
          error.sheetsTransient = sheetsRequest; throw error;
        }
        await this.sleep(sheetsRead ? Math.min(60000, 2000 * 2 ** retries++) : 300 * 3 ** retries++); continue;
      }
      if (response.status === 401 && !refreshed && this.refreshAccessToken) {
        refreshed = true; token = await this.refreshAccessToken(); continue;
      }
      if (sheetsRead && response.status === 429 && this.limiter) this.limiter.defer(retryDelay(response, retries));
      if (method === 'GET' && transientStatus(response.status) && retries < (sheetsRead ? 7 : 2)) {
        const delay = sheetsRead ? retryDelay(response, retries++) : 300 * 3 ** retries++;
        if (!(sheetsRead && response.status === 429 && this.limiter)) {
          this.progress({ phase: 'backoff', waitMs: delay }); await this.sleep(delay);
        }
        continue;
      }
      break;
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error([401, 403, 404].includes(response.status) ? 'Доступ к таблице v4 отсутствует. Локальные файлы не изменены.'
        : transientStatus(response.status) ? 'Лимит Google или временный сбой. Повторите синхронизацию позже.'
          : `Google Sheets отклонил запрос v4 (HTTP ${response.status}).`);
      error.status = response.status; error.sheetsTransient = sheetsRequest && transientStatus(response.status);
      error.retryAfterMs = retryAfterMs(response); throw error;
    }
    return response.json || {};
  }
  async file(id) { return this.call(`${DRIVE}/files/${id}?fields=id,mimeType,trashed,parents,driveId,capabilities(canEdit),webViewLink`); }
  async spreadsheet(id) { return this.call(`${SHEETS}/${id}?fields=spreadsheetId,namedRanges(namedRangeId,name,range),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`); }
  async values(id, range) { return this.call(`${SHEETS}/${id}/values/${encoded(range)}?valueRenderOption=UNFORMATTED_VALUE`); }
  async batch(id, requests) { return this.call(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: { requests } }); }
  async manifestFor(id) {
    const result = await this.values(id, 'Meta!A2:B2');
    try { return JSON.parse(result.values?.[0]?.[1]); } catch { throw new Error('Отсутствует манифест таблицы v4.'); }
  }
  async assertAccess() {
    this.blobIndex = null; this.blobIndexPromise = null; this.eventIndex = null; this.eventIndexCount = null;
    this.slotCache.clear();
    const root = await this.manifestFor(this.rootId);
    if (!Array.isArray(root?.shardIds) || root.shardIds.length !== 8) throw new Error('Некорректный список сегментов v4.');
    const ids = [this.rootId, ...root.shardIds.map(validId)];
    if (new Set(ids).size !== 9) throw new Error('Повторяющийся ID таблицы v4.');
    const [files, shards, metadata] = await Promise.all([
      Promise.all(ids.map(id => this.file(id))),
      Promise.all(root.shardIds.map(id => this.manifestFor(id))),
      Promise.all(ids.map(id => this.spreadsheet(id)))
    ]);
    assertManifest(root, shards, this.rootId);
    if (await digest(root.params) !== root.paramsDigest) throw new Error('Контрольная сумма параметров v4 не совпадает.');
    for (let i = 0; i < ids.length; i++) {
      const file = files[i];
      if (file.driveId) throw new Error('Таблицы v4 на Shared Drive пока не поддерживаются. Выберите папку My Drive.');
      if (file.id !== ids[i] || file.mimeType !== MIME || file.trashed || file.capabilities?.canEdit !== true
        || !Array.isArray(file.parents) || file.parents.length !== 1 || file.parents[0] !== root.folderId
        || metadata[i].spreadsheetId !== ids[i]
        || !metadata[i].sheets?.some(sheet => sheet.properties?.title === 'Meta' && sheet.properties.sheetId === 1 && sheet.properties.gridProperties?.rowCount >= 2)
        || !metadata[i].sheets?.some(sheet => sheet.properties?.title === 'Payload' && sheet.properties.sheetId === 2
          && sheet.properties.gridProperties?.rowCount >= 1 + (i === 0 ? PARAMS.commitSlots * PARAMS.commitBlocks : PARAMS.dataSlots * PARAMS.dataChunks)
          && sheet.properties.gridProperties?.columnCount >= 2)
        || (i === 0 && !metadata[i].sheets?.some(sheet => sheet.properties?.title === 'TeamPlugins' && sheet.properties.sheetId === 3
          && sheet.properties.gridProperties?.rowCount >= PLUGIN_ROWS + 1 && sheet.properties.gridProperties?.columnCount >= 3)))
        throw new Error(`Таблица v4 ${i + 1} недоступна или перемещена.`);
    }
    this.manifest = clone(root); this.shards = metadata.slice(1);
    this.rootMetadata = metadata[0];
    const pending = this.operationJournal?.pendingAll?.() || [];
    const accountId = pending.length ? await this.accountId() : null;
    for (const operation of pending) {
      if (!ids.includes(operation.spreadsheetId) || !['D', 'C'].includes(operation.kind)
        || !Number.isInteger(operation.slot)) throw new Error('Локальный журнал v4 содержит постороннюю операцию.');
      if (!operation.accountId || operation.accountId !== accountId)
        throw new Error('Локальная операция v4 относится к другой учётной записи Google.');
      const info = metadata[ids.indexOf(operation.spreadsheetId)];
      if (this.slots(info, operation.kind).has(operation.slot)) {
        const found = await this.verifiedSlot(operation.spreadsheetId, operation.kind, operation.slot);
        if (found.header.opId === operation.opId && found.header.hash === operation.payloadHash
          && sameBytes(found.payload, unb64(operation.payload))) await this.operationJournal.ack(operation.opId);
        // Another writer may have won this slot. Keep our durable operation for a new slot.
      }
    }
    return { id: this.rootId, rootId: this.rootId, vaultId: root.vaultId, folderId: root.folderId,
      shardIds: [...root.shardIds], version: 4, kind: 'team', name: root.name || 'Командные заметки' };
  }
  async beginPass() { return this.assertAccess(); }
  async teamInfo() { return this.assertAccess(); }
  async accountId() {
    if (this.cachedAccountId) return this.cachedAccountId;
    if (!this.accountIdPromise) this.accountIdPromise = this.call(`${DRIVE}/about?fields=user(permissionId,me)`).then(about => {
      const user = about.user;
      if (user?.me !== true || typeof user.permissionId !== 'string'
        || !/^[A-Za-z0-9._@+-]{1,256}$/.test(user.permissionId)) throw new Error('Google не подтвердил личность участника v4.');
      this.cachedAccountId = user.permissionId;
      return user.permissionId;
    });
    try { return await this.accountIdPromise; }
    finally { this.accountIdPromise = null; }
  }
  async actorFor() {
    await this.assertAccess();
    const about = await this.call(`${DRIVE}/about?fields=user(permissionId,displayName,me)`);
    const user = about.user;
    if (user?.me !== true || typeof user.permissionId !== 'string' || !/^[A-Za-z0-9._@+-]{1,256}$/.test(user.permissionId)
      || typeof user.displayName !== 'string' || !user.displayName.trim()) throw new Error('Google не подтвердил личность участника v4.');
    this.cachedAccountId = user.permissionId;
    return { actorId: user.permissionId, actorName: user.displayName.trim().slice(0, 120) };
  }
  async pluginChanges() {
    await this.assertAccess();
    const rows = (await this.values(this.rootId, 'TeamPlugins!A2:C')).values || [];
    if (!Array.isArray(rows) || rows.length > PLUGIN_ROWS) throw new Error('История командных плагинов v4 переполнена.');
    const changes = [], seen = new Set();
    for (const row of rows) {
      let value;
      try { value = JSON.parse(row[2]); } catch { throw new Error('Запись командного плагина v4 повреждена.'); }
      if (!value || value.schema !== 1 || value.type !== 'team-plugin-change' || !['propose', 'withdraw'].includes(value.action)
        || typeof value.changeId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.changeId) || seen.has(value.changeId)
        || row[0] !== value.changeId || row[1] !== value.createdAt
        || typeof value.actorId !== 'string' || !/^[A-Za-z0-9._@+-]{1,256}$/.test(value.actorId)
        || typeof value.actorName !== 'string' || !value.actorName.trim() || value.actorName.length > 120
        || typeof value.deviceId !== 'string' || !value.deviceId || value.deviceId.length > 128
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || encoder.encode(row[2]).length > 64 * 1024) throw new Error('Формат записи командного плагина v4 не поддерживается.');
      let clean;
      try { clean = validateCatalog({ schema: 1, plugins: [value.plugin] })[0]; } catch { throw new Error('Запись командного плагина v4 повреждена.'); }
      if (clean.proposedById || clean.proposedByName) throw new Error('Запись командного плагина v4 повреждена.');
      if (canonical(value.plugin) !== canonical(clean)) throw new Error('Запись командного плагина v4 повреждена.');
      seen.add(value.changeId); changes.push(value);
    }
    return changes;
  }
  async getTeamPluginCatalog() {
    return this.teamPluginCatalog(await this.pluginChanges());
  }
  teamPluginCatalog(changes) {
    const current = new Map();
    for (const change of changes) {
      if (change.action === 'withdraw') {
        if (current.get(change.plugin.id)?.proposedById === change.actorId) current.delete(change.plugin.id);
      } else if (!current.has(change.plugin.id) || current.get(change.plugin.id).proposedById === change.actorId) {
        current.set(change.plugin.id, { ...change.plugin, proposedById: change.actorId, proposedByName: change.actorName });
      }
    }
    return { schema: 1, updatedAt: changes.at(-1)?.createdAt || null, plugins: [...current.values()] };
  }
  async putTeamPluginChange(action, plugin, actor, deviceId) {
    if (!['propose', 'withdraw'].includes(action)) throw new Error('Некорректное действие с командным плагином.');
    const { proposedById, proposedByName, ...clean } = validateCatalog({ schema: 1, plugins: [plugin] })[0];
    const identity = await this.actorFor();
    if (actor?.actorId !== identity.actorId) throw new Error('Автор предложения не совпадает с учётной записью Google.');
    const changes = await this.pluginChanges();
    if (changes.length >= PLUGIN_ROWS) throw new Error('Безопасная ёмкость журнала командных плагинов v4 исчерпана.');
    const before = this.teamPluginCatalog(changes);
    const existing = before.plugins.find(item => item.id === clean.id);
    if (action === 'withdraw' && !existing) throw new Error('Предложение уже отозвано.');
    if (existing && existing.proposedById !== identity.actorId)
      throw new Error('Изменять предложение может только его автор.');
    const changeId = globalThis.crypto.randomUUID();
    const value = { schema: 1, type: 'team-plugin-change', changeId, action, plugin: clean,
      actorId: identity.actorId, actorName: identity.actorName, deviceId: String(deviceId || 'unknown').slice(0, 128), createdAt: new Date().toISOString() };
    const url = `${SHEETS}/${this.rootId}/values/${encoded('TeamPlugins!A1:C')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    let failure;
    try { await this.call(url, { method: 'POST', body: { values: [[changeId, value.createdAt, JSON.stringify(value)]] } }); }
    catch (error) { failure = error; }
    const matches = (await this.pluginChanges()).filter(change => change.changeId === changeId);
    if (matches.length === 1 && canonical(matches[0]) === canonical(value)) {
      const now = await this.getTeamPluginCatalog();
      if (action === 'propose' && now.plugins.find(item => item.id === clean.id)?.proposedById !== identity.actorId)
        throw new Error('Другой участник предложил этот плагин раньше. Обновите список.');
      return;
    }
    if (failure) throw failure;
    throw new Error('Google не подтвердил запись командного плагина v4.');
  }
  slots(metadata, kind) {
    const prefix = `AS4_${kind}_`, max = kind === 'D' ? PARAMS.dataSlots : PARAMS.commitSlots;
    const names = new Set();
    for (const item of metadata.namedRanges || []) {
      if (typeof item.name !== 'string' || !item.name.startsWith(prefix)) continue;
      const slot = Number(item.name.slice(prefix.length));
      if (!Number.isInteger(slot) || slot < 0 || slot >= max || marker(kind, slot) !== item.name || names.has(slot)) throw new Error('Повреждён маркер слота v4.');
      const blocks = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
      const start = 1 + slot * blocks;
      if (item.range?.sheetId !== 2 || item.range.startRowIndex !== start || item.range.endRowIndex !== start + blocks)
        throw new Error('Маркер слота v4 указывает на другую область.');
      names.add(slot);
    }
    return names;
  }
  updateSheetMetadata(id, metadata) {
    if (id === this.rootId) this.rootMetadata = metadata;
    const shard = this.manifest?.shardIds?.indexOf(id) ?? -1;
    if (shard >= 0 && this.shards) this.shards[shard] = metadata;
  }
  async preflightInitialUpload({ blobSizes, events, eventByteSizes = events?.map(() => 0) }) {
    if (!this.manifest) await this.assertAccess();
    await this.blobSlots();
    if ((await this.listEvents()).length) throw new Error('История v4 изменилась во время первоначальной проверки. Повторите синхронизацию.');
    if (!Array.isArray(blobSizes) || blobSizes.some(size => !Number.isSafeInteger(size) || size < 0) || !Array.isArray(events)
      || !Array.isArray(eventByteSizes) || eventByteSizes.length !== events.length
      || eventByteSizes.some(size => !Number.isSafeInteger(size) || size < 0))
      throw new Error('Для v4 нужны точные размеры вложений и события перед загрузкой.');
    const dataNeeded = blobSizes.reduce((sum, size) => sum + Math.max(1, Math.ceil(size / (PARAMS.dataChunks * PARAMS.chunkBytes))), 0);
    let commitsNeeded = 0, batch = [], queuedBytes = 0;
    for (let index = 0; index < events.length; index++) {
      const size = eventByteSizes[index];
      if (batch.length && (batch.length >= PARAMS.maxEventsPerCommit || queuedBytes + size > 1024 * 1024)) {
        this.assertPreflightCommit(batch); commitsNeeded++; batch = []; queuedBytes = 0;
      }
      batch.push(events[index]); queuedBytes += size;
      if (batch.length >= PARAMS.maxEventsPerCommit || queuedBytes >= 1024 * 1024) {
        this.assertPreflightCommit(batch); commitsNeeded++; batch = []; queuedBytes = 0;
      }
    }
    if (batch.length) { this.assertPreflightCommit(batch); commitsNeeded++; }
    const dataUsed = this.shards.reduce((sum, sheet) => sum + this.slots(sheet, 'D').size, 0);
    const commitUsed = this.slots(this.rootMetadata, 'C').size;
    if (dataUsed + dataNeeded > PARAMS.maxDataClaims || commitUsed + commitsNeeded > PARAMS.maxCommitClaims)
      throw new Error('Недостаточно безопасной ёмкости v4 для первоначальной загрузки. Облако и локальные файлы не изменены.');
    return { dataNeeded, commitsNeeded, dataAvailable: PARAMS.maxDataClaims - dataUsed, commitsAvailable: PARAMS.maxCommitClaims - commitUsed };
  }
  assertPreflightCommit(events) {
      const revisions = events.map(raw => validateRevision({ ...raw, id: 'x'.repeat(128) }));
      if (encoder.encode(JSON.stringify({ opId: `commit_${'0'.repeat(64)}`, events: revisions })).length > PARAMS.commitBlocks * PARAMS.commitBlockBytes)
        throw new Error('Первоначальный коммит v4 превышает 64 KiB.');
  }
  async readSlot(id, kind, slot) {
    const rows = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
    const start = 2 + slot * rows;
    return (await this.values(id, `Payload!A${start}:B${start + rows - 1}`)).values || [];
  }
  decodeSlot(rows, kind) {
    if (!rows.length || typeof rows[0]?.[0] !== 'string') throw new Error('Маркер v4 указывает на пустой слот.');
    let header;
    try { header = JSON.parse(rows[0][0]); } catch { throw new Error('Повреждён заголовок слота v4.'); }
    const max = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
    if (!header || typeof header !== 'object' || Array.isArray(header)
      || !HASH.test(header.hash || '') || header.payloadHash !== header.hash || typeof header.opId !== 'string'
      || !Number.isInteger(header.blocks) || header.blocks < 1 || header.blocks > max
      || rows.length < header.blocks) throw new Error('Некорректный слот v4.');
    const chunks = [];
    for (let i = 0; i < header.blocks; i++) {
      const value = rows[i]?.[1];
      if (typeof value !== 'string') {
        // Sheets omits a trailing empty B cell. Only the canonical empty data
        // blob can have a missing block; all other missing cells remain errors.
        if (kind !== 'D' || i !== 0 || header.size !== 0 || header.blocks !== 1
          || header.hash !== EMPTY_HASH || header.key !== EMPTY_HASH
          || header.opId !== `blob_${EMPTY_HASH}_0`
          || header.part !== 0 || header.parts !== 1 || rows[0].length !== 1)
          throw new Error('Отсутствует блок слота v4.');
        chunks.push(new Uint8Array(0));
        continue;
      }
      try { chunks.push(unb64(value)); } catch { throw new Error('Повреждён Base64 блока v4.'); }
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0), payload = new Uint8Array(size);
    let at = 0; for (const chunk of chunks) { payload.set(chunk, at); at += chunk.length; }
    if (header.size !== size) throw new Error('Размер слота v4 не совпадает.');
    return { header, payload };
  }
  async verifiedSlot(id, kind, slot) {
    const parsed = this.decodeSlot(await this.readSlot(id, kind, slot), kind);
    if (await sha256(parsed.payload) !== parsed.header.hash) throw new Error('Контрольная сумма слота v4 не совпадает.');
    return parsed;
  }
  async verifiedSlots(id, kind, slots, onProgress = () => {}) {
    const found = [];
    const rows = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
    for (let i = 0; i < slots.length; i += 32) {
      const group = slots.slice(i, i + 32), missing = group.filter(slot => !this.slotCache.has(`${id}:${kind}:${slot}`));
      const query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
      for (const slot of missing) {
        const start = 2 + slot * rows;
        query.append('ranges', `Payload!A${start}:B${start + rows - 1}`);
      }
      if (missing.length) {
        const result = await this.call(`${SHEETS}/${id}/values:batchGet?${query}`);
        if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== missing.length)
          throw new Error('Неполный пакет слотов v4.');
        for (let j = 0; j < missing.length; j++) {
          const parsed = this.decodeSlot(result.valueRanges[j].values || [], kind);
          if (await sha256(parsed.payload) !== parsed.header.hash) throw new Error('Контрольная сумма слота v4 не совпадает.');
          this.slotCache.set(`${id}:${kind}:${missing[j]}`, parsed);
        }
      }
      for (const slot of group) found.push(this.slotCache.get(`${id}:${kind}:${slot}`));
      onProgress(group.length);
    }
    return found;
  }
  finishPass() { this.slotCache.clear(); }
  async claim(id, kind, payload, header) {
    // The reserved tail is never claimable, even when another writer races this one.
    const max = kind === 'D' ? PARAMS.shardDataClaims : PARAMS.maxCommitClaims;
    const blocks = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
    const blockBytes = kind === 'D' ? PARAMS.chunkBytes : PARAMS.commitBlockBytes;
    const shard = this.manifest?.shardIds?.indexOf(id) ?? -1;
    const cached = id === this.rootId ? this.rootMetadata : shard >= 0 ? this.shards?.[shard] : null;
    const sheet = cached || await this.spreadsheet(id), used = this.slots(sheet, kind);
    this.updateSheetMetadata(id, sheet);
    if (payload.length > blocks * blockBytes) throw new Error('Payload превышает вместимость слота v4.');
    const hash = await sha256(payload), count = Math.max(1, Math.ceil(payload.length / blockBytes));
    const pending = this.operationJournal?.pending(header.opId);
    if (pending && (pending.spreadsheetId !== id || pending.kind !== kind || pending.key !== header.key
      || pending.payloadHash !== hash || pending.payload !== b64(payload))) throw new Error('Локальный журнал v4 не совпадает с повторяемой операцией.');
    const choices = pending ? [pending.slot, ...Array.from({ length: max }, (_, slot) => slot).filter(slot => slot !== pending.slot)]
      : Array.from({ length: max }, (_, slot) => slot);
    for (const slot of choices) {
      if (!Number.isInteger(slot) || slot < 0 || slot >= max) throw new Error('Некорректный слот в локальном журнале v4.');
      if (used.has(slot)) {
        const old = await this.verifiedSlot(id, kind, slot);
        if (old.header.hash === hash && old.header.opId === header.opId && old.header.key === header.key) {
          await this.operationJournal?.ack(header.opId); return slot;
        }
        continue;
      }
      const start = 1 + slot * blocks;
      const rows = Array.from({ length: count }, (_, i) => ({ values: [
        { userEnteredValue: { stringValue: i === 0 ? JSON.stringify({ ...header, hash, payloadHash: hash, size: payload.length, blocks: count }) : '' } },
        { userEnteredValue: { stringValue: b64(payload.subarray(i * blockBytes, (i + 1) * blockBytes)) } }
      ] }));
      const requests = [
        { addNamedRange: { namedRange: { namedRangeId: marker(kind, slot), name: marker(kind, slot),
          range: { sheetId: 2, startRowIndex: start, endRowIndex: start + blocks } } } },
        { updateCells: { range: { sheetId: 2, startRowIndex: start, endRowIndex: start + count, startColumnIndex: 0, endColumnIndex: 2 }, rows, fields: 'userEnteredValue' } }
      ];
      const accountId = this.operationJournal ? await this.accountId() : null;
      if (pending?.accountId && pending.accountId !== accountId)
        throw new Error('Локальная операция v4 относится к другой учётной записи Google.');
      await this.operationJournal?.stage({ opId: header.opId, spreadsheetId: id, slot, kind, key: header.key,
        payload: b64(payload), payloadHash: hash, accountId });
      let collision = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        let error = null;
        try { await this.batch(id, requests); } catch (caught) { error = caught; }
        if (!error) {
          // Sheets batchUpdate is atomic: a successful response confirms both the
          // marker and payload. Avoid two rate-limited reads for every normal write.
          const metadata = id === this.rootId ? this.rootMetadata : this.shards?.[shard];
          if (metadata && !metadata.namedRanges?.some(item => item.namedRangeId === marker(kind, slot))) {
            metadata.namedRanges ||= [];
            metadata.namedRanges.push({ namedRangeId: marker(kind, slot), name: marker(kind, slot),
              range: { sheetId: 2, startRowIndex: start, endRowIndex: start + blocks } });
          }
          this.slotCache.set(`${id}:${kind}:${slot}`, { header: { ...header, hash, payloadHash: hash,
            size: payload.length, blocks: count }, payload: new Uint8Array(payload) });
          await this.operationJournal?.ack(header.opId);
          return slot;
        }
        // A response can be lost after an atomic write. Read back both marker and bytes.
        const fresh = await this.spreadsheet(id);
        this.updateSheetMetadata(id, fresh);
        if (this.slots(fresh, kind).has(slot)) {
          const old = await this.verifiedSlot(id, kind, slot);
          if (old.header.hash === hash && old.header.opId === header.opId && old.header.key === header.key
            && sameBytes(old.payload, payload)) {
            await this.operationJournal?.ack(header.opId); return slot;
          }
          used.add(slot); collision = true; break;
        }
        if (!error) throw new Error('Google не подтвердил маркер слота v4.');
        const transient = !error.status || transientStatus(error.status);
        if (!transient || attempt === 2) throw error;
        await this.sleep(error.retryAfterMs ?? Math.min(60000, 2000 * 2 ** attempt));
      }
      if (collision) continue;
    }
    throw new Error('Свободных слотов v4 нет.');
  }
  async blobSlots() {
    if (this.blobIndex) return this.blobIndex;
    if (this.blobIndexPromise) return this.blobIndexPromise;
    if (!this.manifest) await this.assertAccess();
    this.blobIndexPromise = (async () => {
      const index = new Map();
      const total = this.shards.reduce((sum, sheet) => sum + this.slots(sheet, 'D').size, 0);
      let completed = 0;
      this.progress({ phase: 'index', completed, total });
      for (let shard = 0; shard < PARAMS.shards; shard++) {
        const occupied = [...this.slots(this.shards[shard], 'D')].sort((a, b) => a - b);
        for (const record of await this.verifiedSlots(this.manifest.shardIds[shard], 'D', occupied, count => {
          completed += count; this.progress({ phase: 'index', completed, total });
        })) {
          const { key: hash, part, parts } = record.header;
          if (!HASH.test(hash) || !Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || part < 0 || part >= parts)
            throw new Error('Повреждён индекс вложения v4.');
          if (!index.has(hash)) index.set(hash, { parts, records: new Map() });
          const group = index.get(hash);
          if (group.parts !== parts || group.records.has(part)) throw new Error('Повтор или повреждение вложения v4.');
          group.records.set(part, record.payload);
        }
      }
      this.blobIndex = index;
      return index;
    })();
    try { return await this.blobIndexPromise; }
    catch (error) { this.blobIndexPromise = null; throw error; }
    finally { this.blobIndexPromise = null; }
  }
  async getBlob(hash) {
    if (!HASH.test(hash)) throw new Error('Некорректный hash вложения.');
    return this.assembleBlob(hash, (await this.blobSlots()).get(hash));
  }
  async assembleBlob(hash, found) {
    if (!found) throw new Error('Вложение v4 отсутствует. Локальные файлы не изменены.');
    if (found.records.size !== found.parts) throw new Error('Неполное вложение v4. Локальные файлы не изменены.');
    const size = [...found.records.values()].reduce((sum, bytes) => sum + bytes.length, 0), result = new Uint8Array(size);
    let offset = 0;
    for (let part = 0; part < found.parts; part++) {
      const bytes = found.records.get(part); result.set(bytes, offset); offset += bytes.length;
    }
    if (await sha256(result) !== hash) throw new Error('Контрольная сумма вложения v4 не совпадает.');
    return result;
  }
  async validateSnapshot(events) {
    const blobs = await this.blobSlots();
    for (const hash of new Set(events.map(event => validateRevision(event).hash).filter(Boolean)))
      await this.assembleBlob(hash, blobs.get(hash));
  }
  async putBlob(hash, data) { await this.assertAccess(); await this.putBlobs([{ hash, data }]); }
  async putBlobs(items) {
    const existing = await this.blobSlots();
    const plannedHashes = new Set();
    let totalParts = 0;
    for (const { hash, data } of items) {
      if (!HASH.test(hash || '') || !(data instanceof Uint8Array) || plannedHashes.has(hash)) continue;
      plannedHashes.add(hash);
      const slotBytes = PARAMS.dataChunks * PARAMS.chunkBytes;
      const parts = Math.max(1, Math.ceil(data.length / slotBytes));
      const staged = existing.get(hash);
      if (staged?.parts === parts) {
        for (let part = 0; part < parts; part++) if (!staged.records.has(part)) totalParts++;
      } else totalParts += parts;
    }
    let completedParts = 0;
    this.progress({ phase: 'blob-upload', completed: completedParts, total: totalParts });
    const checked = new Set();
    for (const { hash, data } of items) {
      if (!HASH.test(hash) || !(data instanceof Uint8Array) || await sha256(data) !== hash) throw new Error('Вложение изменилось перед загрузкой.');
      const staged = existing.get(hash);
      if (staged && staged.records.size === staged.parts) {
        if (!checked.has(hash)) await this.assembleBlob(hash, staged);
        checked.add(hash);
        continue;
      }
      const slotBytes = PARAMS.dataChunks * PARAMS.chunkBytes, parts = Math.max(1, Math.ceil(data.length / slotBytes));
      if (staged && staged.parts !== parts) throw new Error('Размер начатой загрузки v4 не совпадает.');
      const totalUsed = this.shards.reduce((sum, sheet) => sum + this.slots(sheet, 'D').size, 0);
      if (totalUsed + parts - (staged?.records.size || 0) > PARAMS.maxDataClaims) throw new Error('Безопасная ёмкость данных v4 исчерпана.');
      for (let part = 0; part < parts; part++) {
        if (staged?.records.has(part)) continue;
      const candidates = this.manifest.shardIds.map((id, shard) => ({ id, shard, used: this.slots(this.shards[shard], 'D').size }))
          .sort((a, b) => a.used - b.used || a.shard - b.shard);
        const pendingId = this.operationJournal?.pending(`blob_${hash}_${part}`)?.spreadsheetId;
      const target = pendingId ? candidates.find(item => item.id === pendingId) : candidates.find(item => item.used < PARAMS.shardDataClaims);
        if (!target) throw new Error('Свободных слотов данных v4 нет.');
        const opId = `blob_${hash}_${part}`;
        await this.claim(target.id, 'D', data.subarray(part * slotBytes, (part + 1) * slotBytes), { opId, key: hash, part, parts });
        completedParts++;
        this.progress({ phase: 'blob-upload', completed: completedParts, total: totalParts });
      }
      existing.set(hash, { parts, records: new Map(Array.from({ length: parts }, (_, part) =>
        [part, data.subarray(part * slotBytes, (part + 1) * slotBytes)])) });
      checked.add(hash);
    }
    this.blobIndex = existing;
  }
  async listEvents() {
    if (!this.manifest) await this.assertAccess();
    this.rootMetadata = await this.spreadsheet(this.rootId);
    const occupied = [...this.slots(this.rootMetadata, 'C')].sort((a, b) => a - b);
    if (this.eventIndex && this.eventIndexCount === occupied.length) return [...this.eventIndex.values()].map(clone);
    const events = new Map();
    let completed = 0;
    this.progress({ phase: 'history', completed, total: occupied.length });
    for (const { header, payload } of await this.verifiedSlots(this.rootId, 'C', occupied, count => {
      completed += count; this.progress({ phase: 'history', completed, total: occupied.length });
    })) {
      if (typeof header.opId !== 'string' || header.key !== header.opId) throw new Error('Некорректный коммит v4.');
      let commit;
      try { commit = JSON.parse(decoder.decode(payload)); } catch { throw new Error('Повреждён коммит v4.'); }
      if (!Array.isArray(commit.events) || commit.events.length < 1 || commit.events.length > PARAMS.maxEventsPerCommit || commit.opId !== header.opId) throw new Error('Некорректная история v4.');
      for (const raw of commit.events) {
        const event = validateRevision(raw), previous = events.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Разные события v4 имеют одинаковый ID.');
        events.set(event.id, event);
      }
    }
    this.eventIndex = events; this.eventIndexCount = occupied.length;
    return [...events.values()].map(clone);
  }
  async putEvent(event) { await this.putEvents([event]); }
  async putEvents(input) {
    const known = new Map((await this.listEvents()).map(event => [event.id, event]));
    const missing = [];
    for (const raw of input) {
      const event = validateRevision(raw), previous = known.get(event.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Конфликт ID изменения v4.');
      if (!previous) { missing.push(event); known.set(event.id, event); }
    }
    const referenced = [...new Set(missing.map(event => event.hash).filter(Boolean))];
    const blobs = referenced.length ? await this.blobSlots() : null;
    for (const hash of referenced) await this.assembleBlob(hash, blobs.get(hash));
    for (let i = 0; i < missing.length; i += PARAMS.maxEventsPerCommit) {
      const events = missing.slice(i, i + PARAMS.maxEventsPerCommit);
      const previousCommitCount = this.slots(this.rootMetadata, 'C').size;
      const opId = `commit_${await digest(events)}`;
      const payload = encoder.encode(JSON.stringify({ opId, events }));
      if (payload.length > PARAMS.commitBlocks * PARAMS.commitBlockBytes) throw new Error('Коммит v4 превышает 64 KiB.');
      if (this.slots(this.rootMetadata, 'C').size >= PARAMS.maxCommitClaims) throw new Error('Безопасная ёмкость коммитов v4 исчерпана.');
      await this.claim(this.rootId, 'C', payload, { opId, key: opId });
      const currentCommitCount = this.slots(this.rootMetadata, 'C').size;
      if (this.eventIndex && currentCommitCount === previousCommitCount + 1) {
        for (const event of events) this.eventIndex.set(event.id, clone(event));
        this.eventIndexCount = currentCommitCount;
      } else { this.eventIndex = null; this.eventIndexCount = null; }
    }
  }
}

module.exports = { TeamShardedStore, PARAMS, assertManifest, digest };

},
"team-sheet-store.cjs": function(module, exports, load) {
'use strict';

const { sha256 } = load("drive.cjs");

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
const CHUNK_BYTES = 32 * 1024;
const APPEND_BATCH_BYTES = 1500 * 1024;
const encoder = new TextEncoder();

function safeId(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Некорректный ID командной таблицы.');
  return value;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Google Sheets не ответил вовремя. Изменения сохранены локально.')), ms); })])
    .finally(() => clearTimeout(timer));
}
function encodeBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > CHUNK_BYTES * 2) throw new Error('Повреждён фрагмент вложения в командной таблице.');
  let raw;
  try { raw = atob(value); } catch { throw new Error('Повреждён фрагмент вложения в командной таблице.'); }
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function rangeEnd(range) {
  const match = typeof range === 'string' && range.match(/!A(\d+):D(\d+)$/);
  if (!match) throw new Error('Google не вернул диапазон добавленных данных.');
  return [Number(match[1]), Number(match[2])];
}

/** Team-only Drive container. The selected spreadsheet is the one file authorized by drive.file. */
class TeamSheetStore {
  constructor({ request, getAccessToken, folderId = null, spreadsheetId = null, requestTimeout = 120000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.request = request; this.getAccessToken = getAccessToken; this.folderId = folderId ? safeId(folderId) : null;
    this.spreadsheetId = spreadsheetId ? safeId(spreadsheetId) : null; this.requestTimeout = requestTimeout; this.sleep = sleep;
    this.events = null; this.blobIndex = null; this.pluginChanges = null;
  }
  async call(url, { method = 'GET', body, contentType = 'application/json' } = {}) {
    const token = await this.getAccessToken();
    let result;
    try {
      result = await deadline(this.request({ url, method, headers: { Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body, contentType }), throw: false }), this.requestTimeout);
    } catch { throw new Error('Не удалось связаться с Google. Изменения сохранены локально.'); }
    if (result.status < 200 || result.status >= 300) {
      const error = result.status === 401 ? new Error('Вход Google истёк. Подключите командную таблицу снова.')
        : result.status === 403 || result.status === 404 ? new Error('Командная таблица недоступна или права редактора отозваны.')
          : result.status === 429 || result.status === 503 ? new Error('Google временно ограничил запросы. Синхронизация повторится позже.')
            : new Error(`Командное хранилище Google недоступно (HTTP ${result.status}). Изменения сохранены локально.`);
      error.status = result.status;
      throw error;
    }
    return result.json || {};
  }
  driveCall(path, options) { return this.call(`${DRIVE}${path}`, options); }
  sheetCall(path, options) {
    if (!this.spreadsheetId) throw new Error('Выберите командную таблицу Google.');
    return this.call(`${SHEETS}/${this.spreadsheetId}${path}`, options);
  }
  async createTeamVault(name) {
    const cleanName = String(name || '').trim().slice(0, 160) || 'Командные заметки';
    const folderName = `Amygdala — ${cleanName}`;
    const folder = await this.driveCall('/files?fields=id,name,webViewLink,mimeType', {
      method: 'POST', body: JSON.stringify({ name: folderName, mimeType: MIME_FOLDER })
    });
    const folderId = safeId(folder?.id);
    if (folder.mimeType !== MIME_FOLDER) throw new Error('Google не создал папку командного хранилища.');
    const created = await this.call(SHEETS, { method: 'POST', body: JSON.stringify({
      properties: { title: `${folderName} — Amygdala` },
      sheets: ['Meta', 'Events', 'Blobs', 'BlobIndex', 'TeamPlugins'].map((title, index) => ({ properties: { sheetId: index + 1, title } }))
    }) });
    const spreadsheetId = safeId(created?.spreadsheetId);
    this.folderId = folderId; this.spreadsheetId = spreadsheetId;
    await this.sheetCall('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: [
      { range: 'Meta!A1:B2', values: [['key', 'value'], ['manifest', JSON.stringify({ schema: 1, type: 'amygdala-team-sheet', version: 3, id: spreadsheetId, folderId, name: cleanName })]] },
      { range: 'Events!A1:B1', values: [['eventId', 'eventJson']] },
      { range: 'Blobs!A1:D1', values: [['hash', 'chunk', 'chunks', 'base64']] },
      { range: 'BlobIndex!A1:D1', values: [['hash', 'size', 'chunks', 'rangesJson']] },
      { range: 'TeamPlugins!A1:C1', values: [['changeId', 'createdAt', 'changeJson']] }
    ] }) });
    const currentFile = await this.driveCall(`/files/${spreadsheetId}?fields=id,parents`);
    if (currentFile?.id !== spreadsheetId || !Array.isArray(currentFile.parents)) throw new Error('Не удалось определить расположение служебной таблицы Google.');
    const move = new URLSearchParams({ addParents: folderId, fields: 'id,parents' });
    if (currentFile.parents.length) move.set('removeParents', currentFile.parents.join(','));
    await this.driveCall(`/files/${spreadsheetId}?${move}`, { method: 'PATCH', body: '{}' });
    const info = await this.teamInfo();
    return { ...info, webViewLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folderId}`,
      spreadsheetLink: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
  }
  async values(range) {
    const query = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' });
    return this.sheetCall(`/values/${encodeURIComponent(range)}?${query}`);
  }
  async append(range, rows) {
    const query = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', includeValuesInResponse: 'false' });
    return this.sheetCall(`/values/${encodeURIComponent(range)}:append?${query}`, { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: rows }) });
  }
  async teamInfo() {
    const meta = await this.values('Meta!A2:B2');
    const manifestText = meta?.values?.[0]?.[1];
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { throw new Error('В таблице нет манифеста Amygdala или её формат повреждён.'); }
    if (manifest?.schema !== 1 || manifest.type !== 'amygdala-team-sheet' || manifest.version !== 3
      || manifest.id !== this.spreadsheetId || !TOKEN.test(manifest.folderId || '') || typeof manifest.name !== 'string') {
      throw new Error('Формат командной таблицы не поддерживается. Выберите таблицу Amygdala 0.3.');
    }
    this.folderId = manifest.folderId;
    const file = await this.driveCall(`/files/${this.spreadsheetId}?fields=id,name,mimeType,trashed,webViewLink,parents,capabilities(canEdit)`);
    if (file.id !== this.spreadsheetId || file.mimeType !== MIME_SHEET || file.trashed || file.capabilities?.canEdit !== true
      || !Array.isArray(file.parents) || !file.parents.includes(this.folderId)) throw new Error('Нужна доступная для редактирования таблица Amygdala в командной папке.');
    return { id: this.spreadsheetId, folderId: this.folderId, name: manifest.name, version: 3, kind: 'team',
      folderName: `Amygdala — ${manifest.name}`, webViewLink: `https://drive.google.com/drive/folders/${this.folderId}`, spreadsheetLink: file.webViewLink };
  }
  async assertAccess() { await this.teamInfo(); }
  async actorFor(email) {
    await this.teamInfo();
    if (typeof email !== 'string' || !email.includes('@')) throw new Error('Укажите email Google участника, чтобы проверить права команды.');
    const found = []; let pageToken; const seen = new Set();
    do {
      const query = new URLSearchParams({ fields: 'nextPageToken,permissions(id,type,emailAddress,displayName,role)', pageSize: '100' });
      if (pageToken) query.set('pageToken', pageToken);
      const result = await this.driveCall(`/files/${this.spreadsheetId}/permissions?${query}`);
      if (!Array.isArray(result.permissions)) throw new Error('Google не вернул список участников командной таблицы.');
      found.push(...result.permissions); pageToken = result.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('Некорректная страница участников Google Drive.');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    const permission = found.find(item => item.type === 'user' && item.emailAddress?.toLowerCase() === email.toLowerCase());
    if (!permission || !['owner', 'writer', 'organizer', 'fileOrganizer'].includes(permission.role)) throw new Error('Доступ редактора к командной папке ещё не подтверждён.');
    if (typeof permission.id !== 'string' || !permission.id || permission.id.length > 256) throw new Error('Google не вернул стабильный ID участника.');
    return { actorId: permission.id, actorName: typeof permission.displayName === 'string' && permission.displayName.trim() ? permission.displayName.trim().slice(0, 120) : 'Участник' };
  }
  async listEvents() {
    await this.assertAccess();
    const result = await this.values('Events!A2:B');
    const events = new Map();
    for (const row of result.values || []) {
      if (!row[0] && !row[1]) continue;
      if (typeof row[0] !== 'string' || typeof row[1] !== 'string' || row[1].length > 50000) throw new Error('Некорректная запись истории Amygdala.');
      let event; try { event = JSON.parse(row[1]); } catch { throw new Error('Не удалось прочитать запись истории Amygdala.'); }
      if (!event || event.id !== row[0]) throw new Error('ID записи не совпадает с журналом командной таблицы.');
      const previous = events.get(row[0]);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('В командной таблице есть несовместимые записи с одним ID.');
      events.set(row[0], event);
    }
    this.events = [...events.values()];
    return this.events.map(event => JSON.parse(JSON.stringify(event)));
  }
  async putEvent(event) {
    await this.putEvents([event]);
  }
  async putEvents(input) {
    await this.listEvents();
    const known = new Map(this.events.map(event => [event.id, event])), missing = new Map();
    for (const event of input) {
      const text = JSON.stringify(event), previous = known.get(event.id) || missing.get(event.id)?.event;
      if (text.length > 50000) throw new Error('Изменение слишком велико для строки Google Sheets.');
      if (previous) {
        if (JSON.stringify(previous) !== text) throw new Error('Конфликт идентификатора изменения.');
        continue;
      }
      missing.set(event.id, { event: JSON.parse(text), text });
    }
    let batch = [], bytesInBatch = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.append('Events!A:B', batch.map(({ event, text }) => [event.id, text]));
      this.events.push(...batch.map(({ event }) => event));
      batch = []; bytesInBatch = 0;
    };
    for (const item of missing.values()) {
      const size = encoder.encode(item.text).byteLength + item.event.id.length;
      if (batch.length && (batch.length >= 100 || bytesInBatch + size > APPEND_BATCH_BYTES)) await flush();
      batch.push(item); bytesInBatch += size;
    }
    await flush();
  }
  async loadBlobIndex() {
    const result = await this.values('BlobIndex!A2:D');
    const index = new Map();
    for (const row of result.values || []) {
      if (!row[0] && !row[1]) continue;
      if (typeof row[0] !== 'string' || !HASH.test(row[0]) || !Number.isSafeInteger(Number(row[1])) || Number(row[1]) < 0
        || !Number.isSafeInteger(Number(row[2])) || Number(row[2]) < 1 || typeof row[3] !== 'string' || row[3].length > 50000) throw new Error('Повреждён индекс вложений командной таблицы.');
      let ranges; try { ranges = JSON.parse(row[3]); } catch { throw new Error('Повреждён индекс диапазонов вложения.'); }
      if (!Array.isArray(ranges) || !ranges.length || ranges.some(pair => !Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[0] < 2 || pair[1] < pair[0])) throw new Error('Некорректный индекс диапазонов вложения.');
      const item = { size: Number(row[1]), chunks: Number(row[2]), ranges };
      if (!index.has(row[0])) index.set(row[0], []);
      index.get(row[0]).push(item);
    }
    this.blobIndex = index;
    return index;
  }
  async putBlob(hash, data) {
    await this.putBlobs([{ hash, data }]);
  }
  async putBlobs(input) {
    const index = await this.loadBlobIndex(), blobs = new Map();
    for (const { hash, data } of input) {
      if (!HASH.test(hash) || !(data instanceof Uint8Array) || await sha256(data) !== hash) throw new Error('Файл изменился перед загрузкой.');
      if (!index.has(hash)) blobs.set(hash, data);
    }
    if (!blobs.size) return;
    const rangesByHash = new Map([...blobs.keys()].map(hash => [hash, []]));
    let batch = [], batchMeta = [], bytesInBatch = 0;
    const flush = async () => {
      if (!batch.length) return;
      const response = await this.append('Blobs!A:D', batch);
      const [start, end] = rangeEnd(response?.updates?.updatedRange);
      if (end - start + 1 !== batch.length) throw new Error('Google добавил неполный блок вложения.');
      for (let i = 0; i < batchMeta.length; i++) {
        const row = start + i, ranges = rangesByHash.get(batchMeta[i].hash), last = ranges.at(-1);
        if (last && last[1] + 1 === row) last[1] = row; else ranges.push([row, row]);
      }
      batch = []; batchMeta = []; bytesInBatch = 0;
    };
    for (const [hash, data] of blobs) {
      const count = Math.max(1, Math.ceil(data.byteLength / CHUNK_BYTES));
      for (let part = 0; part < count; part++) {
        const bytes = data.subarray(part * CHUNK_BYTES, Math.min(data.byteLength, (part + 1) * CHUNK_BYTES));
        const row = [hash, String(part), String(count), encodeBase64(bytes)];
        const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
        if (batch.length && bytesInBatch + rowBytes > APPEND_BATCH_BYTES) await flush();
        batch.push(row); batchMeta.push({ hash }); bytesInBatch += rowBytes;
      }
    }
    await flush();
    const records = [...blobs].map(([hash, data]) => ({ hash, data, chunks: Math.max(1, Math.ceil(data.byteLength / CHUNK_BYTES)), ranges: rangesByHash.get(hash) }));
    let indexRows = [], indexBytes = 0;
    const flushIndex = async () => {
      if (!indexRows.length) return;
      await this.append('BlobIndex!A:D', indexRows);
      indexRows = []; indexBytes = 0;
    };
    for (const record of records) {
      const row = [record.hash, String(record.data.byteLength), String(record.chunks), JSON.stringify(record.ranges)];
      const rowBytes = encoder.encode(JSON.stringify(row)).byteLength;
      if (indexRows.length && indexBytes + rowBytes > APPEND_BATCH_BYTES) await flushIndex();
      indexRows.push(row); indexBytes += rowBytes;
      index.set(record.hash, [{ size: record.data.byteLength, chunks: record.chunks, ranges: record.ranges }]);
    }
    await flushIndex();
  }
  async getBlob(hash) {
    if (!HASH.test(hash)) throw new Error('Некорректная контрольная сумма.');
    const index = await this.loadBlobIndex(), candidates = index.get(hash);
    if (!candidates?.length) throw new Error('В командной таблице отсутствует содержимое изменения. Локальные файлы не заменены.');
    const item = candidates.at(-1);
    const query = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'UNFORMATTED_VALUE' });
    for (const [start, end] of item.ranges) query.append('ranges', `Blobs!A${start}:D${end}`);
    const response = await this.sheetCall(`/values:batchGet?${query}`);
    if (!Array.isArray(response.valueRanges) || response.valueRanges.length !== item.ranges.length) throw new Error('Google вернул неполные фрагменты вложения.');
    const decoded = new Array(item.chunks); let totalBytes = 0;
    for (const range of response.valueRanges) for (const row of range.values || []) {
      if (row[0] !== hash || !Number.isSafeInteger(Number(row[1])) || Number(row[2]) !== item.chunks) throw new Error('Фрагмент вложения не соответствует индексу.');
      const part = Number(row[1]);
      if (part < 0 || part >= item.chunks || decoded[part]) throw new Error('Повторный или неверный фрагмент вложения.');
      decoded[part] = decodeBase64(row[3]); totalBytes += decoded[part].byteLength;
    }
    if (decoded.some(part => !part) || totalBytes !== item.size) throw new Error('В командной таблице отсутствуют фрагменты вложения.');
    const result = new Uint8Array(totalBytes); let offset = 0;
    for (const part of decoded) { result.set(part, offset); offset += part.byteLength; }
    if (await sha256(result) !== hash) throw new Error('Проверка загруженного файла не прошла.');
    return result;
  }
  async getTeamPluginCatalog() {
    await this.assertAccess();
    const response = await this.values('TeamPlugins!A2:C');
    const changes = [];
    for (const row of response.values || []) {
      if (!row[0] && !row[1]) continue;
      let value; try { value = JSON.parse(row[2]); } catch { throw new Error('Запись командного плагина повреждена.'); }
      if (!value || value.schema !== 1 || value.type !== 'team-plugin-change' || !['propose', 'withdraw'].includes(value.action)
        || typeof value.changeId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.changeId)
        || typeof value.actorId !== 'string' || value.actorId.length > 256 || typeof value.actorName !== 'string' || value.actorName.length > 120
        || typeof value.deviceId !== 'string' || value.deviceId.length > 128 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Формат записи командного плагина не поддерживается.');
      changes.push(value);
    }
    changes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.changeId.localeCompare(b.changeId));
    const current = new Map();
    for (const change of changes) {
      if (change.action === 'withdraw') { if (current.get(change.plugin?.id)?.proposedById === change.actorId) current.delete(change.plugin?.id); }
      else current.set(change.plugin?.id, { ...change.plugin, proposedById: change.actorId, proposedByName: change.actorName });
    }
    return { schema: 1, updatedAt: changes.at(-1)?.createdAt || null, plugins: [...current.values()] };
  }
  async putTeamPluginChange(action, plugin, actor, deviceId) {
    await this.assertAccess();
    if (!['propose', 'withdraw'].includes(action)) throw new Error('Некорректное действие с командным плагином.');
    const changeId = globalThis.crypto.randomUUID();
    const value = { schema: 1, type: 'team-plugin-change', changeId, action, plugin, actorId: actor?.actorId || 'unknown',
      actorName: actor?.actorName || 'Участник', deviceId: String(deviceId || 'unknown').slice(0, 128), createdAt: new Date().toISOString() };
    await this.append('TeamPlugins!A:C', [[changeId, value.createdAt, JSON.stringify(value)]]);
  }
}

module.exports = { TeamSheetStore, CHUNK_BYTES, APPEND_BATCH_BYTES };

}
};
const cache = Object.create(null);
function load(id) { if (cache[id]) return cache[id].exports; if (!modules[id]) throw new Error('Unknown module'); const m = {exports:{}}; cache[id]=m; modules[id](m,m.exports,load); return m.exports; }
module.exports=load('main.cjs');
