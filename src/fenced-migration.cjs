'use strict';

const { previewSchema2Migration } = require('./legacy-migration-preview.cjs');
const { buildVerifiedBackup } = require('./verified-backup.cjs');
const { assertManifest, TeamShardedStore } = require('./team-sharded-store.cjs');
const { validateRevision } = require('./journal.cjs');
const { FENCE_PROTOCOL, FENCE_RANGE_NAME, FENCE_ROW_KEY, FENCE_RANGE, LIMITS,
  canonical, fenceDigest, allocationMarker, namedSlots, hasFenceRange, assertFenceRange,
  parseFenceReceipt, validateFenceReceipt, sourceRecordsDigest, migrationEpoch, fencedSlots } = require('./slot-fence.cjs');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const fail = message => { throw new Error(message); };
const same = (left, right) => canonical(left) === canonical(right);
const clone = value => JSON.parse(JSON.stringify(value));

/** Prepare immutable receipts from an already verified, complete source snapshot. No I/O. */
async function prepareFencedMigration(snapshot, { scopePath = snapshot?.localScope } = {}) {
  if (!snapshot?.stableSnapshot || snapshot.remoteWrites !== 0 || !snapshot.backupSnapshot
    || snapshot.backupSnapshot.fingerprint !== snapshot.fingerprint
    || scopePath !== snapshot.localScope || snapshot.migrationState !== 'source')
    fail('Для подготовки нужен полный стабильный снимок исходного проекта и его резервная копия.');
  const backup = await buildVerifiedBackup(snapshot.backupSnapshot);
  const byId = new Map(backup.sheets.map(sheet => [sheet.id, sheet]));
  const sourceRoot = byId.get(snapshot.root?.rootId)?.manifest;
  const sourceShards = snapshot.root?.shardIds?.map(id => byId.get(id)?.manifest);
  if (!same(snapshot.root, sourceRoot) || !same(snapshot.shards, sourceShards))
    fail('Сведения снимка не совпали с проверенной резервной копией.');
  const reader = new TeamShardedStore({ rootId: sourceRoot.rootId,
    request: async () => { throw new Error('Preparation cannot access a network'); },
    getAccessToken: async () => { throw new Error('Preparation cannot access authorization'); } });
  const actualEvents = [];
  for (const item of byId.get(sourceRoot.rootId).slots) {
    const commit = reader.decodeCommit(reader.decodeSlot(item.rows, 'C'));
    if (commit.epoch !== undefined) fail('Исходная копия уже содержит другую эпоху.');
    actualEvents.push(...commit.events.map(validateRevision));
  }
  const eventOrder = events => [...events].map(validateRevision).sort((a, b) => a.id.localeCompare(b.id));
  if (!Array.isArray(snapshot.events) || !same(eventOrder(actualEvents), eventOrder(snapshot.events)))
    fail('История снимка не совпала с проверенной резервной копией.');
  const preview = previewSchema2Migration({ root: snapshot.root, shards: snapshot.shards,
    events: snapshot.events, scopePath });
  const seed = { sourceFingerprint: snapshot.fingerprint, scopePath,
    targetRoot: preview.rootManifest, targetShards: preview.shardManifests };
  const epoch = await migrationEpoch(seed);
  const rootId = snapshot.root.rootId;
  const receipts = [];
  for (const id of [...snapshot.root.shardIds, rootId]) {
    const sheet = backup.sheets.find(item => item.id === id), kind = id === rootId ? 'C' : 'D';
    if (!sheet || hasFenceRange(sheet.metadata) || namedSlots(sheet.metadata, kind, 'AS5').size)
      fail('Исходный проект уже содержит защиту другой миграции.');
    const sourceSlots = [...namedSlots(sheet.metadata, kind)].sort((a, b) => a - b);
    if (!same(sourceSlots, [...sheet.occupiedSlots].sort((a, b) => a - b)))
      fail('Список исходных слотов не совпал с резервной копией.');
    const records = sourceSlots.map(slot => {
      const item = sheet.slots.find(record => record.slot === slot);
      return { header: JSON.parse(item.rows[0][0]) };
    });
    const receipt = { protocol: FENCE_PROTOCOL, epoch, kind: kind === 'C' ? 'root' : 'shard',
      rootId, spreadsheetId: id, sourceManifestDigest: await fenceDigest(sheet.manifest),
      sourceSlots, sourceRecordsDigest: await sourceRecordsDigest(sourceSlots, records) };
    if (kind === 'C') Object.assign(receipt, seed, {
      shardReceiptDigests: await Promise.all(receipts.map(async item => ({
        spreadsheetId: item.spreadsheetId, digest: await fenceDigest(item) })))
    });
    validateFenceReceipt(receipt);
    receipts.push(receipt);
  }
  return Object.freeze({ protocol: FENCE_PROTOCOL, rootId, folderId: snapshot.root.folderId,
    shardIds: [...snapshot.root.shardIds], sourceFingerprint: snapshot.fingerprint, scopePath, epoch,
    backupBundleSha256: backup.bundleSha256, receipts: clone(receipts), report: preview.report,
    sourceSheets: backup.sheets.map(sheet => ({ id: sheet.id, metadata: clone(sheet.metadata),
      fileMetadata: clone(sheet.fileMetadata) })),
    teamPluginsDigest: await fenceDigest(byId.get(rootId).teamPluginsRows),
    remoteWrites: 0 });
}

