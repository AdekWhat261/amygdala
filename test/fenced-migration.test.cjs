'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, OldStore, rangeMarker, encode, copy } = require('../test-support/slot-fence-fixture.cjs');
const { prepareFencedMigration, executeFencedMigration, createGoogleFenceAdapter, probeGoogleFenceAtomicity } = require('../src/fenced-migration.cjs');
const { readOnlyMigrationSnapshot } = require('../src/legacy-migration-remote-preview.cjs');
const { FENCE_RANGE_NAME, namedSlots } = require('../src/slot-fence.cjs');
const { buildVerifiedBackup, createRestorePlan } = require('../src/verified-backup.cjs');

async function setup(options = {}) {
  const f = await fixture({ ...options, fenced: false }), store = f.make();
  const snapshot = await readOnlyMigrationSnapshot({ store, scopePath: 'Shared', verifyBlobs: true, includeBackupData: true });
  const plan = await prepareFencedMigration(snapshot);
  const adapter = createGoogleFenceAdapter({ store, plan });
  return { ...f, store, snapshot, plan, adapter };
}
function approved(f, changes = {}) {
  return { plan: f.plan, adapter: f.adapter, approved: true, syncPaused: true,
    approvalFingerprint: f.plan.sourceFingerprint,
    backupProof: { verified: true, bundleSha256: f.plan.backupBundleSha256,
      sourceFingerprint: f.plan.sourceFingerprint, projectRootId: f.plan.rootId },
    atomicFenceProof: { verified: true, projectRootId: f.plan.rootId, sourceFingerprint: f.plan.sourceFingerprint,
      operation: 'duplicate-named-range-atomic-rejection', proofDigest: 'a'.repeat(64) }, ...changes };
}
const originalContent = f => JSON.stringify([...f.books].map(([id, book]) => ({ id, manifest: book.manifest, rows: [...book.rows] })));

test('prepare requires a matching verified backup and performs no writes', async () => {
  const f = await setup();
  assert.equal(f.plan.receipts.length, 9);
  assert.deepEqual(f.plan.receipts.map(receipt => receipt.spreadsheetId), [...f.shardIds, f.rootId]);
  for (const change of [
    snapshot => { snapshot.stableSnapshot = false; },
    snapshot => { delete snapshot.backupSnapshot; },
    snapshot => { snapshot.backupSnapshot.fingerprint = 'b'.repeat(64); },
    snapshot => { snapshot.backupSnapshot.verifyBlobs = false; },
    snapshot => { snapshot.backupSnapshot.sheets[0].slots[0].rows[0][1] = 'Zm9v'; }
  ]) {
    const snapshot = copy(f.snapshot); change(snapshot);
    await assert.rejects(prepareFencedMigration(snapshot));
  }
  assert.equal(f.getWrites(), 0);
});

test('exact approval, backup proof, and atomicity proof rejects perform zero writes', async () => {
  const f = await setup();
  for (const changes of [
    { approved: false }, { syncPaused: false }, { approvalFingerprint: 'b'.repeat(64) },
    { backupProof: undefined }, { backupProof: { ...approved(f).backupProof, bundleSha256: 'b'.repeat(64) } },
    { backupProof: { ...approved(f).backupProof, projectRootId: 'other_12345678' } },
    { atomicFenceProof: undefined }, { atomicFenceProof: { ...approved(f).atomicFenceProof, verified: false } },
    { atomicFenceProof: { ...approved(f).atomicFenceProof, operation: 'mock-only' } }
  ]) await assert.rejects(executeFencedMigration(approved(f, changes)));
  assert.equal(f.getWrites(), 0);
  assert.equal(f.getAttempts(), 0);
});

test('atomicity proof from an older same-root source snapshot is rejected before writes', async () => {
  const f = await setup();
  const atomicFenceProof = { ...approved(f).atomicFenceProof, sourceFingerprint: 'b'.repeat(64) };
  await assert.rejects(executeFencedMigration(approved(f, { atomicFenceProof })));
  assert.equal(f.getWrites(), 0);
});

