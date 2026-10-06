'use strict';

const { prepareFencedMigration } = require('./fenced-migration.cjs');
const { assertManifest } = require('./team-sharded-store.cjs');
const { LOCK_PROTOCOL, LOCK_RANGE_NAME, ACTIVE_PROTOCOL, ACTIVE_RANGE_NAME, LIMITS,
  canonical, fenceDigest, allocationMarker, namedSlots, sourceRecordsDigest,
  validateSlotLock, rootLockId, parseSlotLock, hasLockRange, assertLockRange,
  lockedSlots, validateSlotActivation, activationEpoch, parseSlotActivation,
  hasActivationRange, assertActivationRange } = require('./slot-fence.cjs');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const clone = value => structuredClone(value);
const same = (a, b) => canonical(a) === canonical(b);
const fail = message => { throw new Error(message); };
const sorted = values => [...values].sort((a, b) => a - b);
const hash = value => /^[a-f0-9]{64}$/.test(value || '');

/** Initial approval binds this source backup. Root publication freezes first. */
async function prepareLockedMigration(snapshot, options) {
  const previous = await prepareFencedMigration(snapshot, options);
  const root = previous.receipts[8];
  const rootLock = {
    protocol: LOCK_PROTOCOL, kind: 'root', rootId: previous.rootId, spreadsheetId: previous.rootId,
    sourceFingerprint: previous.sourceFingerprint, scopePath: previous.scopePath,
    backupBundleSha256: previous.backupBundleSha256,
    sourceManifestDigest: root.sourceManifestDigest, sourceSlots: root.sourceSlots,
    sourceRecordsDigest: root.sourceRecordsDigest,
    approvedShards: previous.receipts.slice(0, 8).map(receipt => ({
      spreadsheetId: receipt.spreadsheetId, sourceManifestDigest: receipt.sourceManifestDigest,
      sourceSlots: receipt.sourceSlots, sourceRecordsDigest: receipt.sourceRecordsDigest
    })), targetRoot: root.targetRoot, targetShards: root.targetShards
  };
  rootLock.lockId = await rootLockId(rootLock);
  validateSlotLock(rootLock);
  return Object.freeze({ protocol: LOCK_PROTOCOL, rootId: previous.rootId, folderId: previous.folderId,
    shardIds: previous.shardIds, scopePath: previous.scopePath,
    sourceFingerprint: previous.sourceFingerprint, backupBundleSha256: previous.backupBundleSha256,
    rootLock, sourceSheets: previous.sourceSheets, teamPluginsDigest: previous.teamPluginsDigest,
    sourceTeamPluginsRowCount: snapshot.backupSnapshot.sheets.find(sheet => sheet.id === previous.rootId).teamPluginsRows.length,
    report: previous.report, remoteWrites: 0 });
}

async function validateLockedPlan(plan) {
  if (!plan || plan.protocol !== LOCK_PROTOCOL || plan.remoteWrites !== 0
    || !hash(plan.sourceFingerprint) || !hash(plan.backupBundleSha256) || !hash(plan.teamPluginsDigest)
    || !Array.isArray(plan.shardIds) || plan.shardIds.length !== 8
    || new Set([plan.rootId, ...plan.shardIds]).size !== 9
    || !Array.isArray(plan.sourceSheets) || plan.sourceSheets.length !== 9
    || (plan.sourceTeamPluginsRowCount !== undefined && (!Number.isInteger(plan.sourceTeamPluginsRowCount)
      || plan.sourceTeamPluginsRowCount < 1 || plan.sourceTeamPluginsRowCount > 5001))
    || new Set(plan.sourceSheets.map(sheet => sheet.id)).size !== 9) fail('Повреждён план остановки старых записей.');
  const lock = validateSlotLock(plan.rootLock);
  if (lock.kind !== 'root' || lock.rootId !== plan.rootId || lock.spreadsheetId !== plan.rootId
    || lock.sourceFingerprint !== plan.sourceFingerprint || lock.scopePath !== plan.scopePath
    || lock.backupBundleSha256 !== plan.backupBundleSha256 || await rootLockId(lock) !== lock.lockId
    || lock.targetRoot.folderId !== plan.folderId || !same(lock.targetRoot.shardIds, plan.shardIds))
    fail('План не соответствует согласованному проекту и снимку.');
  assertManifest(lock.targetRoot, lock.targetShards, plan.rootId);
  for (const [index, id] of [plan.rootId, ...plan.shardIds].entries()) {
    const approved = index ? lock.approvedShards[index - 1] : lock;
    const sheet = plan.sourceSheets.find(item => item.id === id), kind = index ? 'D' : 'C';
    const projected = { ...(index ? lock.targetShards[index - 1] : lock.targetRoot), schema: 2 };
    delete projected.pathProtocol; delete projected.namespace;
    if (!index) { delete projected.legacyQuarantine; delete projected.legacyPathMap; }
    if (!sheet || sheet.metadata?.spreadsheetId !== id || sheet.fileMetadata?.id !== id
      || !same(sheet.fileMetadata.parents, [plan.folderId]) || approved.spreadsheetId !== id
      || await fenceDigest(projected) !== approved.sourceManifestDigest
      || hasLockRange(sheet.metadata) || hasActivationRange(sheet.metadata)
      || namedSlots(sheet.metadata, kind, 'AS5').size
      || !same(sorted(namedSlots(sheet.metadata, kind)), approved.sourceSlots))
      fail('Исходная структура не соответствует сохранённому плану.');
  }
  return lock;
}

