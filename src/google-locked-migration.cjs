'use strict';

const { validateLockedPlan } = require('./locked-migration.cjs');
const { readFrozenSnapshotPass } = require('./locked-snapshot-content.cjs');
const { LOCK_PROTOCOL, LOCK_RANGE_NAME, LOCK_ROW_KEY, LOCK_RANGE,
  ACTIVE_RANGE_NAME, ACTIVE_ROW_KEY, ACTIVE_RANGE, LIMITS,
  canonical, fenceDigest, namedSlots, allocationMarker, sourceRecordsDigest,
  hasFenceRange, hasLockRange, assertLockRange, parseSlotLock, validateSlotLock, lockedSlots,
  hasActivationRange, assertActivationRange, parseSlotActivation, activationEpoch } = require('./slot-fence.cjs');
const same = (a, b) => canonical(a) === canonical(b);
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const sorted = values => [...values].sort((a, b) => a - b);
const nonempty = rows => (rows || []).some(row => row.some(cell => cell !== '' && cell != null));
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

function controlClaim(name, row, key, value) {
  return [{ addNamedRange: { namedRange: { name, namedRangeId: name,
    range: { sheetId: 1, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 2 } } } },
  { updateCells: { range: { sheetId: 1, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 2 },
    rows: [{ values: [{ userEnteredValue: { stringValue: key } },
      { userEnteredValue: { stringValue: JSON.stringify(value) } }] }], fields: 'userEnteredValue' } }];
}

async function requireBlank(store, id, kind, slots) {
  const ordered = sorted(slots), ranges = [], blocks = LIMITS[kind].blocks;
  for (let at = 0; at < ordered.length;) {
    const first = ordered[at++]; let last = first;
    while (at < ordered.length && ordered[at] === last + 1) last = ordered[at++];
    ranges.push(`Payload!A${2 + first * blocks}:B${1 + (last + 1) * blocks}`);
  }
  for (let at = 0; at < ranges.length; at += 32) {
    const group = ranges.slice(at, at + 32), query = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
    group.forEach(range => query.append('ranges', range));
    const result = await store.call(`${SHEETS}/${id}/values:batchGet?${query}`);
    if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== group.length
      || result.valueRanges.some(item => nonempty(item.values))) fail('В свободном слоте есть неизвестные данные.');
  }
}

