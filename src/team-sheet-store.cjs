'use strict';

const { sha256 } = require('./drive.cjs');

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
    if (this.events) return this.events.map(event => JSON.parse(JSON.stringify(event)));
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
    if (this.blobIndex) return this.blobIndex;
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
