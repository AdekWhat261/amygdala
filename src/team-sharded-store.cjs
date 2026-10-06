'use strict';

const { sha256 } = require('./drive.cjs');
const { validateRevision } = require('./journal.cjs');
const { sharedSheetsReadLimiter } = require('./sheets-read-limiter.cjs');
const { validateLegacyQuarantine, validateLegacyPathMap, visibleEvents } = require('./legacy-quarantine.cjs');
const { FENCE_RANGE, LIMITS, allocationMarker, hasFenceRange, assertFenceRange, namedSlots, parseFenceReceipt,
  fenceDigest, sourceRecordsDigest, migrationEpoch, fencedSlots,
  LOCK_PROTOCOL, LOCK_RANGE, ACTIVE_RANGE, hasLockRange, hasActivationRange, assertLockRange, assertActivationRange,
  parseSlotLock, parseSlotActivation, rootLockId, activationEpoch, lockedSlots } = require('./slot-fence.cjs');
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
const { validateCatalog } = require('./team-plugins.cjs');
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
  if (!root || root.type !== 'amygdala-team-sharded' || root.version !== 4 || root.schema !== 3 || root.rootId !== rootId
    || root.pathProtocol !== 'project-relative-v1' || root.namespace !== rootId
    || !ID.test(root.vaultId || '') || !ID.test(root.folderId || '') || !Array.isArray(root.shardIds)
    || root.shardIds.length !== 8 || new Set(root.shardIds).size !== 8 || root.shardIds.some(id => !ID.test(id) || id === rootId)
    || canonical(root.params) !== canonical(PARAMS) || !HASH.test(root.paramsDigest || '') || shards.length !== 8) {
    throw new Error('Манифест корневой таблицы v4 повреждён.');
  }
  for (let i = 0; i < 8; i++) {
    const shard = shards[i];
    if (!shard || shard.type !== 'amygdala-team-sharded' || shard.version !== 4 || shard.schema !== 3
      || shard.pathProtocol !== 'project-relative-v1' || shard.namespace !== rootId
      || shard.vaultId !== root.vaultId || shard.rootId !== rootId || shard.folderId !== root.folderId
      || shard.shardId !== root.shardIds[i] || shard.index !== i || shard.paramsDigest !== root.paramsDigest) {
      throw new Error(`Манифест сегмента ${i + 1} не соответствует корню v4.`);
    }
  }
  try {
    validateLegacyQuarantine(root);
    validateLegacyPathMap(root);
    if (new TextEncoder().encode(JSON.stringify(root)).byteLength > 48000) throw new Error('Manifest too large');
  }
  catch { throw new Error('?????? legacy quarantine v4 ?? ??????????????.'); }
}