/** All mutations add immutable markers and previously blank control cells only. */
function createGoogleLockAdapter({ store, plan } = {}) {
  if (!store || store.rootId !== plan?.rootId || typeof store.batch !== 'function') fail('Другой проект миграции.');
  function approvedFor(id) {
    if (id === plan.rootId) return plan.rootLock;
    const approved = plan.rootLock.approvedShards.find(item => item.spreadsheetId === id);
    if (!approved) fail('Таблица вне согласованного проекта.');
    return approved;
  }
  async function readState(id) {
    await validateLockedPlan(plan); store.finishPass();
    const approved = approvedFor(id), kind = id === plan.rootId ? 'C' : 'D';
    const [manifest, metadata, file, lockRows, activeRows] = await Promise.all([
      store.manifestFor(id), store.spreadsheet(id), store.file(id),
      store.values(id, LOCK_RANGE), store.values(id, ACTIVE_RANGE)
    ]);
    if (await fenceDigest(manifest) !== approved.sourceManifestDigest || metadata.spreadsheetId !== id
      || file.id !== id || file.mimeType !== 'application/vnd.google-apps.spreadsheet' || file.trashed || file.driveId
      || file.capabilities?.canEdit !== true || !same(file.parents, [plan.folderId])
      || hasFenceRange(metadata)
      || !metadata.sheets?.some(item => item.properties?.sheetId === 1 && item.properties.title === 'Meta'
        && item.properties.gridProperties?.rowCount >= 4 && item.properties.gridProperties?.columnCount >= 2)
      || !metadata.sheets?.some(item => item.properties?.sheetId === 2 && item.properties.title === 'Payload'
        && item.properties.gridProperties?.rowCount >= 1 + LIMITS[kind].physical * LIMITS[kind].blocks
        && item.properties.gridProperties?.columnCount >= 2)) fail('Таблица изменилась или недоступна.');
    const old = namedSlots(metadata, kind), fresh = namedSlots(metadata, kind, 'AS5');
    let active = null;
    if (hasActivationRange(metadata)) {
      if (kind !== 'C') fail('Активация найдена в сегменте данных.');
      assertActivationRange(metadata); active = parseSlotActivation(activeRows.values || []);
      if (active.lockId !== plan.rootLock.lockId || active.rootId !== plan.rootId
        || active.rootLockDigest !== await fenceDigest(plan.rootLock) || active.epoch !== await activationEpoch(active))
        fail('Другая операция активации.');
    } else if (nonempty(activeRows.values)) fail('Ячейка активации занята неизвестными данными.');
    const original = plan.sourceSheets.find(sheet => sheet.id === id).metadata;
    const stripped = clone(metadata), baseline = new Set(approved.sourceSlots);
    // Only new protocol controls and new old-client D allocations may differ.
    stripped.namedRanges = (stripped.namedRanges || []).filter(item => {
      if ([LOCK_RANGE_NAME, ACTIVE_RANGE_NAME].includes(item.name) || /^AS5_[DC]_/.test(item.name)) return false;
      if (item.name.startsWith(`AS4_${kind}_`)) return baseline.has(Number(item.name.slice(6)));
      return true;
    });
    const normalize = input => {
      const value = clone(input);
      value.namedRanges = (value.namedRanges || []).sort((a, b) => a.name.localeCompare(b.name));
      value.sheets = (value.sheets || []).sort((a, b) => a.properties.sheetId - b.properties.sheetId);
      return value;
    };
    if (active && kind === 'C') {
      const before = original.sheets?.find(sheet => sheet.properties?.sheetId === 3);
      const current = stripped.sheets?.find(sheet => sheet.properties?.sheetId === 3);
      if (!before || !current || current.properties.gridProperties.rowCount < before.properties.gridProperties.rowCount)
        fail('Изменилась согласованная структура журнала плагинов.');
      current.properties.gridProperties.rowCount = before.properties.gridProperties.rowCount;
    }
    if (!same(normalize(stripped), normalize(original))) fail('Изменилась согласованная структура таблицы.');
    if (id === plan.rootId) {
      if (active) await store.pluginChanges();
      else if (await fenceDigest((await store.values(id, 'TeamPlugins!A1:C')).values || []) !== plan.teamPluginsDigest)
        fail('Список командных плагинов изменился.');
    }
    let lock, sourceSlots;
    if (hasLockRange(metadata)) {
      assertLockRange(metadata); lock = parseSlotLock(lockRows.values || []);
      if (lock.lockId !== plan.rootLock.lockId || lock.rootId !== plan.rootId || lock.spreadsheetId !== id
        || lock.sourceManifestDigest !== approved.sourceManifestDigest
        || (kind === 'C' ? !same(lock, plan.rootLock)
          : !same(lock.approvedSourceSlots, approved.sourceSlots) || lock.approvedSourceRecordsDigest !== approved.sourceRecordsDigest))
        fail('Таблица защищена другой операцией.');
      sourceSlots = lock.sourceSlots;
      const sets = lockedSlots(metadata, kind, lock);
      if (!active && kind === 'C' && fresh.size) fail('Новые записи появились до активации.');
      // A data sheet can contain AS5 only after the matching root is active.
      if (fresh.size && !active) {
        const rootMetadata = await store.spreadsheet(plan.rootId);
        if (!hasActivationRange(rootMetadata)) fail('Новые записи появились до активации.');
        assertActivationRange(rootMetadata);
        active = parseSlotActivation((await store.values(plan.rootId, ACTIVE_RANGE)).values || []);
        if (active.lockId !== plan.rootLock.lockId || active.rootLockDigest !== await fenceDigest(plan.rootLock)
          || active.epoch !== await activationEpoch(active)) fail('Неподтверждённая эпоха новых записей.');
      }
      await store.verifyFencePayloads(id, kind, lock, metadata, { epoch: active?.epoch });
      await requireBlank(store, id, kind, [...old].filter(slot => !sets.occupied.has(slot)));
    } else {
      if (nonempty(lockRows.values) || fresh.size || active || (kind === 'C' && !same(sorted(old), approved.sourceSlots))
        || approved.sourceSlots.some(slot => !old.has(slot))) fail('Исходный снимок или управляющие ячейки изменились.');
      sourceSlots = sorted(old);
      await requireBlank(store, id, kind,
        Array.from({ length: LIMITS[kind].physical }, (_, slot) => slot).filter(slot => !old.has(slot)));
    }
    const records = await store.verifiedSlots(id, kind, sourceSlots);
    const bySlot = new Map(sourceSlots.map((slot, index) => [slot, records[index]]));
    if (await sourceRecordsDigest(approved.sourceSlots, approved.sourceSlots.map(slot => bySlot.get(slot))) !== approved.sourceRecordsDigest
      || records.some(record => record.header.epoch !== undefined)) fail('Изменились исходные байты или история.');
    if (lock && await sourceRecordsDigest(sourceSlots, records) !== lock.sourceRecordsDigest)
      fail('Байты защищённого сегмента изменились.');
    return { state: lock ? 'locked' : 'source', id, kind, metadata, manifest, file, lock, active, sourceSlots, records };
  }
  async function shardLocks() {
    const root = await readState(plan.rootId);
    if (root.state !== 'locked') fail('Сначала должна быть остановлена публикация старых коммитов.');
    const states = await Promise.all(plan.shardIds.map(id => readState(id)));
    if (states.some(state => state.state !== 'locked')) fail('Не все сегменты остановлены.');
    return states.map(state => state.lock);
  }
  return Object.freeze({ readState, shardLocks,
    async claimLock(id) {
      const state = await readState(id);
      if (state.state === 'locked') return;
      if (id !== plan.rootId && (await readState(plan.rootId)).state !== 'locked') fail('Основная таблица ещё не остановлена.');
      const approved = approvedFor(id);
      const lock = id === plan.rootId ? plan.rootLock : {
        protocol: LOCK_PROTOCOL, kind: 'shard', lockId: plan.rootLock.lockId, rootId: plan.rootId, spreadsheetId: id,
        sourceManifestDigest: approved.sourceManifestDigest, sourceSlots: state.sourceSlots,
        sourceRecordsDigest: await sourceRecordsDigest(state.sourceSlots, state.records),
        approvedSourceSlots: approved.sourceSlots, approvedSourceRecordsDigest: approved.sourceRecordsDigest
      };
      validateSlotLock(lock);
      const requests = controlClaim(LOCK_RANGE_NAME, 2, LOCK_ROW_KEY, lock), old = new Set(state.sourceSlots);
      for (let slot = 0; slot < LIMITS[state.kind].physical; slot++) if (!old.has(slot)) {
        const name = allocationMarker(state.kind, slot), start = 1 + slot * LIMITS[state.kind].blocks;
        requests.push({ addNamedRange: { namedRange: { name, namedRangeId: name,
          range: { sheetId: 2, startRowIndex: start, endRowIndex: start + LIMITS[state.kind].blocks } } } });
      }
      await store.batch(id, requests); store.finishPass();
    },
    async readActivation(activation) {
      const locks = await shardLocks();
      for (let index = 0; index < locks.length; index++) if (activation.shardReceiptDigests[index]?.spreadsheetId !== plan.shardIds[index]
        || activation.shardReceiptDigests[index].digest !== await fenceDigest(locks[index])) fail('Итоговые сегменты изменились.');
      const state = await readState(plan.rootId);
      if (state.active && !same(state.active, activation)) fail('Уже существует другая активация.');
      const frozen = await readFrozenSnapshotPass({ store, plan, readState, allowActive: Boolean(state.active) });
      if (frozen.fingerprint !== activation.sourceFingerprint)
        fail('Полный итоговый снимок изменился после проверки копии. Нужны новая копия и разрешение.');
      return { state: state.active ? 'active' : 'locked' };
    },
    async claimActivation(activation) {
      if ((await this.readActivation(activation)).state === 'active') return;
      await store.batch(plan.rootId, controlClaim(ACTIVE_RANGE_NAME, 3, ACTIVE_ROW_KEY, activation)); store.finishPass();
    },
    async verifyActivation(activation) {
      if ((await this.readActivation(activation)).state !== 'active') fail('Активация не подтверждена.');
      const info = await store.assertAccess(); await store.listEvents();
      return { ...info, epoch: store.fenceEpoch };
    }
  });
}

