'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lockFixture, initialApproval, OldStore, rangeMarker, encode, copy } = require('../test-support/slot-lock-fixture.cjs');
const { executeSlotLocks, prepareSlotActivation, executeSlotActivation } = require('../src/locked-migration.cjs');
const { createGoogleLockAdapter, probeGoogleLockAtomicity } = require('../src/google-locked-migration.cjs');
const { sha256 } = require('../src/drive.cjs');
const { hasActivationRange } = require('../src/slot-fence.cjs');
const { readLockedMigrationSnapshot } = require('../src/locked-migration-snapshot.cjs');
const { buildVerifiedBackup, encodeBackup } = require('../src/verified-backup.cjs');
const { verifyBackupWithReader } = require('../src/backup-reader-verification.cjs');

test('root allocation locks first; 378 source revisions and raw manifests remain unchanged', async () => {
  const f = await lockFixture({ revisionCount: 378 });
  const before = JSON.stringify([...f.books].map(([id, book]) => ({ id, rows: [...book.rows], manifest: book.manifest })));
  const result = await executeSlotLocks(initialApproval(f));
  assert.equal(result.state, 'locked-awaiting-final-backup'); assert.equal(result.activationWrites, 0);
  assert.deepEqual(f.lockBatches.map(batch => batch.id), [f.rootId, ...f.shardIds]);
  assert.equal(JSON.stringify([...f.books].map(([id, book]) => ({ id, rows: [...book.rows], manifest: book.manifest }))), before);
  await assert.rejects(f.make().assertAccess(), /заблокировано/);
  assert.equal(hasActivationRange(f.books.get(f.rootId).metadata), false);
});

test('wrong initial approval, backup, and atomicity proofs have zero mutations', async () => {
  const f = await lockFixture();
  for (const changes of [{ approved: false }, { syncPaused: false }, { approvalFingerprint: 'b'.repeat(64) },
    { backupProof: undefined }, { atomicFenceProof: { ...initialApproval(f).atomicFenceProof, sourceFingerprint: 'b'.repeat(64) } }])
    await assert.rejects(executeSlotLocks(initialApproval(f, changes)));
  assert.equal(f.lockBatches.length, 0); assert.equal(f.getLockAttempts(), 0);
});

test('an old C writer winning the first root batch causes atomic failure before any shard lock', async () => {
  const f = await lockFixture(), batch = f.store.batch;
  let raced = false;
  f.store.batch = async (id, requests) => {
    if (!raced && id === f.rootId) {
      raced = true;
      await f.record(f.rootId, 'C', 1, { opId: 'commit_late', events: [{ id: 'late_0001', path: 'Private/Late.md', hash: null, parents: [] }] },
        { opId: 'commit_late', key: 'commit_late' });
    }
    return batch(id, requests);
  };
  await assert.rejects(executeSlotLocks(initialApproval(f)));
  assert.equal(f.lockBatches.length, 0);
  assert.ok(f.shardIds.every(id => !f.books.get(id).lock));
  assert.ok(!f.books.get(f.rootId).lock);
});

test('late D allocations are preserved and dynamically adopted without replacing existing receipts', async () => {
  const f = await lockFixture(), batch = f.store.batch, bytes = new Uint8Array([1, 2, 3]), key = await sha256(bytes);
  let raced = false;
  f.store.batch = async (id, requests) => {
    if (!raced && id === f.shardIds[0]) {
      raced = true;
      await f.record(id, 'D', 0, bytes, { opId: `blob_${key}_0`, key, part: 0, parts: 1 });
    }
    return batch(id, requests);
  };
  const result = await executeSlotLocks(initialApproval(f));
  assert.equal(result.shardLocks[0].sourceSlots.length, 1);
  assert.deepEqual(result.shardLocks[0].approvedSourceSlots, []);
  assert.equal(f.getLockAttempts(), 10);
  assert.deepEqual((await f.store.verifiedSlot(f.shardIds[0], 'D', 0)).payload, bytes);
  const snapshot = JSON.stringify([...f.books].map(([id, book]) => ({ id, lock: book.lock })));
  await executeSlotLocks(initialApproval(f));
  assert.equal(f.lockBatches.length, 9);
  assert.equal(JSON.stringify([...f.books].map(([id, book]) => ({ id, lock: book.lock }))), snapshot);
});