function requireInitialApproval(plan, args) {
  if (args.approved !== true || args.syncPaused !== true || args.approvalFingerprint !== plan.sourceFingerprint)
    fail('Нужно отдельное разрешение для исходного снимка и остановленная синхронизация.');
  if (args.backupProof?.verified !== true || args.backupProof.bundleSha256 !== plan.backupBundleSha256
    || args.backupProof.sourceFingerprint !== plan.sourceFingerprint || args.backupProof.projectRootId !== plan.rootId)
    fail('Восстановление исходной резервной копии не подтверждено.');
  if (args.atomicFenceProof?.verified !== true || args.atomicFenceProof.projectRootId !== plan.rootId
    || args.atomicFenceProof.sourceFingerprint !== plan.sourceFingerprint
    || args.atomicFenceProof.operation !== 'duplicate-named-range-atomic-rejection'
    || !hash(args.atomicFenceProof.proofDigest)) fail('Нет проверки атомарного отказа для этого снимка.');
}

/** Does not activate sync. Final fingerprint/backup requires separate consent. */
async function executeSlotLocks(args = {}) {
  const { plan, adapter } = args;
  await validateLockedPlan(plan); requireInitialApproval(plan, args);
  if (!adapter || ['readState', 'claimLock'].some(name => typeof adapter[name] !== 'function'))
    fail('Адаптер остановки старых записей недоступен.');
  // All nine approved source inventories must remain present before first write.
  for (const id of [plan.rootId, ...plan.shardIds]) await adapter.readState(id);
  let writes = 0;
  async function claim(id) {
    const before = await adapter.readState(id);
    if (before.state === 'locked') return;
    let error;
    try { await adapter.claimLock(id); } catch (caught) { error = caught; }
    const after = await adapter.readState(id);
    if (after.state === 'locked') { writes++; return; }
    if (error) throw error;
    fail('Защита записи не подтверждена; повторите проверку перед продолжением.');
  }
  // Once this atomic C reservation wins, no stale writer can publish a commit.
  await claim(plan.rootId);
  for (const id of plan.shardIds) {
    // Retry only a proven atomic collision caused by a late old D allocation.
    for (let attempt = 0; ; attempt++) {
      try { await claim(id); break; }
      catch (error) {
        if (attempt >= 4 || error.status !== 400 || error.googleDuplicateNamedRange !== true) throw error;
      }
    }
  }
  const states = await Promise.all([plan.rootId, ...plan.shardIds].map(id => adapter.readState(id)));
  if (states.some(state => state.state !== 'locked')) fail('Остановка старых записей неполная.');
  return Object.freeze({ state: 'locked-awaiting-final-backup', lockId: plan.rootLock.lockId, writes,
    sourceFingerprint: plan.sourceFingerprint, activationWrites: 0,
    shardLocks: states.slice(1).map(state => clone(state.lock)) });
}