/** Mutation-first negative probe must fail atomically on an existing duplicate. */
async function probeGoogleLockAtomicity({ store, plan, approved = false, approvalFingerprint } = {}) {
  await validateLockedPlan(plan);
  if (approved !== true || approvalFingerprint !== plan.sourceFingerprint) fail('Нужно разрешение для точного исходного снимка.');
  const adapter = createGoogleLockAdapter({ store, plan }), before = await adapter.readState(plan.rootId);
  if (before.state !== 'source') fail('Проверку атомарности нужно провести до остановки основной таблицы.');
  const existing = before.metadata.namedRanges?.find(item => item.name.startsWith('AS4_C_') && item.namedRangeId);
  if (!existing) fail('Нет исходного маркера для проверки отказа.');
  const sentinel = { protocol: 'amygdala-atomicity-probe-v2', rootId: plan.rootId,
    sourceFingerprint: plan.sourceFingerprint, nonce: globalThis.crypto.randomUUID() };
  const update = controlClaim(LOCK_RANGE_NAME, 2, 'atomicFenceProbe', sentinel)[1];
  let rejected;
  try { await store.batch(plan.rootId, [update, { addNamedRange: { namedRange: clone(existing) } }]); }
  catch (error) { rejected = error; }
  // Any sentinel/unknown outcome stops without retrying or erasing evidence.
  const after = await adapter.readState(plan.rootId);
  if (rejected?.status !== 400 || rejected.googleDuplicateNamedRange !== true || after.state !== 'source')
    fail('Google не подтвердил атомарный отказ. Запись остановлена.');
  return Object.freeze({ verified: true, projectRootId: plan.rootId, sourceFingerprint: plan.sourceFingerprint,
    operation: 'duplicate-named-range-atomic-rejection', remoteWritesApplied: 0, requestsAttempted: 1,
    proofDigest: await fenceDigest({ sentinel, duplicateMarker: existing, observedStatus: rejected.status,
      rootLockId: plan.rootLock.lockId }) });
}

module.exports = { createGoogleLockAdapter, controlClaim, probeGoogleLockAtomicity };