test('every lock-boundary interruption resumes the same immutable plan and excludes old C writes', async () => {
  for (let cut = 1; cut <= 9; cut++) {
    const f = await lockFixture(), claim = f.adapter.claimLock;
    const interrupted = { ...f.adapter, claimLock: async id => {
      await claim(id);
      if (f.lockBatches.length === cut) throw new Error('Synthetic lost response');
    }, readState: async id => {
      if (f.lockBatches.length === cut) throw new Error('Synthetic process exit');
      return f.adapter.readState(id);
    } };
    await assert.rejects(executeSlotLocks(initialApproval(f, { adapter: interrupted })));
    const old = f.make(OldStore);
    old.manifest = copy(f.root); old.rootMetadata = { ...copy(f.books.get(f.rootId).metadata), namedRanges: [rangeMarker('C', 0)] };
    old.shards = f.shardIds.map(id => ({ ...copy(f.books.get(id).metadata), namedRanges: [] }));
    await assert.rejects(old.claim(f.rootId, 'C', encode({ opId: 'commit_late', events: [f.legacy] }),
      { opId: 'commit_late', key: 'commit_late' }));
    const result = await executeSlotLocks(initialApproval(f, { adapter: createGoogleLockAdapter({ store: f.make(), plan: f.plan }) }));
    assert.equal(result.state, 'locked-awaiting-final-backup'); assert.equal(f.lockBatches.length, 9);
  }
});

test('initial consent cannot activate; final exact consent activates immutable Meta4 and production reader', async () => {
  const f = await lockFixture(), frozen = await executeSlotLocks(initialApproval(f));
  const snapshot = await readLockedMigrationSnapshot({ store: f.store, plan: f.plan });
  const proof = await verifyBackupWithReader(await encodeBackup(await buildVerifiedBackup(snapshot)));
  assert.equal(proof.migrationStage, 'locked'); assert.equal(proof.slotLockId, f.plan.rootLock.lockId);
  const activation = await prepareSlotActivation({ plan: f.plan, shardLocks: frozen.shardLocks, finalFingerprint: proof.sourceFingerprint,
    finalBackupProof: proof });
  const args = { plan: f.plan, activation, adapter: f.adapter, approved: true, syncPaused: true,
    approvalFingerprint: proof.sourceFingerprint, backupProof: proof };
  await assert.rejects(executeSlotActivation({ ...args, approvalFingerprint: f.plan.sourceFingerprint }));
  await assert.rejects(executeSlotActivation({ ...args, approved: false }));
  assert.equal(f.lockBatches.length, 9);
  const result = await executeSlotActivation(args);
  assert.equal(result.state, 'complete'); assert.equal(f.lockBatches.length, 10);
  const reader = f.make(); await reader.assertAccess(); assert.deepEqual(await reader.listEvents(), []);
  assert.equal(reader.eventIndex.size, 1); assert.equal(reader.slotLockId, f.plan.rootLock.lockId);
  await executeSlotActivation(args); assert.equal(f.lockBatches.length, 10);
});

test('late duplicate or incomplete D parts remain byte-verifiable backup-only and cannot poison active index', async () => {
  const f = await lockFixture(), bytes = new Uint8Array([42]), key = await sha256(bytes);
  await f.record(f.shardIds[0], 'D', 0, bytes, { opId: 'blob_late_one', key, part: 0, parts: 2 });
  await f.record(f.shardIds[1], 'D', 0, bytes, { opId: 'blob_late_duplicate', key, part: 0, parts: 3 });
  const result = await executeSlotLocks(initialApproval(f));
  const snapshot = await readLockedMigrationSnapshot({ store: f.store, plan: f.plan });
  const bundle = await buildVerifiedBackup(snapshot), proof = await verifyBackupWithReader(await encodeBackup(bundle));
  assert.equal(proof.allBlobBytes, 2); assert.equal(proof.recordCount, 3); assert.equal(proof.blobGroups, 0);
  const activation = await prepareSlotActivation({ plan: f.plan, shardLocks: result.shardLocks,
    finalFingerprint: proof.sourceFingerprint, finalBackupProof: proof });
  await executeSlotActivation({ plan: f.plan, activation, adapter: f.adapter, approved: true,
    syncPaused: true, approvalFingerprint: proof.sourceFingerprint, backupProof: proof });
  const reader = f.make(); await reader.assertAccess(); assert.equal((await reader.blobSlots()).size, 0);
  await reader.putBlobs([{ hash: key, data: bytes }]);
  await reader.putEvents([{ id: 'new_active_0001', path: 'New.md', hash: key, parents: [] }]);
  const restarted = f.make(); await restarted.assertAccess();
  assert.equal((await restarted.listEvents()).length, 1); assert.deepEqual(await restarted.getBlob(key), bytes);
  assert.equal(restarted.slots(f.books.get(f.shardIds[0]).metadata, 'D').has(0), true, 'Quarantine still consumes physical capacity');
});

test('v2 negative probe requires exact consent and rejects a mutation-first batch without changing source', async () => {
  const f = await lockFixture();
  await assert.rejects(probeGoogleLockAtomicity({ store: f.store, plan: f.plan }));
  const proof = await probeGoogleLockAtomicity({ store: f.store, plan: f.plan, approved: true,
    approvalFingerprint: f.plan.sourceFingerprint });
  assert.equal(proof.verified, true); assert.equal(proof.remoteWritesApplied, 0);
  assert.equal(f.lockBatches.length, 0); assert.equal(f.books.get(f.rootId).lock, undefined);
});
