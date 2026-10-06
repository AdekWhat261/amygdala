'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PARAMS } = require('../src/team-sharded-store.cjs');
const { TeamShardedStore } = require('../src/team-sharded-store.cjs');
const { LocalVault } = require('../src/local.cjs');
const { previewSchema2Migration, activeEventsAfterQuarantine, classifyMigrationProgress } = require('../src/legacy-migration-preview.cjs');
const { validateLegacyQuarantine, validateLegacyPathMap } = require('../src/legacy-quarantine.cjs');

function sourceManifests() {
  const rootId = 'root_12345678';
  const shardIds = Array.from({ length: 8 }, (_, i) => `shard_${String(i).padStart(2, '0')}_123`);
  const root = { schema: 2, type: 'amygdala-team-sharded', version: 4, rootId, name: 'local fixture',
    vaultId: 'vault_12345678', folderId: 'folder_12345678', shardIds, params: PARAMS, paramsDigest: 'a'.repeat(64) };
  const shards = shardIds.map((shardId, index) => ({ schema: 2, type: 'amygdala-team-sharded', version: 4,
    vaultId: root.vaultId, rootId, folderId: root.folderId, shardId, index, paramsDigest: root.paramsDigest }));
  return { rootId, root, shards };
}
const events = [
  { id: 'legacy_0001', path: 'Amygdala Beta1 QA/Shared/Board.canvas', hash: 'b'.repeat(64), parents: [] },
  { id: 'legacy_0002', path: 'Old/Shared/Note.md', hash: 'c'.repeat(64), parents: [] },
  { id: 'legacy_0003', path: 'Amygdala Beta1 QA/Private/secret.md', hash: 'd'.repeat(64), parents: [] }
];

test('preview rebases in-scope legacy paths and quarantines only revisions outside selected folder', () => {
  const { root, shards } = sourceManifests();
  const before = JSON.stringify({ root, shards, events });
  const result = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(JSON.stringify({ root, shards, events }), before);
  assert.equal(result.rootManifest.schema, 3);
  assert.equal(result.rootManifest.pathProtocol, 'project-relative-v1');
  assert.equal(result.rootManifest.namespace, root.rootId);
  assert.equal(result.rootManifest.folderId, root.folderId);
  assert.deepEqual(result.rootManifest.legacyQuarantine.revisionIds, ['legacy_0002', 'legacy_0003']);
  assert.deepEqual(result.rootManifest.legacyPathMap, { protocol: 'prefix-rebase-v1', prefix: 'Amygdala Beta1 QA/Shared', revisionIds: ['legacy_0001'] });
  assert.equal(result.shardManifests.length, 8);
  assert.ok(result.shardManifests.every(shard => shard.schema === 3 && shard.namespace === root.rootId));
  assert.equal(result.report.pathCounts['inside-selected-folder'], 1);
  assert.equal(result.report.pathCounts['outside-selected-folder'], 2);
  assert.equal(result.report.quarantinedRevisionCount, 2);
  assert.equal(result.report.activeLegacyRevisionCount, 1);
  assert.equal(result.report.includedCurrentPathCount, 1);
  assert.equal(result.report.quarantinedCurrentPathCount, 2);
  assert.equal(result.report.payloadRecordsChanged, 0);
  assert.equal(result.report.remoteWrites, 0);
  assert.deepEqual(activeEventsAfterQuarantine(events, result.rootManifest), [{ ...events[0], path: 'Board.canvas' }]);
});

test('new project-relative events remain unchanged even when their text starts with the legacy prefix', () => {
  const { root, shards } = sourceManifests();
  const result = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const fresh = { id: 'new_0001', path: 'Amygdala Beta1 QA/Shared/New.md', hash: 'e'.repeat(64), parents: [] };
  assert.deepEqual(activeEventsAfterQuarantine([...events, fresh], result.rootManifest), [
    { ...events[0], path: 'Board.canvas' }, fresh
  ]);
});

test('same rebased project paths map under different participant folders', () => {
  const { root, shards } = sourceManifests();
  const plan = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const projectPath = activeEventsAfterQuarantine(events, plan.rootManifest)[0].path;
  const alice = new LocalVault({ vault: {} }, { scopePath: 'Fixture Alice/TeamA' });
  const bob = new LocalVault({ vault: {} }, { scopePath: 'Fixture Bob/SharedProject' });
  assert.equal(projectPath, 'Board.canvas');
  assert.equal(alice.localPath(projectPath), 'Fixture Alice/TeamA/Board.canvas');
  assert.equal(bob.localPath(projectPath), 'Fixture Bob/SharedProject/Board.canvas');
});

