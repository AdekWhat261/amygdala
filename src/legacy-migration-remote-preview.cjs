'use strict';

const { materialize, validateRevision } = require('./journal.cjs');
const { digest, PARAMS } = require('./team-sharded-store.cjs');
const { classifyMigrationProgress, canonical, validateLegacyQuarantine } = require('./legacy-migration-preview.cjs');
const { validateLegacyPathMap, validateMigratedEventSets } = require('./legacy-quarantine.cjs');
const { buildVerifiedBackup, encodeBackup, slotDigest } = require('./verified-backup.cjs');
const { hasFenceRange } = require('./slot-fence.cjs');

const MIME = 'application/vnd.google-apps.spreadsheet';
const enc = new TextDecoder();

function safeScope(scopePath) {
  if (typeof scopePath !== 'string' || !scopePath || scopePath.startsWith('/') || scopePath.includes('\\')
    || scopePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid selected scope path');
}

function validLayout(sheet, index) {
  const props = sheet;
  const meta = props?.sheets?.find(item => item.properties?.title === 'Meta')?.properties;
  const payload = props?.sheets?.find(item => item.properties?.title === 'Payload')?.properties;
  const minPayloadRows = 1 + (index === 0 ? PARAMS.commitSlots * PARAMS.commitBlocks : PARAMS.dataSlots * PARAMS.dataChunks);
  return props?.spreadsheetId && meta?.sheetId === 1 && (meta.gridProperties?.rowCount || 0) >= 2
    && payload?.sheetId === 2 && (payload.gridProperties?.rowCount || 0) >= minPayloadRows
    && (payload.gridProperties?.columnCount || 0) >= 2
    && (index !== 0 || props.sheets.some(item => item.properties?.title === 'TeamPlugins' && item.properties.sheetId === 3));
}

async function readPass(store, scopePath, verifyBlobs, includeBackupData = false) {
  const rawRoot = await store.manifestFor(store.rootId);
  let root = rawRoot;
  if (!Array.isArray(root?.shardIds) || root.shardIds.length !== 8) throw new Error('Project does not have the expected eight shards');
  const ids = [store.rootId, ...root.shardIds];
  if (new Set(ids).size !== 9) throw new Error('Project spreadsheet IDs are duplicated');
  const [rawShards, files, sheets] = await Promise.all([
    Promise.all(root.shardIds.map(id => store.manifestFor(id))),
    Promise.all(ids.map(id => store.file(id))),
    Promise.all(ids.map(id => store.spreadsheet(id)))
  ]);
  if (root?.rootId !== store.rootId || await digest(root.params) !== root.paramsDigest) throw new Error('Project parameter digest or root identity does not match');
  for (let i = 0; i < ids.length; i++) {
    const file = files[i];
    if (file.id !== ids[i] || file.mimeType !== MIME || file.trashed || file.driveId
      || file.capabilities?.canEdit !== true || !Array.isArray(file.parents)
      || file.parents.length !== 1 || file.parents[0] !== root.folderId
      || sheets[i].spreadsheetId !== ids[i] || !validLayout(sheets[i], i)) {
      throw new Error('A project file or sheet no longer matches the linked project boundary');
    }
  }

  let shards = rawShards;
  const fenced = sheets.some(hasFenceRange);
  if (fenced) {
    const resolved = await store.resolveFenceState({ root: rawRoot, shards: rawShards, metadata: sheets });
    root = resolved.root; shards = resolved.shards;
  } else {
    store.fenceReceipts = new Map(); store.fenceEpoch = null;
  }

  store.manifest = root;
  store.shards = sheets.slice(1);
  store.rootMetadata = sheets[0];
  const occupied = [...store.slots(store.rootMetadata, 'C')].sort((a, b) => a - b);
  const slots = await store.verifiedSlots(store.rootId, 'C', occupied, undefined, { preserveRaw: includeBackupData });
  const events = new Map();
  const commitProofs = [];
  for (let i = 0; i < slots.length; i++) {
    const { header, payload } = slots[i];
    if (typeof header.opId !== 'string' || header.key !== header.opId) throw new Error('Invalid commit slot identity');
    let commit;
    try { commit = JSON.parse(enc.decode(payload)); } catch { throw new Error('Invalid commit payload'); }
    if (!commit || commit.opId !== header.opId || !Array.isArray(commit.events)
      || commit.events.length < 1 || commit.events.length > PARAMS.maxEventsPerCommit) throw new Error('Invalid commit record');
    const rootFence = store.fenceReceipts?.get(store.rootId);
    if (rootFence && !rootFence.sourceSlots.includes(occupied[i])
      && (commit.epoch !== store.fenceEpoch || header.epoch !== store.fenceEpoch))
      throw new Error('Commit belongs to an unverified migration epoch');
    for (const raw of commit.events) {
      const event = validateRevision(raw), previous = events.get(event.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error('Conflicting revision ID in commit history');
      if (previous) throw new Error('Duplicate revision ID in commit history');
      events.set(event.id, event);
    }
    commitProofs.push({ slot: occupied[i], opId: header.opId, hash: header.hash });
  }
  const eventList = [...events.values()];
  const migratedSets = root?.schema === 3 ? validateMigratedEventSets(eventList, root) : null;
  if (migratedSets) { /* validates active and hidden namespaces independently */ }
  else materialize(eventList);
  const progressState = classifyMigrationProgress({ root, shards, events: eventList, scopePath, rootId: store.rootId });
  const preview = progressState.plan || (() => {
    const hidden = validateLegacyQuarantine(root), mapped = validateLegacyPathMap(root)?.revisionIds || new Set();
    const migrated = new Set([...hidden, ...mapped]);
    const rawPathCount = migratedSets ? migratedSets.activeHeads.size + migratedSets.quarantinedHeads.size : materialize(eventList).size;
    const visible = migratedSets?.visible || eventList;
    const mappedPaths = new Set((migratedSets?.mappedEvents || eventList).filter(event => mapped.has(event.id)).map(event => event.path));
    const activeHeads = migratedSets?.activeHeads || materialize(visible);
    const includedCurrentPathCount = [...activeHeads.keys()].filter(path => mappedPaths.has(path)).length;
    const hiddenPathCount = migratedSets ? migratedSets.quarantinedHeads.size : 0;
    return { report: Object.freeze({ sourceSchema: 2, targetSchema: 3,
      revisionCount: eventList.length, currentPathCount: rawPathCount,
      pathCounts: Object.freeze({ 'inside-selected-folder': mapped.size, 'outside-selected-folder': hidden.size, 'case-ambiguous': 0 }),
      quarantinedRevisionCount: hidden.size,
      activeLegacyRevisionCount: mapped.size, activeProjectEventCount: eventList.length - migrated.size,
      includedCurrentPathCount, quarantinedCurrentPathCount: hiddenPathCount,
      payloadRecordsChanged: 0, payloadBytesChanged: 0, localScope: scopePath, remoteWrites: 0 }) };
  })();

  let blobSummary = { uniqueReferencedBlobs: 0, referencedBlobBytes: 0, indexedBlobGroups: null };
  if (verifyBlobs) {
    store.blobIndex = null;
    store.blobIndexPromise = null;
    const index = await store.blobSlots();
    await store.validateSnapshot(eventList);
    const referenced = [...new Set(eventList.map(event => event.hash).filter(Boolean))];
    blobSummary = {
      uniqueReferencedBlobs: referenced.length,
      referencedBlobBytes: referenced.reduce((sum, hash) => sum + [...index.get(hash).records.values()].reduce((n, part) => n + part.length, 0), 0),
      indexedBlobGroups: index.size
    };
  }

  const eventFingerprint = await digest({ commits: commitProofs, eventIds: [...events.keys()].sort() });
  const dataProof = [];
  const backupSlots = new Map([[store.rootId, slots.map((record, offset) => ({ kind: 'C', slot: occupied[offset], rows: record.rawRows }))]]);
  for (let index = 0; index < shards.length; index++) {
    const id = root.shardIds[index], occupied = [...store.slots(sheets[index + 1], 'D')].sort((a, b) => a - b);
    const records = await store.verifiedSlots(id, 'D', occupied, undefined, { preserveRaw: includeBackupData });
    dataProof.push({ id, records: records.map((record, offset) => ({ slot: occupied[offset], header: record.header })) });
    if (includeBackupData) backupSlots.set(id, records.map((record, offset) => ({ kind: 'D', slot: occupied[offset], rows: record.rawRows })));
  }
  const [teamPlugins, metaValues] = await Promise.all([
    store.values(store.rootId, 'TeamPlugins!A1:C'),
    includeBackupData ? Promise.all(ids.map(id => store.values(id, fenced ? 'Meta!A1:B3' : 'Meta!A1:B2'))) : Promise.resolve(null)
  ]);
  const fingerprint = await digest({ root, shards, rawRoot, rawShards, files, sheets,
    fenceReceipts: fenced ? [...store.fenceReceipts.values()] : [],
    commits: commitProofs, eventIds: [...events.keys()].sort(), dataProof, teamPlugins: teamPlugins.values || [] });
  const backupSheets = includeBackupData ? await Promise.all(ids.map(async (id, index) => ({
    id,
    manifest: index === 0 ? rawRoot : rawShards[index - 1],
    metadata: sheets[index],
    fileMetadata: { id: files[index].id, mimeType: files[index].mimeType, parents: [...files[index].parents],
      trashed: files[index].trashed, driveId: files[index].driveId || null },
    metaCells: metaValues[index].values || [],
    occupiedSlots: [...backupSlots.get(id)].map(item => item.slot),
    slots: await Promise.all(backupSlots.get(id).map(async item => ({ ...item, sha256: await slotDigest(item.rows) }))),
    ...(index === 0 ? { teamPluginsRows: teamPlugins.values || [] } : {})
  }))) : undefined;
  return { preview, progressState, fingerprint, eventFingerprint, blobSummary, root, shards, events: eventList, backupSheets };
}

/** Authenticated, double-read project state for the guarded runner; raw event paths remain in memory only. */
async function readOnlyMigrationSnapshot({ store, scopePath, verifyBlobs = false, includeBackupData = false } = {}) {
  if (!store || typeof store.manifestFor !== 'function' || typeof store.verifiedSlots !== 'function')
    throw new Error('Read-only project store is unavailable');
  safeScope(scopePath);
  if (includeBackupData && !verifyBlobs) throw new Error('A complete backup requires blob hash verification');
  const first = await readPass(store, scopePath, verifyBlobs, includeBackupData);
  store.finishPass?.();
  store.blobIndex = null;
  store.blobIndexPromise = null;
  const second = await readPass(store, scopePath, false, false);
  if (first.fingerprint !== second.fingerprint) throw new Error('Project changed during preview; pause all clients and retry');
  return { ...first.preview.report, ...first.blobSummary,
    snapshotFingerprint: first.fingerprint, fingerprint: first.fingerprint, eventFingerprint: first.eventFingerprint,
    root: first.root, shards: first.shards, events: first.events, migrationState: first.progressState.state,
    stableSnapshot: true, remoteWrites: 0,
    ...(includeBackupData ? { backupSnapshot: {
      stableSnapshot: true, verifyBlobs: true, remoteWrites: 0, capturedAt: new Date().toISOString(),
      project: { rootId: first.root.rootId, shardIds: [...first.root.shardIds], folderId: first.root.folderId },
      fingerprint: first.fingerprint, eventFingerprint: first.eventFingerprint, sheets: first.backupSheets
    } } : {}) };
}

/** Full sensitive backup bytes stay in memory for the explicit caller; normal preview remains counts/hashes only. */
async function readOnlyVerifiedMigrationBackup(options = {}) {
  const snapshot = await readOnlyMigrationSnapshot({ ...options, verifyBlobs: true, includeBackupData: true });
  return encodeBackup(await buildVerifiedBackup(snapshot.backupSnapshot));
}

/** UI-safe view: counts and hashes only, no event paths or contents. */
async function readOnlySchema2MigrationPreview(options = {}) {
  const snapshot = await readOnlyMigrationSnapshot({ ...options, verifyBlobs: true });
  const { root, shards, events, ...summary } = snapshot;
  return Object.freeze({ ...summary, projectRootId: root.rootId, shardIds: [...root.shardIds] });
}

module.exports = { readOnlySchema2MigrationPreview, readOnlyMigrationSnapshot, readOnlyVerifiedMigrationBackup };
