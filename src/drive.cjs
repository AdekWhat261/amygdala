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