async function validatePlan(plan) {
  if (!plan || plan.protocol !== FENCE_PROTOCOL || plan.remoteWrites !== 0
    || !Array.isArray(plan.receipts) || plan.receipts.length !== 9
    || !Array.isArray(plan.shardIds) || plan.shardIds.length !== 8
    || new Set([plan.rootId, ...plan.shardIds]).size !== 9
    || !Array.isArray(plan.sourceSheets) || plan.sourceSheets.length !== 9
    || new Set(plan.sourceSheets.map(sheet => sheet.id)).size !== 9
    || !/^[a-f0-9]{64}$/.test(plan.teamPluginsDigest || '')
    || !/^[a-f0-9]{64}$/.test(plan.backupBundleSha256 || ''))
    fail('План миграции отсутствует или повреждён.');
  const root = plan.receipts[8];
  for (const receipt of plan.receipts) validateFenceReceipt(receipt);
  assertManifest(root.targetRoot, root.targetShards, plan.rootId);
  if (root.kind !== 'root' || root.spreadsheetId !== plan.rootId
    || root.sourceFingerprint !== plan.sourceFingerprint || root.scopePath !== plan.scopePath
    || root.targetRoot.folderId !== plan.folderId || !same(root.targetRoot.shardIds, plan.shardIds)
    || await migrationEpoch(root) !== plan.epoch || root.epoch !== plan.epoch)
    fail('План не соответствует согласованной области и снимку.');
  const targets = [...root.targetShards, root.targetRoot];
  for (let index = 0; index < 9; index++) {
    const source = { ...targets[index], schema: 2 };
    delete source.pathProtocol; delete source.namespace;
    if (index === 8) { delete source.legacyQuarantine; delete source.legacyPathMap; }
    if (await fenceDigest(source) !== plan.receipts[index].sourceManifestDigest)
      fail('План меняет поля за пределами согласованной схемы.');
    const receipt = plan.receipts[index], sheet = plan.sourceSheets.find(item => item.id === receipt.spreadsheetId);
    const kind = receipt.kind === 'root' ? 'C' : 'D';
    if (!sheet || sheet.metadata?.spreadsheetId !== sheet.id || sheet.fileMetadata?.id !== sheet.id
      || !same(sheet.fileMetadata.parents, [plan.folderId]) || hasFenceRange(sheet.metadata)
      || namedSlots(sheet.metadata, kind, 'AS5').size
      || !same([...namedSlots(sheet.metadata, kind)].sort((a, b) => a - b), receipt.sourceSlots))
      fail('Исходная структура таблиц не соответствует согласованному плану.');
  }
  for (let index = 0; index < 8; index++) {
    const shard = plan.receipts[index], proof = root.shardReceiptDigests[index];
    if (shard.kind !== 'shard' || shard.rootId !== plan.rootId || shard.epoch !== plan.epoch
      || shard.spreadsheetId !== plan.shardIds[index] || proof.spreadsheetId !== shard.spreadsheetId
      || await fenceDigest(shard) !== proof.digest) fail('План защиты сегментов не совпал с основной таблицей.');
  }
  return root;
}

