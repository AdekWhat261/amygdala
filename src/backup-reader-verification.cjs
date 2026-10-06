'use strict';
const { decodeBackup, encodeBackup, createRestorePlan } = require('./verified-backup.cjs');
const { TeamShardedStore, digest } = require('./team-sharded-store.cjs');
const { schema2RootAndShardsValid } = require('./legacy-migration-preview.cjs');
const { validateRevision, materialize } = require('./journal.cjs');
const { visibleEvents } = require('./legacy-quarantine.cjs');
const { hasFenceRange, LIMITS, canonical, hasLockRange, hasActivationRange, parseSlotLock, lockedSlots,
  fenceDigest } = require('./slot-fence.cjs');
const clone = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const unavailable = async () => { throw new Error('Restore proof forbids network, authentication, and writes'); };

/** Restore into memory, then exercise the production reader. Returns aggregates only. */
async function verifyBackupWithReader(bytes) {
  const bundle = await decodeBackup(bytes);
  const roundTrip = await decodeBackup(await encodeBackup(bundle));
  const plan = await createRestorePlan(roundTrip, { expectedRootId: bundle.project.rootId });
  if (!equal(plan.sheets.map(sheet => ({ ...sheet, teamPluginsRows: sheet.teamPluginsRows || [] })),
    bundle.sheets.map(sheet => ({ ...sheet, teamPluginsRows: sheet.teamPluginsRows || [] }))))
    throw new Error('Restored raw records differ from the backup');
  const restored = new Map(plan.sheets.map(sheet => [sheet.id, clone(sheet)]));
  const rootSheet = restored.get(plan.project.rootId);
  let reads = 0;
  function rangeValues(sheet, range) {
    const meta = /^Meta!A(\d+):B(\d+)$/.exec(range);
    if (meta) return clone(sheet.metaCells.slice(Number(meta[1]) - 1, Number(meta[2])));
    const payload = /^Payload!A(\d+):B(\d+)$/.exec(range);
    if (!payload) throw new Error('Unsupported restored read range');
    const first = Number(payload[1]), last = Number(payload[2]);
    if (first < 2 || last < first || last > 8193) throw new Error('Invalid restored payload range');
    const kind = sheet.id === plan.project.rootId ? 'C' : 'D', blocks = LIMITS[kind].blocks;
    const exact = sheet.slots.find(item => first === 2 + item.slot * blocks && last === first + blocks - 1);
    if (exact) return clone(exact.rows);
    const rows = [];
    for (const item of sheet.slots) {
      const start = 2 + item.slot * blocks;
      item.rows.forEach((row, index) => {
        const at = start + index;
        if (at >= first && at <= last) rows[at - first] = clone(row);
      });
    }
    return Array.from({ length: rows.length }, (_, index) => rows[index] || []);
  }
  const reader = new TeamShardedStore({ rootId: plan.project.rootId, request: unavailable,
    getAccessToken: unavailable, refreshAccessToken: unavailable,
    limiter: { acquire: async () => {}, defer() {} } });
  reader.call = async (url, options = {}) => {
    if (options.method && options.method !== 'GET' || options.body) return unavailable();
    reads++;
    const parsed = new URL(url), route = parsed.pathname;
    const drive = /^\/drive\/v3\/files\/([^/]+)$/.exec(route);
    if (parsed.origin === 'https://www.googleapis.com' && drive) {
      const sheet = restored.get(decodeURIComponent(drive[1]));
      if (!sheet) throw new Error('Read escaped the restored project');
      // Local fixture capability only; no assertion about real Google permissions.
      return { ...clone(sheet.fileMetadata), capabilities: { canEdit: true } };
    }
    const match = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(route);
    if (parsed.origin !== 'https://sheets.googleapis.com' || !match) return unavailable();
    const sheet = restored.get(decodeURIComponent(match[1]));
    if (!sheet) throw new Error('Read escaped the restored project');
    if (!match[2]) return clone(sheet.metadata);
    if (match[2] === '/values:batchGet') return {
      valueRanges: parsed.searchParams.getAll('ranges').map(range => ({ values: rangeValues(sheet, range) }))
    };
    if (match[2].startsWith('/values/')) return { values: rangeValues(sheet, decodeURIComponent(match[2].slice(8))) };
    return unavailable();
  };
  const fenced = hasFenceRange(rootSheet.metadata);
  const locked = hasLockRange(rootSheet.metadata), active = hasActivationRange(rootSheet.metadata);
  const locks = locked ? new Map(plan.sheets.map(sheet => [sheet.id, parseSlotLock([sheet.metaCells[2]])])) : null;
  if (fenced || active || rootSheet.manifest.schema === 3) await reader.assertAccess();
  else if (locked) {
    // A frozen project intentionally fails normal startup. The isolated restore
    // reader may seed verified controls to inspect its bytes without activating it.
    const control = locks.get(plan.project.rootId);
    reader.manifest = clone(control.targetRoot); reader.rootMetadata = clone(rootSheet.metadata);
    reader.shards = plan.project.shardIds.map(id => clone(restored.get(id).metadata));
    reader.fenceReceipts = locks; reader.slotLockId = control.lockId; reader.fenceEpoch = null;
    const originals = await reader.verifiedSlots(plan.project.rootId, 'C', control.sourceSlots);
    reader.assertLegacyPartition(control, originals);
  }
  else {
    // Historical schema 2 is intentionally refused by normal live startup.
    // Seed only the restored legacy manifests so the real slot/history reader
    // can prove recoverability without enabling a legacy client or auth.
    const rawShards = plan.project.shardIds.map(id => restored.get(id).manifest);
    if (!schema2RootAndShardsValid(rootSheet.manifest, rawShards, plan.project.rootId)
      || !equal(rootSheet.manifest.shardIds, plan.project.shardIds)
      || await digest(rootSheet.manifest.params) !== rootSheet.manifest.paramsDigest)
      throw new Error('Restored schema2 source manifests are inconsistent');
    reader.manifest = clone(rootSheet.manifest);
    reader.rootMetadata = clone(rootSheet.metadata);
    reader.shards = plan.project.shardIds.map(id => clone(restored.get(id).metadata));
  }
  const rawEvents = [], blobRecords = new Map();
  let recordCount = 0, allBlobBytes = 0;
  for (const sheet of plan.sheets) {
    const kind = sheet.id === plan.project.rootId ? 'C' : 'D';
    const actualSlots = [...reader.slots(sheet.metadata, kind)].sort((a, b) => a - b);
    if (!equal(actualSlots, [...sheet.occupiedSlots].sort((a, b) => a - b)))
      throw new Error('Restored reader occupancy differs from backup');
    for (const item of sheet.slots) {
      if (!equal(await reader.readSlot(sheet.id, kind, item.slot), item.rows))
        throw new Error('Restored raw slot differs from backup');
      const actual = await reader.verifiedSlot(sheet.id, kind, item.slot);
      const expected = reader.decodeSlot(item.rows, kind);
      if (!equal(actual.header, expected.header) || !sameBytes(actual.payload, expected.payload))
        throw new Error('Restored decoded record differs from backup');
      recordCount++;
      if (kind === 'C') rawEvents.push(...reader.decodeCommit(expected).events.map(validateRevision));
      else {
        allBlobBytes += actual.payload.length;
        if (locked && lockedSlots(sheet.metadata, 'D', locks.get(sheet.id)).extras.has(item.slot)) continue;
        const { key, part, parts } = expected.header;
        if (!blobRecords.has(key)) blobRecords.set(key, { parts, records: new Map() });
        const group = blobRecords.get(key);
        if (group.parts !== parts || group.records.has(part)) throw new Error('Duplicate restored blob part');
        group.records.set(part, expected.payload);
      }
    }
  }
  if (new Set(rawEvents.map(event => event.id)).size !== rawEvents.length) throw new Error('Duplicate restored revision');
  const listed = await reader.listEvents();
  const byId = events => [...events].sort((a, b) => a.id.localeCompare(b.id));
  if (!equal(byId([...reader.eventIndex.values()]), byId(rawEvents))
    || !equal(byId(listed), byId(visibleEvents(rawEvents, reader.manifest))))
    throw new Error('Restored history differs from backup');
  materialize(listed);
  const index = await reader.blobSlots();
  if (!equal([...index.keys()].sort(), [...blobRecords.keys()].sort())) throw new Error('Restored blob groups differ from backup');
  let completeBlobGroups = 0, incompleteBlobGroups = 0;
  for (const [hash, expected] of blobRecords) {
    const actual = index.get(hash);
    if (actual.parts !== expected.parts || actual.records.size !== expected.records.size)
      throw new Error('Restored blob part inventory differs from backup');
    for (const [part, payload] of expected.records) {
      if (!actual.records.has(part) || !sameBytes(payload, actual.records.get(part)))
        throw new Error('Restored blob bytes differ from backup');
    }
    if (actual.records.size === actual.parts) {
      const assembled = await reader.assembleBlob(hash, actual);
      const ordered = [...expected.records].sort(([a], [b]) => a - b).map(([, value]) => value);
      const expectedBytes = new Uint8Array(ordered.reduce((sum, part) => sum + part.length, 0));
      let at = 0; for (const part of ordered) { expectedBytes.set(part, at); at += part.length; }
      if (!sameBytes(assembled, expectedBytes)) throw new Error('Restored assembled blob differs from backup');
      completeBlobGroups++;
    } else incompleteBlobGroups++;
  }
  await reader.validateSnapshot(rawEvents);
  return Object.freeze({ verified: true, bundleSha256: bundle.bundleSha256, sourceFingerprint: bundle.sourceFingerprint,
    projectRootId: plan.project.rootId, revisionCount: rawEvents.length, activeRevisionCount: listed.length,
    blobGroups: index.size, completeBlobGroups, incompleteBlobGroups, allBlobBytes, recordCount,
    sheetCount: plan.sheets.length, fenced, fenceEpoch: reader.fenceEpoch || null,
    migrationStage: locked ? (active ? 'active' : 'locked') : fenced ? 'active' : 'source',
    slotLockId: locked ? locks.get(plan.project.rootId).lockId : null,
    rootLockDigest: locked ? await fenceDigest(locks.get(plan.project.rootId)) : null,
    shardReceiptDigests: locked ? await Promise.all(plan.project.shardIds.map(async id => ({
      spreadsheetId: id, digest: await fenceDigest(locks.get(id)) }))) : null,
    memoryReads: reads, remoteWrites: 0, networkRequests: 0, authenticationCalls: 0,
    verification: 'isolated-production-reader', permissionEvidence: 'synthetic-restored-capability-only' });
}

module.exports = { verifyBackupWithReader };
