'use strict';

const { materialize, validateRevision } = require('./journal.cjs');
const { PARAMS } = require('./team-sharded-store.cjs');
const { normalizeFolderPath, planSync } = require('./planner.cjs');
const { QUARANTINE_PROTOCOL, PATH_MAP_PROTOCOL, MAX_QUARANTINE_BYTES, validateLegacyQuarantine, validateLegacyPathMap, validateMigratedEventSets, visibleEvents } = require('./legacy-quarantine.cjs');
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function activeEventsAfterQuarantine(events, root) {
  return visibleEvents(events, root);
}

function schema2RootAndShardsValid(root, shards, rootId) {
  if (!root || root.type !== 'amygdala-team-sharded' || root.version !== 4 || root.schema !== 2
    || root.rootId !== rootId || !ID.test(root.vaultId || '') || !ID.test(root.folderId || '')
    || !Array.isArray(root.shardIds) || root.shardIds.length !== 8 || new Set(root.shardIds).size !== 8
    || root.shardIds.some(id => !ID.test(id) || id === rootId) || canonical(root.params) !== canonical(PARAMS)
    || !HASH.test(root.paramsDigest || '') || shards.length !== 8 || root.pathProtocol !== undefined
    || root.namespace !== undefined || root.legacyQuarantine !== undefined || root.legacyPathMap !== undefined) return false;
  return shards.every((shard, index) => shard?.type === 'amygdala-team-sharded' && shard.version === 4 && shard.schema === 2
    && shard.vaultId === root.vaultId && shard.rootId === rootId && shard.folderId === root.folderId
    && shard.shardId === root.shardIds[index] && shard.index === index && shard.paramsDigest === root.paramsDigest
    && shard.pathProtocol === undefined && shard.namespace === undefined);
}

function classifyLegacyPath(path, scopePath) {
  if (path.startsWith(`${scopePath}/`)) return 'inside-selected-folder';
  const fold = value => value.normalize('NFC').toUpperCase().toLowerCase();
  if (fold(path).startsWith(`${fold(scopePath)}/`)) return 'case-ambiguous';
  return 'outside-selected-folder';
}

function sourceRootFromV3(root, rootId) {
  if (!root || root.schema !== 3 || root.pathProtocol !== 'project-relative-v1' || root.namespace !== rootId) return null;
  try { validateLegacyQuarantine(root); validateLegacyPathMap(root); } catch { return null; }
  const source = { ...root, schema: 2 };
  delete source.pathProtocol; delete source.namespace; delete source.legacyQuarantine; delete source.legacyPathMap;
  return source;
}

function sourceShardFromV3(shard, rootId) {
  if (!shard || shard.schema !== 3 || shard.pathProtocol !== 'project-relative-v1' || shard.namespace !== rootId) return null;
  const source = { ...shard, schema: 2 };
  delete source.pathProtocol; delete source.namespace;
  return source;
}

/** Classifies a crash-safe shard-first/root-last migration state; it performs no I/O. */
function classifyMigrationProgress({ root, shards, events, scopePath, rootId = root?.rootId } = {}) {
  if (!Array.isArray(shards) || shards.length !== 8 || !Array.isArray(events)) throw new Error('Incomplete migration snapshot');
  const revisions = events.map(validateRevision);
  if (new Set(revisions.map(event => event.id)).size !== revisions.length) throw new Error('Duplicate migration revision ID');
  if (root?.schema === 3) validateMigratedEventSets(revisions, root);
  else materialize(revisions);

  if (root?.schema === 2) {
    const sourceShards = shards.map(shard => shard?.schema === 2 ? shard : sourceShardFromV3(shard, rootId));
    if (sourceShards.some(shard => !shard) || !schema2RootAndShardsValid(root, sourceShards, rootId))
      throw new Error('Unexpected mixed migration state; refusing recovery');
    const plan = previewSchema2Migration({ root, shards: sourceShards, events: revisions, scopePath });
    const appliedShardIds = [];
    for (let i = 0; i < shards.length; i++) {
      if (canonical(shards[i]) === canonical(sourceShards[i])) continue;
      if (canonical(shards[i]) !== canonical(plan.shardManifests[i])) throw new Error('Shard differs from the expected migration target');
      appliedShardIds.push(shards[i].shardId);
    }
    return Object.freeze({ state: appliedShardIds.length ? 'partial' : 'source', sourceRoot: root, sourceShards,
      appliedShardIds,
      remainingOrder: [...plan.rootManifest.shardIds.filter(id => !appliedShardIds.includes(id)), rootId],
      canRollbackWithoutDataLoss: true, plan });
  }

  const sourceRoot = sourceRootFromV3(root, rootId);
  const sourceShards = shards.map(shard => shard?.schema === 2 ? shard : sourceShardFromV3(shard, rootId));
  if (!sourceRoot || sourceShards.some(shard => !shard) || !schema2RootAndShardsValid(sourceRoot, sourceShards, rootId))
    throw new Error('Unexpected mixed migration state; refusing recovery');
  const ids = new Set(revisions.map(event => event.id));
  const quarantined = validateLegacyQuarantine(root);
  const pathMap = validateLegacyPathMap(root);
  const mapped = pathMap?.revisionIds || new Set();
  const migrationIds = new Set([...quarantined, ...mapped]);
  if ([...migrationIds].some(id => !ids.has(id))) throw new Error('Migration marker references missing history; refusing recovery');
  for (const event of revisions) {
    if (!migrationIds.has(event.id)) continue;
    const expectedSet = quarantined.has(event.id) ? quarantined : mapped;
    if (event.parents.some(id => !expectedSet.has(id))) throw new Error('Migration split crosses a revision parent chain');
  }
  const expectedRoot = { ...sourceRoot, schema: 3, pathProtocol: 'project-relative-v1', namespace: rootId,
    legacyQuarantine: root.legacyQuarantine, ...(root.legacyPathMap === undefined ? {} : { legacyPathMap: root.legacyPathMap }) };
  const expectedShards = sourceShards.map(shard => ({ ...shard, schema: 3, pathProtocol: 'project-relative-v1', namespace: rootId }));
  if (canonical(root) !== canonical(expectedRoot) || shards.some((shard, i) =>
    canonical(shard) !== canonical(expectedShards[i]) && canonical(shard) !== canonical(sourceShards[i])))
    throw new Error('Completed migration manifests do not match the expected target');
  const rollbackShardIds = shards.filter((shard, index) => canonical(shard) !== canonical(sourceShards[index]))
    .map(shard => shard.shardId);
  const activeEvents = visibleEvents(revisions, root);
  materialize(activeEvents);
  const rollbackSafe = migrationIds.size > 0 && migrationIds.size === ids.size;
  if (shards.some(shard => shard.schema === 2)) return Object.freeze({ state: 'rollback-partial', sourceRoot, sourceShards,
    appliedShardIds: shards.filter((shard, index) => canonical(shard) === canonical(expectedShards[index])).map(shard => shard.shardId),
    remainingOrder: [...rollbackShardIds, rootId], canRollbackWithoutDataLoss: rollbackSafe,
    activeEventCount: activeEvents.length });
  return Object.freeze({ state: 'complete', sourceRoot, sourceShards, appliedShardIds: shards.map(shard => shard.shardId), remainingOrder: [],
    canRollbackWithoutDataLoss: rollbackSafe, activeEventCount: activeEvents.length });
}