/** A lost response is reconciled by immutable receipt readback; a restart uses the same plan. */
async function executeFencedMigration({ plan, adapter, approved = false, syncPaused = false,
  approvalFingerprint, backupProof, atomicFenceProof } = {}) {
  await validatePlan(plan);
  if (approved !== true || syncPaused !== true || approvalFingerprint !== plan.sourceFingerprint)
    fail('Нужны остановленная синхронизация и отдельное разрешение для точного снимка.');
  if (backupProof?.verified !== true || backupProof.bundleSha256 !== plan.backupBundleSha256
    || backupProof.sourceFingerprint !== plan.sourceFingerprint || backupProof.projectRootId !== plan.rootId)
    fail('Восстановление резервной копии этого снимка ещё не проверено.');
  if (atomicFenceProof?.verified !== true || atomicFenceProof.projectRootId !== plan.rootId
    || atomicFenceProof.sourceFingerprint !== plan.sourceFingerprint
    || atomicFenceProof.operation !== 'duplicate-named-range-atomic-rejection'
    || !/^[a-f0-9]{64}$/.test(atomicFenceProof.proofDigest || ''))
    fail('Атомарный отказ при повторном маркере ещё не проверен в Google Sheets.');
  if (!adapter || ['readState', 'claimFence', 'verifyActivation'].some(name => typeof adapter[name] !== 'function'))
    fail('Адаптер безопасной миграции недоступен.');
  // Detect already changed root/history before reserving any data shard.
  for (const receipt of plan.receipts) {
    const state = await adapter.readState(receipt);
    if (!['source', 'fenced'].includes(state?.state)) fail('Неизвестное состояние миграции.');
  }
  let writes = 0;
  // Fence data allocation first. Root activation must be the last remote operation.
  for (const receipt of plan.receipts) {
    const before = await adapter.readState(receipt);
    if (before.state === 'fenced') continue;
    if (before.state !== 'source') fail('Неизвестное состояние миграции; запись остановлена.');
    let error;
    try { await adapter.claimFence(receipt); } catch (caught) { error = caught; }
    const after = await adapter.readState(receipt);
    if (after.state !== 'fenced') {
      if (error) throw error;
      fail('Google не подтвердил защиту. Повторите проверку перед продолжением.');
    }
    writes++;
  }
  const result = await adapter.verifyActivation(plan);
  if (result?.epoch !== plan.epoch || result?.pathProtocol !== 'project-relative-v1'
    || result?.namespace !== plan.rootId) fail('Проверка результата миграции не прошла.');
  return Object.freeze({ state: 'complete', epoch: plan.epoch, writes, sourceFingerprint: plan.sourceFingerprint,
    rawManifestUpdates: 0, originalPayloadUpdates: 0 });
}

/** Approved negative probe on the existing root. Expected duplicate ID prevents every update. */
async function probeGoogleFenceAtomicity({ store, plan, approved = false, approvalFingerprint } = {}) {
  await validatePlan(plan);
  if (approved !== true || approvalFingerprint !== plan.sourceFingerprint)
    fail('Проверка Google требует разрешения для точного снимка проекта.');
  const adapter = createGoogleFenceAdapter({ store, plan });
  const receipt = plan.receipts[8];
  const before = await adapter.readState(receipt);
  if (before.state !== 'source') fail('Проверку атомарного отказа нужно выполнить до активации основной таблицы.');
  const existing = before.metadata.namedRanges?.find(item => item.name.startsWith('AS4_C_') && item.namedRangeId);
  if (!existing) fail('Нет исходного маркера для проверки атомарного отказа.');
  const sentinel = { protocol: 'amygdala-atomicity-probe-v1', rootId: plan.rootId,
    sourceFingerprint: plan.sourceFingerprint, nonce: globalThis.crypto.randomUUID() };
  const requests = [{ updateCells: {
    range: { sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 },
    rows: [{ values: [{ userEnteredValue: { stringValue: 'atomicFenceProbe' } },
      { userEnteredValue: { stringValue: JSON.stringify(sentinel) } }] }], fields: 'userEnteredValue'
  } }, { addNamedRange: { namedRange: clone(existing) } }];
  let rejected;
  try { await store.batch(plan.rootId, requests); } catch (error) { rejected = error; }
  // Never automatically retry an unknown result or erase a sentinel after a server violation.
  const after = await adapter.readState(receipt);
  if (rejected?.status !== 400 || rejected.googleDuplicateNamedRange !== true || after.state !== 'source')
    fail('Google не подтвердил атомарный отказ. Миграция остановлена для проверки.');
  return Object.freeze({ verified: true, projectRootId: plan.rootId, sourceFingerprint: plan.sourceFingerprint,
    operation: 'duplicate-named-range-atomic-rejection',
    proofDigest: await fenceDigest({ sentinel, duplicateMarker: existing, observedStatus: rejected.status,
      sourceManifestDigest: receipt.sourceManifestDigest, sourceRecordsDigest: receipt.sourceRecordsDigest }),
    remoteWritesApplied: 0, requestsAttempted: 1 });
}

