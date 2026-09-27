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
  constructor({ bridge, request, secrets, savePending, getPending, email, mode = 'personal' }) {
    if (!['personal', 'team'].includes(mode)) throw new Error('Некорректный режим входа.');
    this.bridge = bridge.replace(/\/$/, ''); this.request = request; this.secrets = secrets;
    this.savePending = savePending; this.getPending = getPending; this.email = email; this.personalEmail = mode === 'personal' ? email : null; this.mode = mode;
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
  async start() {
    const verifier = randomToken(), state = randomToken();
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await this.savePending({ verifier, state, created: Date.now() });
    const r = await this.post('/auth/start', { challenge, state, mode: this.mode });
    const url = new URL(r.url || r.authorizeUrl || r.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Неожиданный адрес входа.');
    const loginHint = this.mode === 'personal' && this.email !== this.personalEmail ? this.email : this.mode === 'personal' ? this.personalEmail : null;
    if (loginHint) url.searchParams.set('login_hint', loginHint);
    return url.toString();
  }
  async complete({ code, state }) {
    const pending = await this.getPending();
    if (!pending || typeof state !== 'string' || state !== pending.state || !Number.isFinite(pending.created) || pending.created > Date.now() || Date.now() - pending.created > 10 * 60 * 1000) throw new Error('Ссылка входа устарела или относится к другому устройству.');
    const r = await this.post('/auth/exchange', { code, verifier: pending.verifier, state });
    if (!r.access_token || !r.refresh_token) throw new Error('Google не предоставил постоянный доступ. Повторите вход с подтверждением доступа.');
    let me;
    try { me = await this.request({ url: 'https://openidconnect.googleapis.com/v1/userinfo',
      headers: { Authorization: `Bearer ${r.access_token}` }, throw: false }); }
    catch { throw new Error('Не удалось проверить аккаунт Google.'); }
    if (me.status !== 200 || me.json?.email_verified !== true || typeof me.json.email !== 'string') {
      throw new Error('Не удалось подтвердить аккаунт Google.');
    }
    await this.secrets.set(r.refresh_token);
    this.token = r.access_token; this.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
    await this.savePending(null);
    return { email: me.json.email, name: typeof me.json.name === 'string' ? me.json.name : '' };
  }
  async accessToken() {
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
    try { await this.create('vault', id, encoder.encode(JSON.stringify(value)), `Easy Sync — ${value.name}`); }
    finally { this.vaultId = previous; }
    return value;
  }
  async createTeamVault(name) {
    if (this.mode !== 'team') throw new Error('Создайте командное хранилище в командном режиме.');
    const folderName = `Easy Sync — ${String(name).trim().slice(0, 180) || 'Командные заметки'}`;
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
      const item = this.state.outbox[0];
      const event = validateRevision(item.event);
      if (event.hash !== null) {
        const bytes = Uint8Array.from(item.bytes);
        if (await this.hash(bytes) !== event.hash) throw new Error('Corrupt pending upload');
        await this.remote.putBlob(event.hash, bytes);
      }
      await this.remote.putEvent(event);
      // This records the acknowledged local revision, even if the user has
      // since edited it. A subsequent edit must descend from this revision.
      this.state.baseline[event.path] = { hash: event.hash, heads: [event.id] };
      this.state.outbox.shift();
      await this.persist();
      completed += 1;
      this.progress({ phase: 'upload', completed, total });
    }
  }
  async checkedBlob(hash) {
    const bytes = await this.remote.getBlob(hash);
    if (!(bytes instanceof Uint8Array) || await this.hash(bytes) !== hash) throw new Error(`Blob integrity failure: ${hash}`);
    return bytes;
  }
  async verify() {
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
    await this.remote.assertAccess?.();
    this.progress({ phase: 'listing' });
    let events = await this.remote.listEvents();
    materialize([...events,...this.state.outbox.map(item=>item.event)]);
    const knownIds = new Set([...events,...this.state.outbox.map(item=>item.event)].map(event=>event.id));
    for (const base of Object.values(this.state.baseline)) {
      if (!Array.isArray(base.heads) || base.heads.some(id=>!knownIds.has(id))) throw new Error('Remote history missing previously synchronized revisions');
    }
    await this.flush();
    events = await this.remote.listEvents();
    const remoteHeads = materialize(events);
    const snapshot = await this.local.scan();
    this.progress({ phase: 'planning', total: Object.keys(snapshot).length });
    const remotePaths = Object.fromEntries([...remoteHeads].filter(([,heads]) => heads.some(h => h.hash !== null)).map(([path]) => [path,'remote']));
    planSync({local:snapshot, remote:remotePaths});
    const drafts = planLocalRevisions({local:snapshot, baseline:this.state.baseline, remoteHeads});
    const deferred = [];
    let uploaded = 0;
    this.progress({ phase: 'upload', completed: uploaded, total: drafts.length });
    for (const draft of drafts) {
      let bytes = null;
      if (draft.hash !== null) {
        bytes = await this.local.read(draft.path);
        if (!bytes || await this.hash(bytes) !== draft.hash) { deferred.push(draft.path); continue; }
      }
      this.state.outbox.push({event:validateRevision({id:this.randomId(), ...draft, ...this.revisionMetadata()}), bytes:bytes === null ? null : bytes.slice()});
      // Keep at most one newly planned file in memory. It is durable before
      // upload, and the remaining metadata-only drafts are recomputed safely
      // after an interruption.
      materialize([...events,...this.state.outbox.map(item=>item.event)]);
      await this.flush({ completed: uploaded, total: drafts.length });
      uploaded += 1;
    }
    this.progress({ phase: 'reconciling' });
    events = await this.remote.listEvents();
    const merged = materialize(events);
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
const { validatePath, isExcluded } = load("planner.cjs");

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
  constructor(app) { this.app = app; this.vault = app.vault; }
  async scan() {
    const hashes = Object.create(null);
    for (const file of this.vault.getFiles()) {
      if (isExcluded(file.path)) continue;
      validatePath(file.path);
      if (file.stat.size > 100 * 1024 * 1024) throw new Error(`Файл больше 100 МБ: ${file.path}. Эта версия пока его не поддерживает.`);
      const data = await this.read(file.path);
      if (data !== null) hashes[file.path] = await sha256(data);
    }
    return hashes;
  }
  async read(path) {
    validatePath(path);
    const file = this.vault.getFileByPath(path);
    if (!file) return null;
    return bytes(await this.vault.readBinary(file));
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
    let file = this.vault.getFileByPath(path);
    const current = await this.read(path);
    if ((current === null ? null : await sha256(current)) !== expectedHash) return false;
    if (current !== null && await sha256(data) === expectedHash) return true;
    if (!file) {
      await this.folders(path);
      if (await this.vault.adapter.exists(path)) return false;
      try { await this.vault.createBinary(path, bytes(data).slice().buffer); }
      catch (error) { if (this.vault.getFileByPath(path)) return false; throw error; }
      return true;
    }
    await this.backup(path, current);
    if (file.extension === 'md') {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const oldText = decoder.decode(current), newText = decoder.decode(data);
      let changed = false;
      await this.vault.process(file, text => {
        if (text !== oldText) return text;
        changed = true;
        return newText;
      });
      return changed;
    }
    // A displayed binary may be edited by another plugin: defer replacement.
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    const recovery = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(recovery, true);
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    // Preserve the actual file, including an edit arriving after the hash check.
    await this.vault.rename(file, recovery);
    try { await this.vault.createBinary(path, bytes(data).slice().buffer); }
    catch (error) {
      if (!await this.vault.adapter.exists(path)) await this.vault.rename(file, path);
      return false;
    }
    return true;
  }
  async removeIfUnchanged(path, expectedHash) {
    validatePath(path);
    if (isExcluded(path) || this.app.workspace.getActiveFile()?.path === path) return false;
    const current = await this.read(path);
    if (current === null) return true;
    if (await sha256(current) !== expectedHash) return false;
    // Moving the actual current file into recovery retains late changes too.
    const file = this.vault.getFileByPath(path);
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    await this.vault.rename(file, target);
    return true;
  }
}
module.exports = { DeviceState, LocalVault };

},
"main.cjs": function(module, exports, load) {
'use strict';
const { Plugin, Modal, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');
const { Drive, sha256, parseFolderLink } = load("drive.cjs");
const { GoogleAuth } = load("auth.cjs");
const { LocalVault, DeviceState } = load("local.cjs");
const { SyncEngine } = load("engine.cjs");
const { validateCatalog } = load("team-plugins.cjs");
const config = ({
  "bridgeUrl": "https://easy-sync-login.fresh-grape-2058.chatgpt.site",
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
    const makeAuth = mode => {
      const secret = mode === 'team' ? `amygdala-connection-team-${this.device}` : `amygdala-connection-${this.device}`;
      const legacySecret = mode === 'team' ? `easy-sync-team-${this.device}` : `easy-sync-${this.device}`;
      return new GoogleAuth({ bridge: config.bridgeUrl, email: this.accountEmails[mode], mode, request: requestUrl,
        secrets: { get: () => this.legacyCompatibleSecret(secret, legacySecret), set: value => this.app.secretStorage.setSecret(secret, value) },
        getPending: () => { const s = this.legacyCompatibleSecret(`${secret}-pending`, `${legacySecret}-pending`); return s ? JSON.parse(s) : null; },
        savePending: p => this.app.secretStorage.setSecret(`${secret}-pending`, p ? JSON.stringify(p) : '') });
    };
    this.auth = makeAuth('personal');
    this.teamAuth = makeAuth('team');
    const completeLogin = params => {
      void (async () => {
        let failure;
        for (const mode of ['personal', 'team']) {
          try {
            const identity = await this.authFor(mode).complete(params);
            this.accountEmails[mode] = identity.email;
            this.authFor(mode).email = identity.email;
            this.app.saveLocalStorage(`amygdala-connection-account-${mode}`, identity.email);
            if (this.connection && (this.connection.kind === 'team' ? 'team' : 'personal') === mode) {
              this.connection.email = identity.email; this.app.saveLocalStorage('amygdala-connection-connection', this.connection);
            }
            this.setStatus(`Google подключён · ${mode === 'team' ? 'командный доступ' : 'личный режим'}`);
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
    this.addRibbonIcon('refresh-cw', 'Amygdala Connection', () => new ConnectModal(this).open());
    this.status = this.addStatusBarItem();
    this.status.addClass('easy-sync-status');
    this.status.addEventListener('click', () => new ConnectModal(this).open());
    this.addCommand({ id: 'connect', name: 'Подключить устройство', callback: () => new ConnectModal(this).open() });
    this.addCommand({ id: 'sync-now', name: 'Синхронизировать сейчас', callback: () => this.sync(true) });
    this.addCommand({ id: 'resolve-conflicts', name: 'Показать конфликты Amygdala Connection', callback: () => this.openConflicts() });
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
    this.label = text; this.status?.setText(`Amygdala Connection · ${text}`);
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
  authFor(mode) { return mode === 'team' ? this.teamAuth : this.auth; }
  drive(connection = this.connection, override = {}) {
    const mode = override.mode || (connection?.kind === 'team' ? 'team' : 'personal');
    const auth = this.authFor(mode);
    return new Drive({ request: requestUrl, getAccessToken: () => auth.accessToken(), mode,
      vaultId: mode === 'personal' ? connection?.id : null, folderId: mode === 'team' ? (override.folderId || connection?.id) : null,
    progress: progress => this.setProgress(progress) }); }
  async selectVault(vault) {
    if (this.running) throw new Error('Дождитесь окончания синхронизации.');
    const kind = vault.kind === 'team' ? 'team' : 'personal';
    this.connection = { kind, id: vault.id, name: vault.name, email: this.accountEmails[kind] || '',
      ...(kind === 'team' ? { actor: vault.actor || null, webViewLink: vault.webViewLink || `https://drive.google.com/drive/folders/${vault.id}` } : {}) };
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
    const mode = this.connection?.kind === 'team' ? 'team' : 'personal';
    await this.authFor(mode).disconnect(); this.accountEmails[mode] = null;
    this.app.saveLocalStorage(`amygdala-connection-account-${mode}`, null);
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
    el.createEl('h2', { text: p.connection?.kind === 'team' ? 'Командный цеттелькастен' : 'Amygdala Connection' });
    if (config.beta) el.createEl('p', { text: 'Закрытая beta: Google может попросить повторный вход примерно раз в неделю. Перед загрузкой подключайте копию vault.', cls: 'easy-sync-warning' });
    if (!config.bridgeUrl) {
      el.createEl('p', { text: 'Сервис входа ещё не подключён. Эта сборка подготовлена для проверки; облачная синхронизация пока недоступна.', cls: 'easy-sync-warning' });
      return;
    }
    if (p.connection) {
      el.createEl('h3', { text: p.connection.name });
      el.createEl('p', { text: `${p.connection.kind === 'team' ? 'Командное хранилище 0.2' : 'Личное хранилище 0.1'} · ${p.connection.email || 'Google не подключён'}` });
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
        .addButton(b => b.setButtonText('Переподключить').onClick(() => void this.beginLogin(p.connection.kind === 'team' ? 'team' : 'personal')));
      new Setting(el).setName('Отключить это устройство').setDesc('Заметки на устройстве и в облаке сохранятся.')
        .addButton(b => b.setButtonText('Отключить').onClick(async () => { try { await p.disconnect(); await this.render(); } catch (e) { p.report(e); } }));
      return;
    }
    const personalToken = p.legacyCompatibleSecret(`amygdala-connection-${p.device}`, `easy-sync-${p.device}`);
    const teamToken = p.legacyCompatibleSecret(`amygdala-connection-team-${p.device}`, `easy-sync-team-${p.device}`);
    if (!personalToken) new Setting(el).setName('Личное хранилище 0.1').setDesc('Подключается через служебный раздел вашего Google Drive.')
      .addButton(b => b.setButtonText('Войти в личный режим').onClick(() => void this.beginLogin('personal')));
    if (pers