/** Pure preview: rebase selected-prefix paths by ID and quarantine immutable events outside scope. */
function previewSchema2Migration({ root, shards, events, scopePath }) {
  if (!schema2RootAndShardsValid(root, shards, root?.rootId)) throw new Error('Legacy schema 2 manifests are inconsistent');
  scopePath = normalizeFolderPath(scopePath);
  if (!Array.isArray(events) || !events.length) throw new Error('Legacy event snapshot is empty or unavailable');
  const revisions = events.map(validateRevision);
  const ids = revisions.map(event => event.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate legacy revision ID');
  materialize(revisions);
  const pathCounts = { 'inside-selected-folder': 0, 'outside-selected-folder': 0, 'case-ambiguous': 0 };
  const heads = materialize(revisions);
  for (const event of revisions) pathCounts[classifyLegacyPath(event.path, scopePath)]++;
  const includedIds = revisions.filter(event => classifyLegacyPath(event.path, scopePath) === 'inside-selected-folder')
    .map(event => event.id).sort();
  const revisionIds = revisions.filter(event => classifyLegacyPath(event.path, scopePath) !== 'inside-selected-folder')
    .map(event => event.id).sort();
  const legacyQuarantine = { protocol: QUARANTINE_PROTOCOL, revisionIds };
  const legacyPathMap = includedIds.length ? { protocol: PATH_MAP_PROTOCOL, prefix: scopePath, revisionIds: includedIds } : undefined;
  if (new TextEncoder().encode(JSON.stringify(legacyQuarantine)).byteLength > MAX_QUARANTINE_BYTES
    || (legacyPathMap && new TextEncoder().encode(JSON.stringify(legacyPathMap)).byteLength > MAX_QUARANTINE_BYTES))
    throw new Error('Migration markers exceed the safe metadata size limit');
  const rootManifest = { ...root, schema: 3, pathProtocol: 'project-relative-v1', namespace: root.rootId, legacyQuarantine,
    ...(legacyPathMap ? { legacyPathMap } : {}) };
  if (new TextEncoder().encode(JSON.stringify(rootManifest)).byteLength > 48000)
    throw new Error('Combined migration manifest exceeds the safe metadata cell limit');
  const visible = visibleEvents(revisions, rootManifest);
  const mappedHeads = materialize(visible);
  const pathMapKeys = Object.create(null);
  for (const [path, headsForPath] of mappedHeads) pathMapKeys[path] = headsForPath.some(event => event.hash !== null) ? 'active' : 'deleted';
  planSync({ local: pathMapKeys });
  const parentIds = new Map(revisions.map(event => [event.id, event.parents]));
  for (const id of includedIds) if ((parentIds.get(id) || []).some(parent => !includedIds.includes(parent)))
    throw new Error('Selected path scope splits a legacy revision chain');
  const shardManifests = shards.map(shard => ({ ...shard, schema: 3,
    pathProtocol: 'project-relative-v1', namespace: root.rootId }));
  const report = Object.freeze({ sourceSchema: 2, targetSchema: 3, revisionCount: revisions.length,
    currentPathCount: heads.size, pathCounts: Object.freeze(pathCounts), quarantinedRevisionCount: revisionIds.length,
    activeLegacyRevisionCount: includedIds.length, activeProjectEventCount: 0,
    includedCurrentPathCount: mappedHeads.size, quarantinedCurrentPathCount: heads.size - mappedHeads.size,
    payloadRecordsChanged: 0, payloadBytesChanged: 0,
    localScope: scopePath, remoteWrites: 0 });
  return { rootManifest, shardManifests, report };
}

module.exports = { QUARANTINE_PROTOCOL, MAX_QUARANTINE_BYTES, validateLegacyQuarantine, validateLegacyPathMap, canonical, schema2RootAndShardsValid,
  activeEventsAfterQuarantine, previewSchema2Migration, classifyMigrationProgress };