async function requireBlankSlots(store, id, kind, slots) {
  const blocks = LIMITS[kind].blocks;
  const ranges = [];
  const ordered = [...slots].sort((a, b) => a - b);
  for (let at = 0; at < ordered.length;) {
    const first = ordered[at++]; let last = first;
    while (at < ordered.length && ordered[at] === last + 1) last = ordered[at++];
    ranges.push(`Payload!A${2 + first * blocks}:B${1 + (last + 1) * blocks}`);
  }
  for (let offset = 0; offset < ranges.length; offset += 32) {
    const group = ranges.slice(offset, offset + 32), query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
    for (const range of group) {
      query.append('ranges', range);
    }
    const result = await store.call(`${SHEETS}/${id}/values:batchGet?${query}`);
    if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== group.length
      || result.valueRanges.some(item => (item.values || []).some(row => row.some(cell => cell !== '' && cell != null))))
      fail('В зарезервированном слоте найдены неизвестные данные. Запись остановлена.');
  }
}

/** Same-workbook atomic claims only. Never updates an existing manifest, range, or payload. */
function createGoogleFenceAdapter({ store, plan } = {}) {
  if (!store || store.rootId !== plan?.rootId || typeof store.batch !== 'function')
    fail('Адаптер относится к другому проекту.');
  async function readState(receipt) {
    await validatePlan(plan);
    if (!plan.receipts.some(item => same(item, receipt))) fail('Посторонняя операция защиты.');
    store.finishPass?.();
    const id = receipt.spreadsheetId, kind = receipt.kind === 'root' ? 'C' : 'D';
    const [manifest, metadata, file, row] = await Promise.all([
      store.manifestFor(id), store.spreadsheet(id), store.file(id), store.values(id, FENCE_RANGE)
    ]);
    if (await fenceDigest(manifest) !== receipt.sourceManifestDigest || metadata.spreadsheetId !== id
      || file.id !== id || file.mimeType !== 'application/vnd.google-apps.spreadsheet'
      || file.trashed || file.driveId || file.capabilities?.canEdit !== true
      || !same(file.parents, [plan.folderId]) || manifest.rootId !== plan.rootId || manifest.folderId !== plan.folderId
      || !metadata.sheets?.some(item => item.properties?.title === 'Meta' && item.properties.sheetId === 1
        && item.properties.gridProperties?.rowCount >= 3 && item.properties.gridProperties?.columnCount >= 2)
      || !metadata.sheets?.some(item => item.properties?.title === 'Payload' && item.properties.sheetId === 2
        && item.properties.gridProperties?.rowCount >= 1 + LIMITS[kind].physical * LIMITS[kind].blocks
        && item.properties.gridProperties?.columnCount >= 2)) fail('Исходная таблица изменилась или недоступна.');
    const records = await store.verifiedSlots(id, kind, receipt.sourceSlots);
    if (await sourceRecordsDigest(receipt.sourceSlots, records) !== receipt.sourceRecordsDigest)
      fail('Исходная история или вложения изменились. Миграция остановлена.');
    const old = namedSlots(metadata, kind), fresh = namedSlots(metadata, kind, 'AS5');
    const source = new Set(receipt.sourceSlots);
    // Ignore only protocol-generated reservations; all original layout/ranges stay pinned.
    const original = plan.sourceSheets.find(sheet => sheet.id === id).metadata;
    const comparable = value => {
      const result = clone(value);
      result.namedRanges = (result.namedRanges || []).sort((a, b) => a.name.localeCompare(b.name));
      result.sheets = (result.sheets || []).sort((a, b) => a.properties.sheetId - b.properties.sheetId);
      return result;
    };
    const stripped = clone(metadata);
    if (hasFenceRange(metadata)) stripped.namedRanges = (stripped.namedRanges || []).filter(item => {
      if (item.name === FENCE_RANGE_NAME || item.namedRangeId === FENCE_RANGE_NAME || /^AS5_[DC]_/.test(item.name)) return false;
      if (item.name.startsWith(`AS4_${kind}_`)) return source.has(Number(item.name.slice(6)));
      return true;
    });
    if (!same(comparable(stripped), comparable(original))) fail('Структура таблицы изменилась после согласования.');
    if (receipt.kind === 'root' && await fenceDigest((await store.values(id, 'TeamPlugins!A1:C')).values || []) !== plan.teamPluginsDigest)
      fail('Список командных плагинов изменился после согласования.');
    if (hasFenceRange(metadata)) {
      assertFenceRange(metadata);
      if (!same(parseFenceReceipt(row.values || []), receipt)) fail('Найдена другая операция миграции.');
      const inventory = fencedSlots(metadata, kind, receipt);
      await requireBlankSlots(store, id, kind, [...old].filter(slot => !inventory.occupied.has(slot)));
      return { state: 'fenced', metadata };
    }
    if (!same([...old].sort((a, b) => a - b), receipt.sourceSlots) || fresh.size
      || (row.values || []).some(line => line.some(cell => cell !== '' && cell != null)))
      fail('Снимок изменился после согласования или найдены посторонние маркеры.');
    await requireBlankSlots(store, id, kind,
      Array.from({ length: LIMITS[kind].physical }, (_, slot) => slot).filter(slot => !source.has(slot)));
    return { state: 'source', metadata };
  }
  return Object.freeze({
    readState,
    async claimFence(receipt) {
      const state = await readState(receipt);
      if (state.state === 'fenced') return;
      if (receipt.kind === 'root') {
        for (const shard of plan.receipts.slice(0, 8)) {
          if ((await readState(shard)).state !== 'fenced') fail('Основная таблица не активируется до защиты всех сегментов.');
        }
      }
      const kind = receipt.kind === 'root' ? 'C' : 'D', source = new Set(receipt.sourceSlots);
      const requests = [{ addNamedRange: { namedRange: { namedRangeId: FENCE_RANGE_NAME,
        name: FENCE_RANGE_NAME, range: { sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 } } } }];
      for (let slot = 0; slot < LIMITS[kind].physical; slot++) {
        if (source.has(slot)) continue;
        const start = 1 + slot * LIMITS[kind].blocks, name = allocationMarker(kind, slot);
        requests.push({ addNamedRange: { namedRange: { namedRangeId: name, name,
          range: { sheetId: 2, startRowIndex: start, endRowIndex: start + LIMITS[kind].blocks } } } });
      }
      requests.push({ updateCells: { range: { sheetId: 1, startRowIndex: 2, endRowIndex: 3,
        startColumnIndex: 0, endColumnIndex: 2 }, rows: [{ values: [
        { userEnteredValue: { stringValue: FENCE_ROW_KEY } },
        { userEnteredValue: { stringValue: JSON.stringify(receipt) } }
      ] }], fields: 'userEnteredValue' } });
      // A duplicate singleton or old allocation ID invalidates the entire batch.
      await store.batch(receipt.spreadsheetId, requests);
      store.finishPass?.();
    },
    async verifyActivation() {
      for (const receipt of plan.receipts) if ((await readState(receipt)).state !== 'fenced') fail('Защита неполная.');
      const info = await store.assertAccess();
      await store.listEvents();
      return { ...info, epoch: store.fenceEpoch };
    }
  });
}

module.exports = { prepareFencedMigration, validatePlan, executeFencedMigration, createGoogleFenceAdapter, probeGoogleFenceAtomicity };
