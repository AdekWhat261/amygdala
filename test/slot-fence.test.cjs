'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamShardedStore, PARAMS, digest } = require('../src/team-sharded-store.cjs');
const { previewSchema2Migration } = require('../src/legacy-migration-preview.cjs');
const { FENCE_PROTOCOL, FENCE_RANGE_NAME, FENCE_ROW_KEY, LIMITS, allocationMarker, fenceDigest,
  sourceRecordsDigest, migrationEpoch, parseFenceReceipt, namedSlots } = require('../src/slot-fence.cjs');
const { TeamShardedStore: OldStore } = require('../test-support/authentic-old-client.cjs');
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const copy = value => structuredClone(value);

const { fixture, rangeMarker } = require('../test-support/slot-fence-fixture.cjs');

test('complete fence exposes effective schema3 without writes and preserves raw source', async () => {
  const f = await fixture(), store = f.make(), before = JSON.stringify([...f.books.values()].map(book => book.manifest));
  const info = await store.teamInfo();
  assert.equal(info.pathProtocol, 'project-relative-v1');
  assert.equal(info.namespace, f.rootId);
  assert.equal(store.manifest.schema, 3);
  assert.deepEqual(await store.listEvents(), []);
  assert.equal(store.eventIndex.size, 1);
  assert.equal(f.getWrites(), 0);
  assert.equal(JSON.stringify([...f.books.values()].map(book => book.manifest)), before);
});

test('pilot-shaped 378-revision history stays hidden and byte-identical', async () => {
  const f = await fixture({ revisionCount: 378 }), store = f.make();
  const before = JSON.stringify([...f.books.get(f.rootId).rows]);
  await store.assertAccess();
  assert.deepEqual(await store.listEvents(), []);
  assert.equal(store.eventIndex.size, 378);
  assert.equal(store.manifest.legacyQuarantine.revisionIds.length, 378);
  assert.equal(JSON.stringify([...f.books.get(f.rootId).rows]), before);
  assert.equal(f.getWrites(), 0);
});

test('new writes use AS5 and epoch; empty blobs survive an omitted trailing cell', async () => {
  const f = await fixture(), store = f.make();
  await store.assertAccess();
  const bytes = new Uint8Array(), hash = await require('../src/drive.cjs').sha256(bytes);
  await store.putBlobs([{ hash, data: bytes }]);
  const fresh = { id: 'new_0001', path: 'Shared.md', hash, parents: [] };
  await store.putEvents([fresh]);
  const root = f.books.get(f.rootId), shard = f.books.get(f.shardIds[0]);
  assert.equal(namedSlots(root.metadata, 'C', 'AS5').size, 1);
  assert.equal(namedSlots(shard.metadata, 'D', 'AS5').size, 1);
  assert.equal(namedSlots(root.metadata, 'C').size, PARAMS.commitSlots);
  assert.equal(JSON.parse(Buffer.from(root.rows.get(5)[1], 'base64').toString()).epoch, f.epoch);
  shard.rows.get(1).pop();
  const restarted = f.make();
  await restarted.assertAccess();
  assert.deepEqual(await restarted.listEvents(), [fresh]);
  assert.equal((await restarted.getBlob(hash)).length, 0);
  assert.equal(f.books.get(f.rootId).rows.get(1)[0], JSON.stringify(f.original.header));
});

test('authentic old stale writer loses a collision and cannot advance past the fence', async () => {
  const f = await fixture(), current = f.make();
  await current.assertAccess();
  await current.putEvents([{ id: 'new_0001', path: 'Shared.md', hash: null, parents: [] }]);
  const old = f.make(OldStore);
  old.manifest = copy(f.root); old.shards = f.shardIds.map(id => ({ ...copy(f.books.get(id).metadata), namedRanges: [] }));
  old.rootMetadata = { ...copy(f.books.get(f.rootId).metadata), namedRanges: [rangeMarker('C', 0)] };
  const beforeWrites = f.getWrites(), beforeAttempts = f.getAttempts();
  const payload = encode({ opId: 'commit_late', events: [{ id: 'late_0001', path: 'Private/Late.md', hash: null, parents: [] }] });
  await assert.rejects(old.claim(f.rootId, 'C', payload, { opId: 'commit_late', key: 'commit_late' }));
  assert.equal(f.getWrites(), beforeWrites);
  assert.ok(f.getAttempts() >= beforeAttempts + 2, 'collision with AS5 payload then collision with empty reservation');
  await assert.rejects(old.claim(f.shardIds[0], 'D', new Uint8Array([1]), { opId: 'blob_late', key: 'f'.repeat(64), part: 0, parts: 1 }));
  assert.equal(f.getWrites(), beforeWrites);
});

test('authentic old fresh reader stops at reserved legacy names', async () => {
  const f = await fixture(), old = f.make(OldStore);
  await old.assertAccess();
  await assert.rejects(old.listEvents());
  assert.equal(f.getWrites(), 0);
});

