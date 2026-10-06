'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARAMS, digest } = require('../src/team-sharded-store.cjs');
const { executeSchema2Migration, rollbackSchema2Migration } = require('../src/legacy-migration-runner.cjs');

async function adapterFixture({ crashAfter = Infinity, newEventAfterWrite = false,
  initialEvents = [{ id: 'legacy_0001', path: 'Old/Note.md', hash: null, parents: [] }] } = {}) {
  const rootId = 'root_12345678';
  const shardIds = Array.from({ length: 8 }, (_, i) => `shard_${String(i).padStart(2, '0')}_123`);
  const root = { schema: 2, type: 'amygdala-team-sharded', version: 4, rootId, name: 'fixture', vaultId: 'vault_12345678',
    folderId: 'folder_12345678', shardIds, params: PARAMS, paramsDigest: await digest(PARAMS) };
  const shards = shardIds.map((shardId, index) => ({ schema: 2, type: 'amygdala-team-sharded', version: 4,
    vaultId: root.vaultId, rootId, folderId: root.folderId, shardId, index, paramsDigest: root.paramsDigest }));
  let events = structuredClone(initialEvents), writes = 0, mutate = newEventAfterWrite;
  const adapter = {
    async readSnapshot() {
      const currentRoot = structuredClone(root), currentShards = structuredClone(shards), currentEvents = structuredClone(events);
      return { root: currentRoot, shards: currentShards, events: currentEvents, stableSnapshot: true,
        fingerprint: await digest({ root: currentRoot, shards: currentShards, events: currentEvents }),
        eventFingerprint: await digest(currentEvents) };
    },
    async readManifest(id) { return structuredClone(id === rootId ? root : shards.find(shard => shard.shardId === id)); },
    async readEventFingerprint() { return digest(events); },
    async writeManifest(id, expected, target) {
      const current = id === rootId ? root : shards.find(shard => shard.shardId === id);
      assert.deepEqual(current, expected, 'adapter compares exact current Meta!B2 immediately before its write');
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, structuredClone(target));
      writes++;
      if (mutate) { events.push({ id: 'fresh_0001', path: 'Board.md', hash: null, parents: [] }); mutate = false; }
      if (writes === crashAfter) throw new Error('simulated process crash after a completed sheet update');
    }
  };
  return { adapter, root, shards, getWrites: () => writes,
    appendEvent: event => events.push(structuredClone(event)) };
}

async function approvedOptions(adapter, scopePath = 'Amygdala Beta1 QA/Shared') {
  const snapshot = await adapter.readSnapshot();
  return { adapter, scopePath, approved: true, syncPaused: true, expectedFingerprint: snapshot.fingerprint };
}

test('explicit runner updates only 8 shards then root, with per-sheet compare and read-back', async () => {
  const f = await adapterFixture();
  const result = await executeSchema2Migration(await approvedOptions(f.adapter));
  assert.equal(result.state, 'complete');
  assert.equal(result.writes, 9);
  assert.equal(f.root.schema, 3);
  assert.ok(f.shards.every(shard => shard.schema === 3));
});

test('runner refuses without explicit approval or paused-participant attestation', async () => {
  const f = await adapterFixture();
  const options = await approvedOptions(f.adapter);
  await assert.rejects(executeSchema2Migration({ ...options, approved: false }), /Explicit migration approval/);
  await assert.rejects(executeSchema2Migration({ ...options, syncPaused: false }), /All participants must be paused/);
  assert.equal(f.getWrites(), 0);
});

test('a crash after shard writes is resumable from a fresh preview and leaves root schema 2 until last', async () => {
  const f = await adapterFixture({ crashAfter: 2 });
  const first = await approvedOptions(f.adapter);
  await assert.rejects(executeSchema2Migration(first), /simulated process crash/);
  assert.equal(f.root.schema, 2);
  assert.equal(f.shards.filter(shard => shard.schema === 3).length, 2);
  const resumed = await executeSchema2Migration(await approvedOptions(f.adapter));
  assert.equal(resumed.state, 'complete');
  assert.equal(f.getWrites(), 9);
});