test('actual adapter fences shards before root and changes only new receipts and allocation markers', async () => {
  const f = await setup({ revisionCount: 378 }), before = originalContent(f);
  const result = await executeFencedMigration(approved(f));
  assert.equal(result.state, 'complete');
  assert.equal(result.writes, 9);
  assert.deepEqual(f.batches.map(batch => batch.id), [...f.shardIds, f.rootId]);
  assert.equal(originalContent(f), before);
  for (const batch of f.batches) {
    const updates = batch.requests.filter(request => request.updateCells).map(request => request.updateCells);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].range, { sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 });
    assert.ok(batch.requests.every(request => request.addNamedRange || request.updateCells));
  }
  assert.deepEqual(await f.store.listEvents(), []);
  assert.equal(f.store.eventIndex.size, 378);
  const again = await executeFencedMigration(approved(f));
  assert.equal(again.writes, 0);
  assert.equal(f.getWrites(), 9);
});

test('interruption after each sheet resumes the same plan without duplicate writes', async () => {
  for (let cutoff = 1; cutoff <= 9; cutoff++) {
    const f = await setup(), base = f.adapter;
    let completed = 0, crashed = false;
    const adapter = {
      async readState(receipt) { if (crashed) throw new Error('fixture process stopped'); return base.readState(receipt); },
      async claimFence(receipt) { await base.claimFence(receipt); if (++completed === cutoff) crashed = true; },
      verifyActivation: (...args) => base.verifyActivation(...args)
    };
    await assert.rejects(executeFencedMigration(approved(f, { adapter })), /fixture process stopped/);
    assert.equal(f.getWrites(), cutoff);
    const restarted = createGoogleFenceAdapter({ store: f.make(), plan: f.plan });
    const result = await executeFencedMigration(approved(f, { adapter: restarted }));
    assert.equal(result.writes, 9 - cutoff);
    assert.equal(f.getWrites(), 9);
  }
});

test('lost successful batch response is reconciled once without resending a mutation', async () => {
  const f = await setup(), originalBatch = f.store.batch;
  f.store.batch = async (...args) => { await originalBatch(...args); throw new Error('fixture response lost'); };
  const result = await executeFencedMigration(approved(f));
  assert.equal(result.state, 'complete');
  assert.equal(f.getAttempts(), 9);
  assert.equal(f.getWrites(), 9);
});