test('late legacy payload and untagged AS5 commit fail closed', async () => {
  const f = await fixture();
  await f.record(f.rootId, 'C', 2, { opId: 'late_commit', events: [{ id: 'late_0001', path: 'Private/Late.md', hash: null, parents: [] }] },
    { opId: 'late_commit', key: 'late_commit' });
  await assert.rejects(f.make().assertAccess(), /старого клиента/);
  const g = await fixture();
  await g.record(g.rootId, 'C', 2, { opId: 'late_commit', events: [{ id: 'late_0001', path: 'Private/Late.md', hash: null, parents: [] }] },
    { opId: 'late_commit', key: 'late_commit' }, 'AS5');
  await assert.rejects(g.make().assertAccess(), /эпох/);
  assert.equal(f.getWrites() + g.getWrites(), 0);
});

test('partial fences, altered Meta, inconsistent receipts, and invalid overlay are rejected', async () => {
  for (const corrupt of [
    f => { f.books.get(f.shardIds[0]).metadata.namedRanges.pop(); },
    f => { f.books.get(f.rootId).manifest.name = 'changed'; },
    f => { f.books.get(f.shardIds[1]).receipt.epoch = 'b'.repeat(64); },
    f => { f.books.get(f.rootId).receipt.targetRoot.schema = 2; },
    f => { f.books.get(f.rootId).metadata.namedRanges.find(item => item.name === FENCE_RANGE_NAME).range.startColumnIndex = 1; },
    f => { f.books.get(f.shardIds[0]).metadata.namedRanges.splice(10, 1); },
    f => { f.books.get(f.rootId).metadata.namedRanges.push(rangeMarker('C', 0, 'AS5')); }
  ]) {
    const f = await fixture(); corrupt(f);
    await assert.rejects(f.make().assertAccess());
    assert.equal(f.getWrites(), 0);
  }
});

test('source bytes and source event partition are pinned on every new pass', async () => {
  const f = await fixture(), store = f.make();
  await store.assertAccess();
  await f.record(f.rootId, 'C', 0, { opId: 'commit_original', events: [{ ...f.legacy, path: 'Other.md' }] },
    { opId: 'commit_original', key: 'commit_original' });
  await assert.rejects(store.beginPass(), /Исходная история/);
  const g = await fixture();
  const receipt = g.books.get(g.rootId).receipt;
  receipt.targetRoot.legacyQuarantine.revisionIds = [];
  const epoch = await migrationEpoch(receipt);
  for (const book of g.books.values()) book.receipt.epoch = epoch;
  receipt.shardReceiptDigests = await Promise.all(g.shardIds.map(async id => ({ spreadsheetId: id, digest: await fenceDigest(g.books.get(id).receipt) })));
  await assert.rejects(g.make().assertAccess(), /всю исходную историю/);
});

test('pending legacy operations are never silently promoted to the new epoch', async () => {
  const f = await fixture();
  const store = f.make(TeamShardedStore, { operationJournal: { pendingAll: () => [{ spreadsheetId: f.rootId,
    kind: 'C', slot: 1, opId: 'commit_old', accountId: 'account_123' }] } });
  store.accountId = async () => 'account_123';
  await assert.rejects(store.assertAccess(), /старой эпохе/);
  assert.equal(f.getWrites(), 0);
});

test('native schema3 without migration fences keeps AS4 allocation', async () => {
  const f = await fixture(), target = f.receipts[0];
  for (const [id, book] of f.books) {
    book.receipt = null;
    book.manifest = copy(id === f.rootId ? target.targetRoot : target.targetShards[f.shardIds.indexOf(id)]);
    book.metadata.namedRanges = id === f.rootId ? [rangeMarker('C', 0)] : [];
  }
  const store = f.make();
  await store.assertAccess();
  await store.putEvents([{ id: 'fresh_0001', path: 'Project.md', hash: null, parents: [] }]);
  assert.equal(namedSlots(f.books.get(f.rootId).metadata, 'C').size, 2);
  assert.equal(namedSlots(f.books.get(f.rootId).metadata, 'C', 'AS5').size, 0);
});

test('receipt parser rejects unknown fields and malformed or oversized records', async () => {
  const f = await fixture();
  assert.deepEqual(parseFenceReceipt([[FENCE_ROW_KEY, JSON.stringify(f.receipts[0])]]), f.receipts[0]);
  for (const rows of [[], [['wrong', '{}']], [[FENCE_ROW_KEY, '{']],
    [[FENCE_ROW_KEY, JSON.stringify({ ...f.receipts[1], unknown: true })]],
    [[FENCE_ROW_KEY, JSON.stringify({ ...f.receipts[1], sourceSlots: [2, 1] })]],
    [[FENCE_ROW_KEY, JSON.stringify({ ...f.receipts[0], scopePath: 'x'.repeat(48001) })]]])
    assert.throws(() => parseFenceReceipt(rows));
});