test('rebase rejects portable path collisions and file-directory collisions before migration', () => {
  const { root, shards } = sourceManifests();
  const variants = [
    [
      { id: 'map_id_0001', path: 'Amygdala Beta1 QA/Shared/Case.md', hash: 'a'.repeat(64), parents: [] },
      { id: 'map_id_0002', path: 'Amygdala Beta1 QA/Shared/case.md', hash: 'b'.repeat(64), parents: [] }
    ],
    [
      { id: 'map_id_0001', path: 'Amygdala Beta1 QA/Shared/Folder', hash: 'a'.repeat(64), parents: [] },
      { id: 'map_id_0002', path: 'Amygdala Beta1 QA/Shared/Folder/Child.md', hash: 'b'.repeat(64), parents: [] }
    ]
  ];
  for (const sample of variants) assert.throws(() => previewSchema2Migration({ root, shards, events: sample,
    scopePath: 'Amygdala Beta1 QA/Shared' }), /collision/i);
});

test('mapped history must remain inside the selected folder and mapping IDs must exist', () => {
  const { root, shards } = sourceManifests();
  const result = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const wrongPath = events.map(event => ({ ...event })); wrongPath[0].path = 'Other/Board.canvas';
  assert.throws(() => activeEventsAfterQuarantine(wrongPath, result.rootManifest), /escaped|missing/i);
  assert.throws(() => activeEventsAfterQuarantine(events.slice(1), result.rootManifest), /missing/i);
  assert.throws(() => previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/../Private' }));
});

test('rejects mixed or already migrated source manifests and unsafe scope inputs', () => {
  const { root, shards } = sourceManifests();
  const mixed = shards.map(shard => ({ ...shard })); mixed[7].schema = 3;
  assert.throws(() => previewSchema2Migration({ root, shards: mixed, events, scopePath: 'Shared' }));
  assert.throws(() => previewSchema2Migration({ root, shards, events, scopePath: '../Shared' }));
  assert.throws(() => previewSchema2Migration({ root: { ...root, namespace: root.rootId }, shards, events, scopePath: 'Shared' }));
});

test('quarantine validator rejects malformed, duplicate, unsorted, and oversized markers', () => {
  for (const marker of [
    { protocol: 'wrong', revisionIds: [] },
    { protocol: 'preserve-hidden-v1', revisionIds: ['bad/path'] },
    { protocol: 'preserve-hidden-v1', revisionIds: ['legacy_0001', 'legacy_0001'] },
    { protocol: 'preserve-hidden-v1', revisionIds: ['legacy_0002', 'legacy_0001'] },
    { protocol: 'preserve-hidden-v1', revisionIds: Array.from({ length: 400 }, (_, i) => `a${String(i).padStart(127, '0')}`) }
  ]) assert.throws(() => validateLegacyQuarantine({ legacyQuarantine: marker }));
  assert.deepEqual([...validateLegacyQuarantine({})], []);
});

test('path-map validator rejects unsafe prefixes, missing protocol, duplicate IDs, and overlap', () => {
  for (const marker of [
    { protocol: 'wrong', prefix: 'Team', revisionIds: [] },
    { protocol: 'prefix-rebase-v1', prefix: '../Team', revisionIds: [] },
    { protocol: 'prefix-rebase-v1', prefix: 'Team', revisionIds: ['legacy_0001', 'legacy_0001'] },
    { protocol: 'prefix-rebase-v1', prefix: 'Team', revisionIds: ['legacy_0002', 'legacy_0001'] }
  ]) assert.throws(() => validateLegacyPathMap({ legacyPathMap: marker }));
  assert.throws(() => validateLegacyPathMap({ legacyQuarantine: { protocol: 'preserve-hidden-v1', revisionIds: ['legacy_0001'] },
    legacyPathMap: { protocol: 'prefix-rebase-v1', prefix: 'Team', revisionIds: ['legacy_0001'] } }), /overlap/i);
});

test('v4 reader hides quarantined revisions but keeps them in collision checks and leaves writes untouched', async () => {
  const rootId = 'root_12345678';
  const legacy = events[0], fresh = { id: 'new_12345', path: 'Board.canvas', hash: 'e'.repeat(64), parents: [] };
  const commit = Buffer.from(JSON.stringify({ opId: 'commit_123', events: [legacy, fresh] }));
  const hash = crypto.createHash('sha256').update(commit).digest('hex');
  const header = { opId: 'commit_123', key: 'commit_123', hash, payloadHash: hash, size: commit.length, blocks: 1 };
  const root = { legacyQuarantine: { protocol: 'preserve-hidden-v1', revisionIds: [legacy.id] } };
  const store = new TeamShardedStore({ request: async () => {}, getAccessToken: async () => 'test-token', rootId,
    limiter: { acquire: async () => {}, defer() {} } });
  store.manifest = root;
  store.call = async url => String(url).includes('/values:batchGet?')
    ? { valueRanges: [{ values: [[JSON.stringify(header), commit.toString('base64')]] }] }
    : { spreadsheetId: rootId, namedRanges: [{ name: 'AS4_C_000', range: { sheetId: 2, startRowIndex: 1, endRowIndex: 5 } }] };
  let writes = 0;
  store.claim = async () => { writes++; };
  const listed = await store.listEvents();
  assert.deepEqual(listed.map(event => event.id), [fresh.id]);
  await store.putEvents([legacy]);
  assert.equal(writes, 0, 'an archived legacy ID must not be re-used or rewritten');
  await assert.rejects(store.putEvents([{ ...legacy, path: 'different.md' }]), /reused|ID|v4/i);
  assert.equal(writes, 0);
});

test('v4 reader projects mapped legacy paths while retaining raw IDs for idempotent writes', async () => {
  const rootId = 'root_12345678';
  const legacy = { id: 'legacy_0001', path: 'Amygdala Beta1 QA/Shared/Board.canvas', hash: 'b'.repeat(64), parents: [] };
  const outside = { id: 'legacy_0002', path: 'Private/Do-not-show.md', hash: 'c'.repeat(64), parents: [] };
  const fresh = { id: 'new_0001', path: 'Amygdala Beta1 QA/Shared/New.md', hash: 'd'.repeat(64), parents: [] };
  const commit = Buffer.from(JSON.stringify({ opId: 'commit_123', events: [legacy, outside, fresh] }));
  const hash = crypto.createHash('sha256').update(commit).digest('hex');
  const header = { opId: 'commit_123', key: 'commit_123', hash, payloadHash: hash, size: commit.length, blocks: 1 };
  const root = { legacyQuarantine: { protocol: 'preserve-hidden-v1', revisionIds: [outside.id] },
    legacyPathMap: { protocol: 'prefix-rebase-v1', prefix: 'Amygdala Beta1 QA/Shared', revisionIds: [legacy.id] } };
  const store = new TeamShardedStore({ request: async () => {}, getAccessToken: async () => 'test-token', rootId,
    limiter: { acquire: async () => {}, defer() {} } });
  store.manifest = root;
  store.call = async url => String(url).includes('/values:batchGet?')
    ? { valueRanges: [{ values: [[JSON.stringify(header), commit.toString('base64')]] }] }
    : { spreadsheetId: rootId, namedRanges: [{ name: 'AS4_C_000', range: { sheetId: 2, startRowIndex: 1, endRowIndex: 5 } }] };
  let writes = 0; store.claim = async () => { writes++; };
  assert.deepEqual(await store.listEvents(), [{ ...legacy, path: 'Board.canvas' }, fresh]);
  await store.putEvents([legacy]);
  assert.equal(writes, 0, 'the mapped legacy ID remains in the raw event index');
  await assert.rejects(store.putEvents([{ ...legacy, path: 'Different.md' }]), /reused|ID|v4/i);
  assert.equal(writes, 0);
});

test('recovery classifier resumes shard-first partial updates and root last', () => {
  const { root, shards } = sourceManifests();
  const plan = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const mixed = shards.map((shard, index) => index < 3 ? plan.shardManifests[index] : shard);
  const progress = classifyMigrationProgress({ root, shards: mixed, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(progress.state, 'partial');
  assert.equal(progress.appliedShardIds.length, 3);
  assert.deepEqual(progress.remainingOrder, [...root.shardIds.slice(3), root.rootId]);
  assert.equal(progress.canRollbackWithoutDataLoss, true);
});

test('partial quarantine/rebase remains rollback-safe only until a post-migration event exists', () => {
  const { root, shards } = sourceManifests();
  const plan = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const complete = classifyMigrationProgress({ root: plan.rootManifest, shards: plan.shardManifests, events,
    scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(complete.state, 'complete');
  assert.equal(complete.canRollbackWithoutDataLoss, true);
  const fresh = { id: 'fresh_0001', path: 'New.md', hash: null, parents: [] };
  const afterSync = classifyMigrationProgress({ root: plan.rootManifest, shards: plan.shardManifests, events: [...events, fresh],
    scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(afterSync.state, 'complete');
  assert.equal(afterSync.activeEventCount, 2);
  assert.equal(afterSync.canRollbackWithoutDataLoss, false);
});

test('rollback with root quarantine and mixed shard schemas is resumable and rejects new events', () => {
  const { root, shards } = sourceManifests();
  const plan = previewSchema2Migration({ root, shards, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  const mixed = shards.map((shard, index) => index < 3 ? shard : plan.shardManifests[index]);
  const progress = classifyMigrationProgress({ root: plan.rootManifest, shards: mixed, events, scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(progress.state, 'rollback-partial');
  assert.equal(progress.canRollbackWithoutDataLoss, true);
  assert.deepEqual(progress.remainingOrder, [...root.shardIds.slice(3), root.rootId]);
  const concurrent = [...events, { id: 'new_12345', path: 'New.md', hash: null, parents: [] }];
  const changed = classifyMigrationProgress({ root: plan.rootManifest, shards: mixed, events: concurrent, scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(changed.state, 'rollback-partial');
  assert.equal(changed.canRollbackWithoutDataLoss, false);
});