async function prepareSlotActivation({ plan, shardLocks, finalFingerprint, finalBackupProof } = {}) {
  const rootLock = await validateLockedPlan(plan);
  if (!hash(finalFingerprint) || finalFingerprint === plan.sourceFingerprint
    || finalBackupProof?.verified !== true || finalBackupProof.projectRootId !== plan.rootId
    || finalBackupProof.sourceFingerprint !== finalFingerprint || !hash(finalBackupProof.bundleSha256)
    || finalBackupProof.migrationStage !== 'locked' || finalBackupProof.slotLockId !== rootLock.lockId
    || finalBackupProof.rootLockDigest !== await fenceDigest(rootLock)
    || !Array.isArray(shardLocks) || shardLocks.length !== 8)
    fail('Нужен новый полный снимок остановленных таблиц с проверенным восстановлением.');
  const shardReceiptDigests = [];
  for (let index = 0; index < 8; index++) {
    const lock = validateSlotLock(shardLocks[index]), approved = rootLock.approvedShards[index];
    if (lock.kind !== 'shard' || lock.lockId !== rootLock.lockId || lock.rootId !== plan.rootId
      || lock.spreadsheetId !== plan.shardIds[index] || lock.sourceManifestDigest !== approved.sourceManifestDigest
      || !same(lock.approvedSourceSlots, approved.sourceSlots)
      || lock.approvedSourceRecordsDigest !== approved.sourceRecordsDigest)
      fail('Защита сегментов не относится к согласованному исходному снимку.');
    shardReceiptDigests.push({ spreadsheetId: lock.spreadsheetId, digest: await fenceDigest(lock) });
  }
  if (!same(finalBackupProof.shardReceiptDigests, shardReceiptDigests))
    fail('Проверенная копия не содержит итоговые записи защиты сегментов.');
  const activation = { protocol: ACTIVE_PROTOCOL, rootId: plan.rootId, lockId: rootLock.lockId,
    rootLockDigest: await fenceDigest(rootLock), sourceFingerprint: finalFingerprint,
    backupBundleSha256: finalBackupProof.bundleSha256, shardReceiptDigests };
  activation.epoch = await activationEpoch(activation);
  validateSlotActivation(activation);
  return Object.freeze(activation);
}

/** No initial-snapshot consent is sufficient for this final activation. */
async function executeSlotActivation({ plan, activation, adapter, approved = false, syncPaused = false,
  approvalFingerprint, backupProof } = {}) {
  await validateLockedPlan(plan); validateSlotActivation(activation);
  if (approved !== true || syncPaused !== true || approvalFingerprint !== activation.sourceFingerprint
    || approvalFingerprint === plan.sourceFingerprint || activation.rootId !== plan.rootId
    || activation.lockId !== plan.rootLock.lockId || activation.rootLockDigest !== await fenceDigest(plan.rootLock)
    || activation.epoch !== await activationEpoch(activation)
    || backupProof?.verified !== true || backupProof.projectRootId !== plan.rootId
    || backupProof.sourceFingerprint !== activation.sourceFingerprint
    || backupProof.bundleSha256 !== activation.backupBundleSha256
    || backupProof.migrationStage !== 'locked' || backupProof.slotLockId !== activation.lockId
    || backupProof.rootLockDigest !== activation.rootLockDigest
    || !same(backupProof.shardReceiptDigests, activation.shardReceiptDigests))
    fail('Нужны проверенная новая копия и отдельное разрешение для итогового снимка.');
  if (!adapter || ['readActivation', 'claimActivation', 'verifyActivation'].some(name => typeof adapter[name] !== 'function'))
    fail('Адаптер активации недоступен.');
  const current = await adapter.readActivation(activation);
  let writes = 0;
  if (current.state !== 'active') {
    if (current.state !== 'locked') fail('Остановка старых записей не подтверждена.');
    let error;
    try { await adapter.claimActivation(activation); } catch (caught) { error = caught; }
    if ((await adapter.readActivation(activation)).state !== 'active') {
      if (error) throw error;
      fail('Итоговая активация не подтверждена.');
    }
    writes++;
  }
  const result = await adapter.verifyActivation(activation);
  if (result?.epoch !== activation.epoch || result?.pathProtocol !== 'project-relative-v1'
    || result?.namespace !== plan.rootId) fail('Проверка активированного проекта не прошла.');
  return Object.freeze({ state: 'complete', epoch: activation.epoch, writes, lockId: activation.lockId,
    sourceFingerprint: activation.sourceFingerprint, originalPayloadUpdates: 0, rawManifestUpdates: 0 });
}

module.exports = { prepareLockedMigration, validateLockedPlan, executeSlotLocks,
  prepareSlotActivation, executeSlotActivation };
