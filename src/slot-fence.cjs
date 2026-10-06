'use strict';

const { sha256 } = require('./drive.cjs');
const FENCE_PROTOCOL = 'amygdala-slot-fence-v1';
const FENCE_RANGE_NAME = 'AMYGDALA_MIGRATION_V1';
const FENCE_ROW_KEY = 'slotFence';
const FENCE_RANGE = 'Meta!A3:B3';
const LOCK_PROTOCOL = 'amygdala-slot-lock-v2';
const LOCK_RANGE_NAME = 'AMYGDALA_LOCK_V2';
const LOCK_ROW_KEY = 'slotLock';
const LOCK_RANGE = 'Meta!A3:B3';
const ACTIVE_PROTOCOL = 'amygdala-slot-activation-v2';
const ACTIVE_RANGE_NAME = 'AMYGDALA_ACTIVE_V2';
const ACTIVE_ROW_KEY = 'slotActivation';
const ACTIVE_RANGE = 'Meta!A4:B4';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const LIMITS = Object.freeze({ C: { physical: 2048, claims: 1536, blocks: 4 }, D: { physical: 256, claims: 192, blocks: 16 } });
const fail = () => { throw new Error('Защита миграции повреждена или не завершена. Синхронизация остановлена.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function fenceDigest(value) { return sha256(new TextEncoder().encode(canonical(value))); }
function allocationMarker(kind, slot, namespace = 'AS4') { return `${namespace}_${kind}_${String(slot).padStart(3, '0')}`; }
function namedSlots(metadata, kind, namespace = 'AS4') {
  if (!LIMITS[kind] || !['AS4', 'AS5'].includes(namespace)) fail();
  const prefix = `${namespace}_${kind}_`, found = new Set();
  for (const item of metadata?.namedRanges || []) {
    if (typeof item.name !== 'string' || !item.name.startsWith(prefix)) continue;
    const slot = Number(item.name.slice(prefix.length)), start = 1 + slot * LIMITS[kind].blocks;
    if (!Number.isInteger(slot) || slot < 0 || slot >= LIMITS[kind].physical
      || allocationMarker(kind, slot, namespace) !== item.name || found.has(slot)
      || item.range?.sheetId !== 2 || item.range.startRowIndex !== start
      || item.range.endRowIndex !== start + LIMITS[kind].blocks) fail();
    found.add(slot);
  }
  return found;
}
function hasFenceRange(metadata) {
  return (metadata?.namedRanges || []).some(item => item.name === FENCE_RANGE_NAME || item.namedRangeId === FENCE_RANGE_NAME);
}
function assertFenceRange(metadata) {
  const found = (metadata?.namedRanges || []).filter(item => item.name === FENCE_RANGE_NAME || item.namedRangeId === FENCE_RANGE_NAME);
  if (found.length !== 1) fail();
  const item = found[0], range = item.range;
  if (item.name !== FENCE_RANGE_NAME || item.namedRangeId !== FENCE_RANGE_NAME || range?.sheetId !== 1
    || range.startRowIndex !== 2 || range.endRowIndex !== 3 || range.startColumnIndex !== 0 || range.endColumnIndex !== 2) fail();
  return item;
}
function validateFenceReceipt(receipt) {
  if (!object(receipt) || receipt.protocol !== FENCE_PROTOCOL || !HASH.test(receipt.epoch || '')
    || !['root', 'shard'].includes(receipt.kind) || !ID.test(receipt.rootId || '') || !ID.test(receipt.spreadsheetId || '')
    || !HASH.test(receipt.sourceManifestDigest || '') || !HASH.test(receipt.sourceRecordsDigest || '')
    || !Array.isArray(receipt.sourceSlots)) fail();
  const kind = receipt.kind === 'root' ? 'C' : 'D';
  if ((receipt.kind === 'root') !== (receipt.spreadsheetId === receipt.rootId)
    || receipt.sourceSlots.some((slot, index) => !Number.isInteger(slot) || slot < 0 || slot >= LIMITS[kind].physical
      || (index > 0 && receipt.sourceSlots[index - 1] >= slot))) fail();
  const allowed = ['protocol', 'epoch', 'kind', 'rootId', 'spreadsheetId', 'sourceManifestDigest', 'sourceSlots', 'sourceRecordsDigest'];
  if (receipt.kind === 'root') {
    allowed.push('sourceFingerprint', 'scopePath', 'targetRoot', 'targetShards', 'shardReceiptDigests');
    if (!HASH.test(receipt.sourceFingerprint || '') || typeof receipt.scopePath !== 'string' || !receipt.scopePath
      || receipt.scopePath.includes('\\') || receipt.scopePath.split('/').some(part => !part || part === '.' || part === '..')
      || !object(receipt.targetRoot) || !Array.isArray(receipt.targetShards) || receipt.targetShards.length !== 8
      || !Array.isArray(receipt.shardReceiptDigests) || receipt.shardReceiptDigests.length !== 8) fail();
    if (receipt.shardReceiptDigests.some(item => !object(item) || Object.keys(item).length !== 2
      || !ID.test(item.spreadsheetId || '') || !HASH.test(item.digest || ''))
      || new Set(receipt.shardReceiptDigests.map(item => item.spreadsheetId)).size !== 8) fail();
  }
  if (Object.keys(receipt).some(key => !allowed.includes(key))
    || new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 48000) fail();
  return receipt;
}
function parseFenceReceipt(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.length !== 2 || rows[0][0] !== FENCE_ROW_KEY
    || typeof rows[0][1] !== 'string') fail();
  let receipt;
  try { receipt = JSON.parse(rows[0][1]); } catch { fail(); }
  return validateFenceReceipt(receipt);
}
async function sourceRecordsDigest(slots, records) {
  if (!Array.isArray(slots) || !Array.isArray(records) || slots.length !== records.length) fail();
  return fenceDigest(slots.map((slot, index) => ({ slot, header: records[index].header })));
}
async function migrationEpoch({ sourceFingerprint, scopePath, targetRoot, targetShards }) {
  return fenceDigest({ protocol: FENCE_PROTOCOL, sourceFingerprint, scopePath, targetRoot, targetShards });
}
function fencedSlots(metadata, kind, receipt) {
  validateFenceReceipt(receipt); assertFenceRange(metadata);
  if (metadata.spreadsheetId !== receipt.spreadsheetId || (kind === 'C') !== (receipt.kind === 'root')) fail();
  const old = namedSlots(metadata, kind), fresh = namedSlots(metadata, kind, 'AS5');
  if (old.size !== LIMITS[kind].physical) fail();
  const source = new Set(receipt.sourceSlots);
  if ([...fresh].some(slot => source.has(slot) || slot >= LIMITS[kind].claims)) fail();
  return { source, fresh, occupied: new Set([...source, ...fresh]) };
}

function hasControlRange(metadata, name) {
  return (metadata?.namedRanges || []).some(item => item.name === name || item.namedRangeId === name);
}
function assertControlRange(metadata, name, row) {
  const matches = (metadata?.namedRanges || []).filter(item => item.name === name || item.namedRangeId === name);
  if (matches.length !== 1) fail();
  const item = matches[0], range = item.range;
  if (item.name !== name || item.namedRangeId !== name || range?.sheetId !== 1
    || range.startRowIndex !== row || range.endRowIndex !== row + 1
    || range.startColumnIndex !== 0 || range.endColumnIndex !== 2) fail();
  return item;
}
const hasLockRange = metadata => hasControlRange(metadata, LOCK_RANGE_NAME);
const hasActivationRange = metadata => hasControlRange(metadata, ACTIVE_RANGE_NAME);
const assertLockRange = metadata => assertControlRange(metadata, LOCK_RANGE_NAME, 2);
const assertActivationRange = metadata => assertControlRange(metadata, ACTIVE_RANGE_NAME, 3);
function validSlotList(slots, kind) {
  return Array.isArray(slots) && slots.every((slot, index) => Number.isInteger(slot) && slot >= 0
    && slot < LIMITS[kind].physical && (index === 0 || slots[index - 1] < slot));
}
function validScope(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\')
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}
function validateSlotLock(lock) {
  if (!object(lock) || lock.protocol !== LOCK_PROTOCOL || !HASH.test(lock.lockId || '')
    || !['root', 'shard'].includes(lock.kind) || !ID.test(lock.rootId || '') || !ID.test(lock.spreadsheetId || '')
    || (lock.kind === 'root') !== (lock.spreadsheetId === lock.rootId)
    || !HASH.test(lock.sourceManifestDigest || '') || !HASH.test(lock.sourceRecordsDigest || '')
    || !validSlotList(lock.sourceSlots, lock.kind === 'root' ? 'C' : 'D')) fail();
  const allowed = ['protocol', 'kind', 'lockId', 'rootId', 'spreadsheetId', 'sourceManifestDigest', 'sourceSlots', 'sourceRecordsDigest'];
  if (lock.kind === 'root') {
    allowed.push('sourceFingerprint', 'scopePath', 'backupBundleSha256', 'approvedShards', 'targetRoot', 'targetShards');
    if (!HASH.test(lock.sourceFingerprint || '') || !HASH.test(lock.backupBundleSha256 || '') || !validScope(lock.scopePath)
      || !object(lock.targetRoot) || !Array.isArray(lock.targetShards) || lock.targetShards.length !== 8
      || !Array.isArray(lock.approvedShards) || lock.approvedShards.length !== 8
      || new Set(lock.approvedShards.map(item => item?.spreadsheetId)).size !== 8
      || lock.approvedShards.some(item => !object(item) || Object.keys(item).length !== 4
        || !ID.test(item.spreadsheetId || '') || !HASH.test(item.sourceManifestDigest || '')
        || !HASH.test(item.sourceRecordsDigest || '') || !validSlotList(item.sourceSlots, 'D'))) fail();
  } else {
    allowed.push('approvedSourceSlots', 'approvedSourceRecordsDigest');
    if (!validSlotList(lock.approvedSourceSlots, 'D') || !HASH.test(lock.approvedSourceRecordsDigest || '')
      || lock.approvedSourceSlots.some(slot => !lock.sourceSlots.includes(slot))) fail();
  }
  if (Object.keys(lock).some(key => !allowed.includes(key))
    || new TextEncoder().encode(JSON.stringify(lock)).byteLength > 48000) fail();
  return lock;
}
function parseControlRows(rows, key, validate) {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.length !== 2 || rows[0][0] !== key
    || typeof rows[0][1] !== 'string') fail();
  let value;
  try { value = JSON.parse(rows[0][1]); } catch { fail(); }
  return validate(value);
}
const parseSlotLock = rows => parseControlRows(rows, LOCK_ROW_KEY, validateSlotLock);
async function rootLockId(lock) {
  const { lockId, ...content } = lock;
  return fenceDigest(content);
}
function validateSlotActivation(active) {
  const allowed = ['protocol', 'rootId', 'lockId', 'rootLockDigest', 'sourceFingerprint', 'backupBundleSha256', 'shardReceiptDigests', 'epoch'];
  if (!object(active) || active.protocol !== ACTIVE_PROTOCOL || !ID.test(active.rootId || '')
    || ['lockId', 'rootLockDigest', 'sourceFingerprint', 'backupBundleSha256', 'epoch'].some(key => !HASH.test(active[key] || ''))
    || !Array.isArray(active.shardReceiptDigests) || active.shardReceiptDigests.length !== 8
    || new Set(active.shardReceiptDigests.map(item => item?.spreadsheetId)).size !== 8
    || active.shardReceiptDigests.some(item => !object(item) || Object.keys(item).length !== 2
      || !ID.test(item.spreadsheetId || '') || !HASH.test(item.digest || ''))
    || Object.keys(active).some(key => !allowed.includes(key))
    || new TextEncoder().encode(JSON.stringify(active)).byteLength > 48000) fail();
  return active;
}
const parseSlotActivation = rows => parseControlRows(rows, ACTIVE_ROW_KEY, validateSlotActivation);
async function activationEpoch(active) {
  const { epoch, ...content } = active;
  return fenceDigest(content);
}
function lockedSlots(metadata, kind, lock) {
  validateSlotLock(lock); assertLockRange(metadata);
  if (metadata.spreadsheetId !== lock.spreadsheetId || (kind === 'C') !== (lock.kind === 'root') || hasFenceRange(metadata)) fail();
  const old = namedSlots(metadata, kind), fresh = namedSlots(metadata, kind, 'AS5');
  if (old.size !== LIMITS[kind].physical) fail();
  const source = new Set(lock.sourceSlots), approved = new Set(kind === 'C' ? lock.sourceSlots : lock.approvedSourceSlots);
  if ([...fresh].some(slot => source.has(slot) || slot >= LIMITS[kind].claims)) fail();
  return { source, approved, extras: new Set([...source].filter(slot => !approved.has(slot))), fresh,
    occupied: new Set([...source, ...fresh]), active: new Set([...approved, ...fresh]) };
}

module.exports = { FENCE_PROTOCOL, FENCE_RANGE_NAME, FENCE_ROW_KEY, FENCE_RANGE, LIMITS, allocationMarker,
  canonical, fenceDigest, hasFenceRange, assertFenceRange, namedSlots, validateFenceReceipt, parseFenceReceipt,
  sourceRecordsDigest, migrationEpoch, fencedSlots,
  LOCK_PROTOCOL, LOCK_RANGE_NAME, LOCK_ROW_KEY, LOCK_RANGE, ACTIVE_PROTOCOL, ACTIVE_RANGE_NAME, ACTIVE_ROW_KEY, ACTIVE_RANGE,
  hasLockRange, assertLockRange, hasActivationRange, assertActivationRange, validateSlotLock, parseSlotLock, rootLockId,
  validateSlotActivation, parseSlotActivation, activationEpoch, lockedSlots };