test('identical migrators share immutable claims; conflicting scopes cannot both activate', async () => {
  const f = await setup();
  const second = createGoogleFenceAdapter({ store: f.make(), plan: f.plan });
  const results = await Promise.all([executeFencedMigration(approved(f)), executeFencedMigration(approved(f, { adapter: second }))]);
  assert.ok(results.every(result => result.state === 'complete'));
  assert.equal(f.getWrites(), 9);

  const g = await setup(), otherSnapshot = copy(g.snapshot);
  otherSnapshot.localScope = 'DifferentShared';
  const otherPlan = await prepareFencedMigration(otherSnapshot);
  const other = { ...g, plan: otherPlan, adapter: createGoogleFenceAdapter({ store: g.make(), plan: otherPlan }) };
  const competing = await Promise.allSettled([executeFencedMigration(approved(g)), executeFencedMigration(approved(other))]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
  assert.equal(g.getWrites(), 9);
});

test('a competing old claim atomically rejects all reservations and leaves Meta3 untouched', async () => {
  const f = await setup(), originalBatch = f.store.batch;
  let injected = false;
  f.store.batch = async (id, requests) => {
    if (!injected) {
      injected = true;
      await f.record(id, 'D', 0, new Uint8Array([1, 2]), { opId: 'old_inflight', key: 'b'.repeat(64), part: 0, parts: 1 });
    }
    return originalBatch(id, requests);
  };
  await assert.rejects(executeFencedMigration(approved(f)));
  const first = f.books.get(f.shardIds[0]);
  assert.equal(first.receipt, null);
  assert.equal(first.metadata.namedRanges.some(item => item.name === FENCE_RANGE_NAME), false);
  assert.equal(namedSlots(first.metadata, 'D').size, 1);
  assert.equal(f.getWrites(), 0);
  assert.equal(f.getAttempts(), 1);
});

test('source marker drift is rejected before fencing that sheet', async () => {
  const f = await setup();
  await f.record(f.shardIds[0], 'D', 0, new Uint8Array([7]), { opId: 'old_inflight', key: 'b'.repeat(64), part: 0, parts: 1 });
  await assert.rejects(executeFencedMigration(approved(f)));
  assert.equal(f.getWrites(), 0);
});

test('approved source layout and named-range identity drift reject with zero writes', async () => {
  for (const change of [
    f => { f.books.get(f.rootId).metadata.sheets[1].properties.gridProperties.rowCount++; },
    f => { f.books.get(f.shardIds[7]).metadata.sheets[0].properties.gridProperties.columnCount++; },
    f => { f.books.get(f.rootId).metadata.namedRanges[0].namedRangeId = 'different_source_id'; },
    f => { f.books.get(f.rootId).metadata.namedRanges[0].range.startColumnIndex = 1; },
    f => { f.books.get(f.shardIds[7]).metadata.namedRanges.push({ name: 'UnrelatedRange', namedRangeId: 'unrelated_range',
      range: { sheetId: 1, startRowIndex: 10, endRowIndex: 11 } }); }
  ]) {
    const f = await setup(); change(f);
    await assert.rejects(executeFencedMigration(approved(f)));
    assert.equal(f.getWrites(), 0);
  }
});

test('approved TeamPlugins drift rejects before any sheet mutation', async () => {
  const f = await setup();
  f.books.get(f.rootId).teamPluginsRows.push(['change_fixture', '2026-10-06', '{"fixture":true}']);
  await assert.rejects(executeFencedMigration(approved(f)));
  assert.equal(f.getWrites(), 0);
});

test('preoccupied source Meta3 is retained and rejects migration with zero writes', async () => {
  const f = await setup();
  const occupied = [['unrelated', 'retain this value']];
  f.books.get(f.rootId).meta3Rows = copy(occupied);
  await assert.rejects(executeFencedMigration(approved(f)));
  assert.deepEqual(f.books.get(f.rootId).meta3Rows, occupied);
  assert.equal(f.getWrites(), 0);
});

test('pre-existing root manifest drift must reject before any shard mutation', async () => {
  const f = await setup();
  f.books.get(f.rootId).manifest.name = 'concurrent rename';
  await assert.rejects(executeFencedMigration(approved(f)));
  assert.equal(f.getWrites(), 0, 'all source sheets must be preflighted before the first fence');
});

test('prepare rejects outer events that differ from its verified backup', async () => {
  const f = await setup(), mismatched = copy(f.snapshot);
  mismatched.events[0].id = 'different_0001';
  await assert.rejects(prepareFencedMigration(mismatched), 'outer events must be tied to backup commit bytes');
  assert.equal(f.getWrites(), 0);
});

test('authentic old client cannot publish or read after actual runner activation', async () => {
  const f = await setup(), old = f.make(OldStore);
  await old.assertAccess();
  await executeFencedMigration(approved(f));
  await assert.rejects(old.claim(f.rootId, 'C', encode({ opId: 'commit_late', events: [{ id: 'late_0001', path: 'Private/Leak.md', hash: null, parents: [] }] }),
    { opId: 'commit_late', key: 'commit_late' }));
  const restartedOld = f.make(OldStore);
  await restartedOld.assertAccess();
  await assert.rejects(restartedOld.listEvents());
  assert.equal(f.getWrites(), 9);
});

test('backup restore retains the fence and permits a fresh epoch writer', async () => {
  const f = await setup();
  await executeFencedMigration(approved(f));
  const fresh = { id: 'fresh_0001', path: 'Board.md', hash: null, parents: [] };
  await f.store.putEvents([fresh]);
  const snapshot = await readOnlyMigrationSnapshot({ store: f.make(), scopePath: 'Shared', verifyBlobs: true, includeBackupData: true });
  const bundle = await buildVerifiedBackup(snapshot.backupSnapshot), restore = await createRestorePlan(bundle, { expectedRootId: f.rootId });
  const restored = await fixture({ fenced: false });
  for (const sheet of restore.sheets) {
    const book = restored.books.get(sheet.id);
    book.manifest = copy(sheet.manifest); book.metadata = copy(sheet.metadata);
    book.receipt = JSON.parse(sheet.metaCells[2][1]); book.rows = new Map();
    for (const item of sheet.slots) {
      const blocks = item.kind === 'C' ? 4 : 16;
      item.rows.forEach((row, index) => book.rows.set(1 + item.slot * blocks + index, copy(row)));
    }
  }
  const writer = restored.make();
  await writer.assertAccess();
  assert.deepEqual(await writer.listEvents(), [fresh]);
  await writer.putEvents([{ id: 'fresh_0002', path: 'Next.md', hash: null, parents: [] }]);
  const reread = restored.make();
  await reread.assertAccess();
  assert.equal((await reread.listEvents()).length, 2);
  assert.equal(reread.eventIndex.size, 3, 'hidden source revision remains retained');
});

test('atomicity probe denies missing or mismatched authorization without any calls', async () => {
  const f = await setup();
  let calls = 0;
  for (const method of ['call', 'batch', 'file', 'spreadsheet', 'manifestFor', 'values']) {
    f.store[method] = async () => { calls++; throw new Error('No unauthorized calls'); };
  }
  for (const authorization of [{}, { approved: true, approvalFingerprint: 'b'.repeat(64) }])
    await assert.rejects(probeGoogleFenceAtomicity({ store: f.store, plan: f.plan, ...authorization }));
  assert.equal(calls, 0);
});

test('atomicity probe puts sentinel before duplicate and returns proof only for unchanged 400 rejection', async () => {
  const f = await setup(), batch = f.store.batch, before = originalContent(f);
  f.store.batch = async (id, requests) => {
    assert.equal(id, f.rootId);
    assert.ok(requests[0].updateCells, 'a later duplicate must prevent an earlier sentinel update');
    assert.ok(requests[requests.length - 1].addNamedRange);
    return batch(id, requests);
  };
  const proof = await probeGoogleFenceAtomicity({ store: f.store, plan: f.plan, approved: true, approvalFingerprint: f.plan.sourceFingerprint });
  assert.equal(proof.verified, true);
  assert.equal(proof.projectRootId, f.rootId);
  assert.equal(proof.sourceFingerprint, f.plan.sourceFingerprint);
  assert.equal(proof.remoteWritesApplied, 0);
  assert.equal(proof.requestsAttempted, 1);
  assert.match(proof.proofDigest, /^[a-f0-9]{64}$/);
  assert.equal(f.books.get(f.rootId).receipt, null);
  assert.equal(originalContent(f), before);
  assert.equal(f.getAttempts(), 1);
  assert.equal(f.getWrites(), 0);
});

test('atomicity probe rejects 403, unrelated 400, and unknown lost response without retry or false proof', async () => {
  for (const status of [403, 400, undefined]) {
    const f = await setup();
    let calls = 0;
    f.store.batch = async () => { calls++; const error = new Error('fixture request failed'); error.status = status; throw error; };
    await assert.rejects(probeGoogleFenceAtomicity({ store: f.store, plan: f.plan, approved: true, approvalFingerprint: f.plan.sourceFingerprint }));
    assert.equal(calls, 1);
    assert.equal(f.books.get(f.rootId).receipt, null);
    assert.equal(f.books.get(f.rootId).meta3Rows, undefined);
  }
});

test('atomicity probe rejects successful or partial application and preserves violation evidence', async () => {
  for (const mode of ['success-without-write', 'partial-success', 'partial-400']) {
    const f = await setup();
    let calls = 0, sentinel;
    f.store.batch = async (id, requests) => {
      calls++;
      sentinel = requests.find(request => request.updateCells).updateCells.rows[0].values.map(cell => cell.userEnteredValue.stringValue);
      if (mode !== 'success-without-write') f.books.get(id).meta3Rows = [copy(sentinel)];
      if (mode === 'partial-400') { const error = new Error('fixture broken atomicity'); error.status = 400; throw error; }
      return {};
    };
    await assert.rejects(probeGoogleFenceAtomicity({ store: f.store, plan: f.plan, approved: true, approvalFingerprint: f.plan.sourceFingerprint }));
    assert.equal(calls, 1, 'unknown or violated outcome must not cause retry or cleanup');
    if (mode !== 'success-without-write') assert.deepEqual(f.books.get(f.rootId).meta3Rows, [sentinel]);
    assert.equal(f.books.get(f.rootId).receipt, null);
  }
});