test('concurrent history change stops rollout; root remains schema 2 and review is required', async () => {
  const f = await adapterFixture({ newEventAfterWrite: true });
  await assert.rejects(executeSchema2Migration(await approvedOptions(f.adapter)), /history change/);
  assert.equal(f.root.schema, 2);
  assert.equal(f.shards[0].schema, 3);
});

test('rollback restores shards first and the quarantine-bearing root last', async () => {
  const f = await adapterFixture();
  await executeSchema2Migration(await approvedOptions(f.adapter));
  const rollback = await rollbackSchema2Migration(await approvedOptions(f.adapter));
  assert.equal(rollback.state, 'source');
  assert.equal(rollback.writes, 9);
  assert.equal(f.root.schema, 2);
  assert.ok(f.shards.every(shard => shard.schema === 2));
});

test('interrupted rollback resumes only while the full legacy history remains quarantined', async () => {
  const f = await adapterFixture();
  await executeSchema2Migration(await approvedOptions(f.adapter));
  // Simulate a process crash after two shard restores. The root still carries quarantine.
  let writes = f.getWrites();
  const originalWrite = f.adapter.writeManifest;
  f.adapter.writeManifest = async (...args) => {
    await originalWrite(...args);
    writes++;
    if (writes === 11) throw new Error('simulated rollback crash');
  };
  await assert.rejects(rollbackSchema2Migration(await approvedOptions(f.adapter)), /simulated rollback crash/);
  assert.equal(f.root.schema, 3);
  assert.equal(f.shards.filter(shard => shard.schema === 2).length, 2);
  f.adapter.writeManifest = originalWrite;
  assert.equal((await rollbackSchema2Migration(await approvedOptions(f.adapter))).state, 'source');
  assert.equal(f.root.schema, 2);

  const g = await adapterFixture();
  await executeSchema2Migration(await approvedOptions(g.adapter));
  let changed = false;
  const write = g.adapter.writeManifest;
  g.adapter.writeManifest = async (...args) => {
    await write(...args);
    if (!changed) { changed = true; g.appendEvent({ id: 'new_12345', path: 'New.md', hash: null, parents: [] }); }
  };
  await assert.rejects(rollbackSchema2Migration(await approvedOptions(g.adapter)), /history change/);
  g.adapter.writeManifest = write;
  await assert.rejects(rollbackSchema2Migration(await approvedOptions(g.adapter)), /Rollback is unsafe/);
  assert.equal(g.root.schema, 3, 'quarantine remains active when concurrent project history prevents rollback');
});

test('rollback is rejected if post-migration shared events were written', async () => {
  const f = await adapterFixture();
  await executeSchema2Migration(await approvedOptions(f.adapter));
  // Model a fresh project-relative revision that exists outside the immutable legacy set.
  f.appendEvent({ id: 'new_12345', path: 'New.md', hash: null, parents: [] });
  await assert.rejects(rollbackSchema2Migration(await approvedOptions(f.adapter)), /Rollback is unsafe/);
});

test('partial path migration rolls back before new writes and refuses rollback after a project-relative child exists', async () => {
  const initialEvents = [
    { id: 'legacy_0001', path: 'Amygdala Beta1 QA/Shared/Board.md', hash: null, parents: [] },
    { id: 'legacy_0002', path: 'Outside/Private.md', hash: null, parents: [] }
  ];
  const f = await adapterFixture({ initialEvents });
  await executeSchema2Migration(await approvedOptions(f.adapter));
  assert.deepEqual(f.root.legacyPathMap.revisionIds, ['legacy_0001']);
  assert.deepEqual(f.root.legacyQuarantine.revisionIds, ['legacy_0002']);
  const rollback = await rollbackSchema2Migration(await approvedOptions(f.adapter));
  assert.equal(rollback.state, 'source');
  assert.equal(f.root.schema, 2);
  assert.equal(f.root.legacyPathMap, undefined);

  const g = await adapterFixture({ initialEvents });
  await executeSchema2Migration(await approvedOptions(g.adapter));
  g.appendEvent({ id: 'fresh_0001', path: 'Board.md', hash: null, parents: ['legacy_0001'] });
  await assert.rejects(rollbackSchema2Migration(await approvedOptions(g.adapter)), /Rollback is unsafe/);
  assert.equal(g.root.schema, 3, 'a project-relative descendant keeps the mapping active');
});