/** v4 stores immutable payloads in fixed slots and publishes only confirmed root commits. */
class TeamShardedStore {
  static async provision({ request, getAccessToken, refreshAccessToken = null, limiter = sharedSheetsReadLimiter(), readIntent, writeIntent, name }) {
    if (typeof readIntent !== 'function' || typeof writeIntent !== 'function') throw new Error('Для создания v4 нужен устойчивый локальный журнал.');
    const cleanName = String(name || '').trim().slice(0, 160) || 'Командные заметки';
    let intent = await readIntent();
    if (intent?.creating) throw new Error('Предыдущий запрос создания v4 имеет неизвестный результат. Создание остановлено во избежание дубликата.');
    if (intent && (intent.schema !== 2 || intent.pathProtocol !== 'project-relative-v1' || intent.name !== cleanName || !ID.test(intent.vaultId || '')))
      throw new Error('Сохранённая операция создания v4 относится к другому хранилищу.');
    intent ||= { schema: 2, pathProtocol: 'project-relative-v1', name: cleanName, vaultId: globalThis.crypto.randomUUID(), folderId: null,
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
        ? { schema: 3, pathProtocol: 'project-relative-v1', namespace: intent.rootId, type: 'amygdala-team-sharded', version: 4, name: cleanName, vaultId: intent.vaultId,
          rootId: intent.rootId, folderId: intent.folderId, shardIds: [...intent.shardIds], params: PARAMS, paramsDigest }
        : { schema: 3, pathProtocol: 'project-relative-v1', namespace: intent.rootId, type: 'amygdala-team-sharded', version: 4, vaultId: intent.vaultId, rootId: intent.rootId,
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
    this.fenceReceipts = new Map(); this.fenceEpoch = null;
    this.slotLockId = null; this.slotActivation = null;
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
      // Keep only a bounded classification; never persist the raw server error or request.
      const serverMessage = response.json?.error?.message;
      error.googleDuplicateNamedRange = response.status === 400 && typeof serverMessage === 'string'
        && /addNamedRange|named range/i.test(serverMessage) && /already exists|duplicate/i.test(serverMessage);
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
  async fenceReceiptFor(id) {
    return parseFenceReceipt((await this.values(id, FENCE_RANGE)).values || []);
  }
  async slotLockFor(id) {
    return parseSlotLock((await this.values(id, LOCK_RANGE)).values || []);
  }
  async slotActivationFor(id = this.rootId) {
    return parseSlotActivation((await this.values(id, ACTIVE_RANGE)).values || []);
  }
  async verifyFencePayloads(id, kind, receipt, metadata, { epoch = receipt.epoch || this.fenceEpoch } = {}) {
    const sets = receipt.protocol === LOCK_PROTOCOL ? lockedSlots(metadata, kind, receipt) : fencedSlots(metadata, kind, receipt);
    const records = await this.verifiedSlots(id, kind, receipt.sourceSlots);
    if (await sourceRecordsDigest(receipt.sourceSlots, records) !== receipt.sourceRecordsDigest)
      throw new Error('Исходная история миграции изменилась. Синхронизация остановлена.');
    const freshSlots = [...sets.fresh].sort((a, b) => a - b);
    const freshRecords = await this.verifiedSlots(id, kind, freshSlots);
    for (const record of freshRecords) {
      if (!epoch || record.header.epoch !== epoch || !record.header.opId.startsWith(`${kind === 'C' ? 'commit' : 'blob'}_${epoch}_`)
        || (kind === 'C' && this.decodeCommit(record).epoch !== epoch))
        throw new Error('Новая запись не содержит подтверждённую эпоху миграции.');
    }
    // Reservations have no payload. Read contiguous gaps in batches rather than
    // interpreting them as records, and reject an unmarked late legacy write.
    const gaps = [];
    for (let slot = 0; slot < LIMITS[kind].physical;) {
      if (sets.occupied.has(slot)) { slot++; continue; }
      const first = slot;
      while (slot < LIMITS[kind].physical && !sets.occupied.has(slot)) slot++;
      gaps.push(`Payload!A${2 + first * LIMITS[kind].blocks}:B${1 + slot * LIMITS[kind].blocks}`);
    }
    for (let offset = 0; offset < gaps.length; offset += 32) {
      const ranges = gaps.slice(offset, offset + 32), query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
      for (const range of ranges) query.append('ranges', range);
      const result = await this.call(`${SHEETS}/${id}/values:batchGet?${query}`);
      if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== ranges.length
        || result.valueRanges.some(range => (range.values || []).some(row => row.some(value => value !== '' && value !== null))))
        throw new Error('В зарезервированном слоте найдена запись старого клиента. Синхронизация остановлена.');
    }
    return { ...sets, records, freshRecords };
  }
  async resolveSlotLockState({ root, shards, metadata }) {
    if (metadata.some(hasFenceRange) || !metadata.every(hasLockRange) || !hasActivationRange(metadata[0])
      || metadata.slice(1).some(hasActivationRange))
      throw new Error('Хранилище заблокировано для миграции. Ожидается проверка копии и отдельное подтверждение активации.');
    metadata.forEach(assertLockRange); assertActivationRange(metadata[0]);
    const ids = [this.rootId, ...root.shardIds];
    const [locks, active] = await Promise.all([Promise.all(ids.map(id => this.slotLockFor(id))), this.slotActivationFor()]);
    const control = locks[0];
    if (control.kind !== 'root' || control.lockId !== await rootLockId(control)
      || active.rootId !== this.rootId || active.lockId !== control.lockId || active.rootLockDigest !== await fenceDigest(control)
      || active.epoch !== await activationEpoch(active) || active.sourceFingerprint === control.sourceFingerprint
      || active.backupBundleSha256 === control.backupBundleSha256)
      throw new Error('Активация не соответствует заблокированному хранилищу и его новой резервной копии.');
    assertManifest(control.targetRoot, control.targetShards, this.rootId);
    const rawManifests = [root, ...shards];
    for (let index = 0; index < ids.length; index++) {
      const lock = locks[index], raw = rawManifests[index];
      if (lock.rootId !== this.rootId || lock.spreadsheetId !== ids[index] || lock.lockId !== control.lockId
        || lock.kind !== (index === 0 ? 'root' : 'shard') || raw.schema !== 2
        || lock.sourceManifestDigest !== await fenceDigest(raw))
        throw new Error('Блокировка относится к другому сегменту или исходный манифест изменился.');
      const meta = metadata[index].sheets?.find(item => item.properties?.sheetId === 1)?.properties;
      if (!(meta?.gridProperties?.rowCount >= (index === 0 ? 4 : 3)) || !(meta?.gridProperties?.columnCount >= 2))
        throw new Error('Таблица не содержит полной записи блокировки или активации.');
      if (index > 0) {
        const baseline = control.approvedShards[index - 1], proof = active.shardReceiptDigests[index - 1];
        if (baseline.spreadsheetId !== ids[index] || baseline.sourceManifestDigest !== lock.sourceManifestDigest
          || canonical(baseline.sourceSlots) !== canonical(lock.approvedSourceSlots)
          || baseline.sourceRecordsDigest !== lock.approvedSourceRecordsDigest
          || proof.spreadsheetId !== ids[index] || proof.digest !== await fenceDigest(lock))
          throw new Error('Сегмент не сохраняет утверждённые исходные данные или относится к другой активации.');
      }
      const target = index === 0 ? control.targetRoot : control.targetShards[index - 1];
      const reconstructed = { ...target, schema: 2 };
      delete reconstructed.pathProtocol; delete reconstructed.namespace;
      if (index === 0) { delete reconstructed.legacyQuarantine; delete reconstructed.legacyPathMap; }
      if (canonical(reconstructed) !== canonical(raw) || raw.pathProtocol !== undefined || raw.namespace !== undefined
        || raw.legacyQuarantine !== undefined || raw.legacyPathMap !== undefined)
        throw new Error('Миграция меняет поля за пределами утверждённой схемы.');
    }
    const checked = await Promise.all(ids.map((id, index) => this.verifyFencePayloads(id, index === 0 ? 'C' : 'D', locks[index],
      metadata[index], { epoch: active.epoch })));
    for (let index = 1; index < locks.length; index++) {
      const lock = locks[index], bySlot = new Map(lock.sourceSlots.map((slot, offset) => [slot, checked[index].records[offset]]));
      if (await sourceRecordsDigest(lock.approvedSourceSlots, lock.approvedSourceSlots.map(slot => bySlot.get(slot))) !== lock.approvedSourceRecordsDigest)
        throw new Error('Утверждённые исходные вложения изменились при блокировке.');
    }
    this.assertLegacyPartition(control, checked[0].records);
    this.fenceReceipts = new Map(ids.map((id, index) => [id, clone(locks[index])]));
    this.slotLockId = control.lockId; this.slotActivation = clone(active); this.fenceEpoch = active.epoch;
    return { root: clone(control.targetRoot), shards: clone(control.targetShards) };
  }
  assertLegacyPartition(control, records) {
    const sourceEvents = new Map();
    for (const record of records) {
      const commit = this.decodeCommit(record);
      if (commit.epoch !== undefined) throw new Error('Исходная история уже содержит новую эпоху.');
      for (const raw of commit.events) {
        const event = validateRevision(raw);
        if (sourceEvents.has(event.id)) throw new Error('Исходная история содержит повтор идентификатора.');
        sourceEvents.set(event.id, event);
      }
    }
    const hidden = validateLegacyQuarantine(control.targetRoot), mapping = validateLegacyPathMap(control.targetRoot);
    const mapped = mapping?.revisionIds || new Set();
    if (hidden.size + mapped.size !== sourceEvents.size || [...hidden, ...mapped].some(id => !sourceEvents.has(id))
      || (mapping && mapping.prefix !== control.scopePath)) throw new Error('Миграция не охватывает всю исходную историю.');
    for (const event of sourceEvents.values()) {
      const included = event.path.startsWith(`${control.scopePath}/`);
      if (included !== mapped.has(event.id) || event.parents.some(id => mapped.has(id) !== included))
        throw new Error('Область миграции пересекает личную историю или цепочку изменений.');
    }
    visibleEvents([...sourceEvents.values()], control.targetRoot);
  }
  async resolveFenceState({ root, shards, metadata }) {
    this.fenceReceipts = new Map(); this.fenceEpoch = null;
    this.slotLockId = null; this.slotActivation = null;
    if (metadata.some(sheet => hasLockRange(sheet) || hasActivationRange(sheet)))
      return this.resolveSlotLockState({ root, shards, metadata });
    const flags = metadata.map(hasFenceRange);
    if (!flags.some(Boolean)) {
      if (metadata.some(sheet => (sheet.namedRanges || []).some(item => /^AS5_[DC]_/.test(item.name || ''))))
        throw new Error('Записи нового протокола не имеют защиты миграции.');
      return { root, shards };
    }
    if (flags.some(flag => !flag)) throw new Error('Миграция завершена не во всех таблицах. Синхронизация остановлена.');
    for (const sheet of metadata) assertFenceRange(sheet);
    const ids = [this.rootId, ...root.shardIds];
    const receipts = await Promise.all(ids.map(id => this.fenceReceiptFor(id)));
    const control = receipts[0];
    if (control.kind !== 'root' || control.epoch !== await migrationEpoch(control))
      throw new Error('Контрольная запись миграции не соответствует утверждённому плану.');
    const rawManifests = [root, ...shards];
    for (let index = 0; index < ids.length; index++) {
      const receipt = receipts[index], raw = rawManifests[index];
      if (receipt.rootId !== this.rootId || receipt.spreadsheetId !== ids[index] || receipt.epoch !== control.epoch
        || receipt.kind !== (index === 0 ? 'root' : 'shard') || raw.schema !== 2
        || receipt.sourceManifestDigest !== await fenceDigest(raw))
        throw new Error('Исходный манифест или защита сегмента миграции изменились.');
      if (index > 0 && (control.shardReceiptDigests[index - 1].spreadsheetId !== ids[index]
        || control.shardReceiptDigests[index - 1].digest !== await fenceDigest(receipt)))
        throw new Error('Сегмент относится к другому плану миграции.');
      const target = index === 0 ? control.targetRoot : control.targetShards[index - 1];
      const reconstructed = { ...target, schema: 2 };
      delete reconstructed.pathProtocol; delete reconstructed.namespace;
      if (index === 0) { delete reconstructed.legacyQuarantine; delete reconstructed.legacyPathMap; }
      if (canonical(reconstructed) !== canonical(raw) || raw.pathProtocol !== undefined || raw.namespace !== undefined
        || raw.legacyQuarantine !== undefined || raw.legacyPathMap !== undefined)
        throw new Error('Миграция меняет поля за пределами утверждённой схемы.');
    }
    assertManifest(control.targetRoot, control.targetShards, this.rootId);
    const checked = await Promise.all(ids.map((id, index) => this.verifyFencePayloads(id, index === 0 ? 'C' : 'D', receipts[index], metadata[index])));
    const sourceEvents = new Map();
    for (const record of checked[0].records) {
      const commit = this.decodeCommit(record);
      if (commit.epoch !== undefined) throw new Error('Исходная история уже содержит новую эпоху.');
      for (const raw of commit.events) {
        const event = validateRevision(raw);
        if (sourceEvents.has(event.id)) throw new Error('Исходная история содержит повтор идентификатора.');
        sourceEvents.set(event.id, event);
      }
    }
    const hidden = validateLegacyQuarantine(control.targetRoot), mapping = validateLegacyPathMap(control.targetRoot);
    const mapped = mapping?.revisionIds || new Set();
    if (hidden.size + mapped.size !== sourceEvents.size || [...hidden, ...mapped].some(id => !sourceEvents.has(id))
      || (mapping && mapping.prefix !== control.scopePath)) throw new Error('Миграция не охватывает всю исходную историю.');
    for (const event of sourceEvents.values()) {
      const included = event.path.startsWith(`${control.scopePath}/`);
      if (included !== mapped.has(event.id) || event.parents.some(id => mapped.has(id) !== included))
        throw new Error('Область миграции пересекает личную историю или цепочку изменений.');
    }
    visibleEvents([...sourceEvents.values()], control.targetRoot);
    this.fenceReceipts = new Map(ids.map((id, index) => [id, clone(receipts[index])]));
    this.fenceEpoch = control.epoch;
    return { root: clone(control.targetRoot), shards: clone(control.targetShards) };
  }
  decodeCommit({ header, payload }) {
    if (typeof header.opId !== 'string' || header.key !== header.opId) throw new Error('Некорректный коммит v4.');
    let commit;
    try { commit = JSON.parse(decoder.decode(payload)); } catch { throw new Error('Повреждён коммит v4.'); }
    if (!commit || !Array.isArray(commit.events) || commit.events.length < 1
      || commit.events.length > PARAMS.maxEventsPerCommit || commit.opId !== header.opId) throw new Error('Некорректная история v4.');
    return commit;
  }
  async assertAccess() {
    this.blobIndex = null; this.blobIndexPromise = null; this.eventIndex = null; this.eventIndexCount = null;
    this.slotCache.clear();
    let root = await this.manifestFor(this.rootId);
    if (!Array.isArray(root?.shardIds) || root.shardIds.length !== 8) throw new Error('Некорректный список сегментов v4.');
    const ids = [this.rootId, ...root.shardIds.map(validId)];
    if (new Set(ids).size !== 9) throw new Error('Повторяющийся ID таблицы v4.');
    const [files, rawShards, metadata] = await Promise.all([
      Promise.all(ids.map(id => this.file(id))),
      Promise.all(root.shardIds.map(id => this.manifestFor(id))),
      Promise.all(ids.map(id => this.spreadsheet(id)))
    ]);
    const resolved = await this.resolveFenceState({ root, shards: rawShards, metadata });
    root = resolved.root;
    assertManifest(root, resolved.shards, this.rootId);
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
      if (this.fenceEpoch && !operation.opId.startsWith(`${operation.kind === 'C' ? 'commit' : 'blob'}_${this.fenceEpoch}_`))
        throw new Error('Незавершённая операция относится к старой эпохе. Требуется безопасное восстановление.');
      const info = metadata[ids.indexOf(operation.spreadsheetId)];
      if (this.slots(info, operation.kind).has(operation.slot)) {
        const found = await this.verifiedSlot(operation.spreadsheetId, operation.kind, operation.slot);
        if (found.header.opId === operation.opId && found.header.hash === operation.payloadHash
          && sameBytes(found.payload, unb64(operation.payload))) await this.operationJournal.ack(operation.opId);
        // Another writer may have won this slot. Keep our durable operation for a new slot.
      }
    }
    return { id: this.rootId, rootId: this.rootId, vaultId: root.vaultId, folderId: root.folderId,
      shardIds: [...root.shardIds], version: 4, kind: 'team', pathProtocol: root.pathProtocol, namespace: root.namespace, name: root.name || 'Командные заметки' };
  }
  async assertScopeProtocol() {
    const info = await this.assertAccess();
    return { pathProtocol: info.pathProtocol, namespace: info.namespace };
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
    const receipt = this.fenceReceipts.get(metadata?.spreadsheetId);
    if (receipt?.protocol === LOCK_PROTOCOL) return lockedSlots(metadata, kind, receipt).occupied;
    if (receipt) return fencedSlots(metadata, kind, receipt).occupied;
    if (hasFenceRange(metadata) || hasLockRange(metadata) || hasActivationRange(metadata)
      || (metadata?.namedRanges || []).some(item => /^AS5_[DC]_/.test(item.name || '')))
      throw new Error('Защита миграции ещё не проверена.');
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
    const epoch = this.fenceEpoch;
    if (encoder.encode(JSON.stringify({ opId: `commit_${epoch ? `${epoch}_` : ''}${'0'.repeat(64)}`, events: revisions,
      ...(epoch ? { epoch } : {}) })).length > PARAMS.commitBlocks * PARAMS.commitBlockBytes)
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
          || (header.opId !== `blob_${EMPTY_HASH}_0` && (!HASH.test(header.epoch || '') || header.opId !== `blob_${header.epoch}_${EMPTY_HASH}_0`))
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
  async verifiedSlots(id, kind, slots, onProgress = () => {}, { preserveRaw = false } = {}) {
    const found = [];
    const rows = kind === 'D' ? PARAMS.dataChunks : PARAMS.commitBlocks;
    for (let i = 0; i < slots.length; i += 32) {
      const group = slots.slice(i, i + 32), missing = group.filter(slot => {
        const cached = this.slotCache.get(`${id}:${kind}:${slot}`);
        return !cached || (preserveRaw && !Array.isArray(cached.rawRows));
      });
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
          this.slotCache.set(`${id}:${kind}:${missing[j]}`, preserveRaw
            ? { ...parsed, rawRows: structuredClone(result.valueRanges[j].values || []) } : parsed);
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
    const receipt = this.fenceReceipts.get(id);
    const claimMarker = slot => allocationMarker(kind, slot, receipt ? 'AS5' : 'AS4');
    if (receipt) {
      if ((receipt.protocol === LOCK_PROTOCOL ? receipt.lockId !== this.slotLockId || !this.slotActivation : receipt.epoch !== this.fenceEpoch)
        || !header.opId.startsWith(`${kind === 'C' ? 'commit' : 'blob'}_${this.fenceEpoch}_`))
        throw new Error('Запись относится к другой эпохе миграции.');
      if (kind === 'C') {
        let commit;
        try { commit = JSON.parse(decoder.decode(payload)); } catch { throw new Error('Повреждён новый коммит.'); }
        if (commit.epoch !== this.fenceEpoch || commit.opId !== header.opId) throw new Error('Новый коммит не содержит эпоху миграции.');
      }
      header = { ...header, epoch: this.fenceEpoch };
    }
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
        { addNamedRange: { namedRange: { namedRangeId: claimMarker(slot), name: claimMarker(slot),
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
          if (metadata && !metadata.namedRanges?.some(item => item.namedRangeId === claimMarker(slot))) {
            metadata.namedRanges ||= [];
            metadata.namedRanges.push({ namedRangeId: claimMarker(slot), name: claimMarker(slot),
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
      const indexedSlots = sheet => {
        const receipt = this.fenceReceipts.get(sheet.spreadsheetId);
        return receipt?.protocol === LOCK_PROTOCOL ? lockedSlots(sheet, 'D', receipt).active : this.slots(sheet, 'D');
      };
      const total = this.shards.reduce((sum, sheet) => sum + indexedSlots(sheet).size, 0);
      let completed = 0;
      this.progress({ phase: 'index', completed, total });
      for (let shard = 0; shard < PARAMS.shards; shard++) {
        const occupied = [...indexedSlots(this.shards[shard])].sort((a, b) => a - b);
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
        const opId = `blob_${this.fenceEpoch ? `${this.fenceEpoch}_` : ''}${hash}_${part}`;
        const pendingId = this.operationJournal?.pending(opId)?.spreadsheetId;
      const target = pendingId ? candidates.find(item => item.id === pendingId) : candidates.find(item => item.used < PARAMS.shardDataClaims);
        if (!target) throw new Error('Свободных слотов данных v4 нет.');
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
    const receipt = this.fenceReceipts.get(this.rootId);
    if (receipt) await this.verifyFencePayloads(this.rootId, 'C', receipt, this.rootMetadata);
    const occupied = [...this.slots(this.rootMetadata, 'C')].sort((a, b) => a - b);
    if (this.eventIndex && this.eventIndexCount === occupied.length) return visibleEvents([...this.eventIndex.values()], this.manifest).map(clone);
    const events = new Map();
    let completed = 0;
    this.progress({ phase: 'history', completed, total: occupied.length });
    const records = await this.verifiedSlots(this.rootId, 'C', occupied, count => {
      completed += count; this.progress({ phase: 'history', completed, total: occupied.length });
    });
    for (let index = 0; index < records.length; index++) {
      const { header } = records[index], commit = this.decodeCommit(records[index]);
      if (receipt && !receipt.sourceSlots.includes(occupied[index]) && (commit.epoch !== this.fenceEpoch
        || header.epoch !== this.fenceEpoch || !header.opId.startsWith(`commit_${this.fenceEpoch}_`)))
        throw new Error('Обнаружен коммит без подтверждённой эпохи миграции.');
      for (const raw of commit.events) {
        const event = validateRevision(raw), previous = events.get(event.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Разные события v4 имеют одинаковый ID.');
        events.set(event.id, event);
      }
    }
    this.eventIndex = events; this.eventIndexCount = occupied.length;
    const quarantine = validateLegacyQuarantine(this.manifest);
    if ([...quarantine].some(id => !events.has(id))) throw new Error('??????? legacy quarantine ID ??????? ?? ?????? v4.');
    return visibleEvents([...events.values()], this.manifest).map(clone);
  }
  async putEvent(event) { await this.putEvents([event]); }
  async putEvents(input) {
    await this.listEvents();
    const known = new Map([...(this.eventIndex?.values() || [])].map(event => [event.id, event]));
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
      const opId = `commit_${this.fenceEpoch ? `${this.fenceEpoch}_` : ''}${await digest(events)}`;
      const payload = encoder.encode(JSON.stringify({ opId, events, ...(this.fenceEpoch ? { epoch: this.fenceEpoch } : {}) }));
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
