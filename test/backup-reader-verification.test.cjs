'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PARAMS, digest } = require('../src/team-sharded-store.cjs');
const { buildVerifiedBackup, encodeBackup, createRestorePlan, slotDigest } = require('../src/verified-backup.cjs');
const { verifyBackupWithReader } = require('../src/backup-reader-verification.cjs');
const { FENCE_PROTOCOL, FENCE_RANGE_NAME, LIMITS, allocationMarker,
  fenceDigest, sourceRecordsDigest, migrationEpoch } = require('../src/slot-fence.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function marker(kind, slot, namespace = 'AS4') {
  const name = allocationMarker(kind, slot, namespace), start = 1 + slot * LIMITS[kind].blocks;
  return { name, namedRangeId: name, range: { sheetId: 2, startRowIndex: start, endRowIndex: start + LIMITS[kind].blocks } };
}
async function record(kind, slot, bytes, extra) {
  const payload = Buffer.from(bytes), sha = hash(payload);
  const header = { hash: sha, payloadHash: sha, blocks: 1, size: payload.length, ...extra };
  const rows = [[JSON.stringify(header), payload.toString('base64')]];
  return { kind, slot, rows, sha256: await slotDigest(rows) };
}
async function fixture({ fenced = false, incompleteOrphan = false } = {}) {
  const rootId = 'root_fixture_1234', shardIds = Array.from({ length: 8 }, (_, i) => `shard_fixture_1234_${i}`), folderId = 'folder_fixture_1234';
  const root = { type: 'amygdala-team-sharded', version: 4, schema: 2, rootId, shardIds, folderId,
    vaultId: 'vault_fixture_1234', params: PARAMS, paramsDigest: await digest(PARAMS) };
  const manifests = [root, ...shardIds.map((shardId, index) => ({ type: root.type, version: 4, schema: 2,
    rootId, folderId, vaultId: root.vaultId, shardId, index, paramsDigest: root.paramsDigest }))];
  const sheets = [rootId, ...shardIds].map((id, index) => ({ id, manifest: manifests[index],
    metadata: { spreadsheetId: id, namedRanges: [], sheets: [
      { properties: { sheetId: 1, title: 'Meta', gridProperties: { rowCount: 3, columnCount: 2 } } },
      { properties: { sheetId: 2, title: 'Payload', gridProperties: {
        rowCount: 1 + (index === 0 ? PARAMS.commitSlots * PARAMS.commitBlocks : PARAMS.dataSlots * PARAMS.dataChunks), columnCount: 2 } } },
      ...(index === 0 ? [{ properties: { sheetId: 3, title: 'TeamPlugins', gridProperties: { rowCount: 5001, columnCount: 3 } } }] : [])] },
    fileMetadata: { id, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folderId], trashed: false, driveId: null },
    metaCells: [['key', 'value'], ['manifest', JSON.stringify(manifests[index])]], occupiedSlots: [], slots: [],
    ...(index === 0 ? { teamPluginsRows: [['deviceId', 'createdAt', 'change']] } : {}) }));
  async function add(index, item, namespace = 'AS4') {
    sheets[index].slots.push(item); sheets[index].occupiedSlots.push(item.slot);
    sheets[index].metadata.namedRanges.push(marker(item.kind, item.slot, namespace));
  }
  const sourceBytes = Buffer.from('original bytes'), sourceHash = hash(sourceBytes);
  const events = [
    { id: 'legacy_shared', path: 'Shared/note.md', hash: sourceHash, parents: [] },
    { id: 'legacy_private', path: 'Private/note.md', hash: sourceHash, parents: [] }
  ];
  const opId = 'commit_source_1234';
  await add(0, await record('C', 0, JSON.stringify({ opId, events }), { opId, key: opId }));
  await add(1, await record('D', 0, sourceBytes, { opId: `blob_${sourceHash}_0`, key: sourceHash, part: 0, parts: 1 }));
  if (incompleteOrphan) {
    const orphan = Buffer.from('unfinished orphan part');
    await add(2, await record('D', 0, orphan, { opId: 'blob_orphan_0', key: 'd'.repeat(64), part: 0, parts: 2 }));
  }
  if (fenced) {
    const targetRoot = { ...root, schema: 3, pathProtocol: 'project-relative-v1', namespace: rootId,
      legacyQuarantine: { protocol: 'preserve-hidden-v1', revisionIds: ['legacy_private'] },
      legacyPathMap: { protocol: 'prefix-rebase-v1', prefix: 'Shared', revisionIds: ['legacy_shared'] } };
    const targetShards = manifests.slice(1).map(item => ({ ...item, schema: 3, pathProtocol: 'project-relative-v1', namespace: rootId }));
    const plan = { sourceFingerprint: 'f'.repeat(64), scopePath: 'Shared', targetRoot, targetShards };
    const epoch = await migrationEpoch(plan);
    const receipts = await Promise.all(sheets.map(async (sheet, index) => ({ protocol: FENCE_PROTOCOL, epoch,
      kind: index === 0 ? 'root' : 'shard', rootId, spreadsheetId: sheet.id,
      sourceManifestDigest: await fenceDigest(sheet.manifest), sourceSlots: [...sheet.occupiedSlots],
      sourceRecordsDigest: await sourceRecordsDigest(sheet.occupiedSlots, sheet.slots.map(item => ({ header: JSON.parse(item.rows[0][0]) }))) })));
    Object.assign(receipts[0], plan, { shardReceiptDigests: await Promise.all(receipts.slice(1).map(async receipt => ({
      spreadsheetId: receipt.spreadsheetId, digest: await fenceDigest(receipt) }))) });
    for (let i = 0; i < sheets.length; i++) {
      const kind = i === 0 ? 'C' : 'D';
      sheets[i].metadata.namedRanges = Array.from({ length: LIMITS[kind].physical }, (_, slot) => marker(kind, slot));
      sheets[i].metadata.namedRanges.push({ name: FENCE_RANGE_NAME, namedRangeId: FENCE_RANGE_NAME,
        range: { sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 } });
      sheets[i].metaCells.push(['slotFence', JSON.stringify(receipts[i])]);
    }
    const newBytes = Buffer.from('new fenced bytes'), newHash = hash(newBytes), newOp = `commit_${epoch}_new`;
    await add(0, await record('C', 1, JSON.stringify({ opId: newOp, epoch,
      events: [{ id: 'new_revision', path: 'new.md', hash: newHash, parents: [] }] }), { opId: newOp, key: newOp, epoch }), 'AS5');
    await add(1, await record('D', 1, newBytes, { opId: `blob_${epoch}_${newHash}_0`, key: newHash, part: 0, parts: 1, epoch }), 'AS5');
  }
  return { stableSnapshot: true, remoteWrites: 0, verifyBlobs: true, project: { rootId, shardIds, folderId },
    fingerprint: 'f'.repeat(64), eventFingerprint: 'e'.repeat(64), capturedAt: '2026-10-06T00:00:00.000Z', sheets };
}

test('production reader proves legacy schema2 restore entirely in memory and returns aggregates only', async () => {
  const snapshot = await fixture(), bundle = await buildVerifiedBackup(snapshot);
  const proof = await verifyBackupWithReader(await encodeBackup(bundle));
  assert.equal(proof.verified, true); assert.equal(proof.fenced, false);
  assert.equal(proof.revisionCount, 2); assert.equal(proof.activeRevisionCount, 2);
  assert.equal(proof.allBlobBytes, Buffer.byteLength('original bytes'));
  assert.equal(proof.blobGroups, 1); assert.equal(proof.networkRequests, 0); assert.equal(proof.authenticationCalls, 0);
  assert.equal(proof.bundleSha256, bundle.bundleSha256);
  assert.ok(!JSON.stringify(proof).includes('Private/note.md'));
  assert.ok(!JSON.stringify(proof).includes('original bytes'));
});

test('fenced restore retains all reservations and receipt cells, maps legacy history, and reads AS5 commits/blobs', async () => {
  const snapshot = await fixture({ fenced: true }), bundle = await buildVerifiedBackup(snapshot);
  const restored = await createRestorePlan(bundle);
  assert.deepEqual(restored.sheets.map(sheet => sheet.metadata), snapshot.sheets.map(sheet => sheet.metadata));
  assert.deepEqual(restored.sheets.map(sheet => sheet.metaCells), snapshot.sheets.map(sheet => sheet.metaCells));
  const proof = await verifyBackupWithReader(await encodeBackup(bundle));
  assert.equal(proof.fenced, true); assert.match(proof.fenceEpoch, /^[a-f0-9]{64}$/);
  assert.equal(proof.revisionCount, 3); assert.equal(proof.activeRevisionCount, 2);
  assert.equal(proof.blobGroups, 2); assert.equal(proof.completeBlobGroups, 2);
  assert.equal(proof.allBlobBytes, Buffer.byteLength('original bytesnew fenced bytes'));
  assert.equal(proof.recordCount, 4); assert.equal(proof.remoteWrites, 0);
});

test('reader preserves and reports unreferenced incomplete parts without calling them complete blobs', async () => {
  const bundle = await buildVerifiedBackup(await fixture({ incompleteOrphan: true }));
  const proof = await verifyBackupWithReader(await encodeBackup(bundle));
  assert.equal(proof.blobGroups, 2); assert.equal(proof.completeBlobGroups, 1); assert.equal(proof.incompleteBlobGroups, 1);
  assert.equal(proof.allBlobBytes, Buffer.byteLength('original bytesunfinished orphan part'));
});

test('fenced backup rejects missing receipts, reservations, and new slots even with updated inventory', async () => {
  const base = await fixture({ fenced: true });
  const noMeta = structuredClone(base); noMeta.sheets[1].metaCells.pop();
  await assert.rejects(buildVerifiedBackup(noMeta), /metadata is incomplete/);
  const noReservation = structuredClone(base); noReservation.sheets[1].metadata.namedRanges.shift();
  await assert.rejects(buildVerifiedBackup(noReservation));
  const noSingleton = structuredClone(base); noSingleton.sheets[2].metadata.namedRanges.pop();
  await assert.rejects(buildVerifiedBackup(noSingleton));
  const noFresh = structuredClone(base); noFresh.sheets[1].slots.pop(); noFresh.sheets[1].occupiedSlots.pop();
  await assert.rejects(buildVerifiedBackup(noFresh), /fence occupied-slot/);
  const missingReceipt = structuredClone(base); missingReceipt.sheets[3].metaCells[2][0] = 'wrong';
  await assert.rejects(buildVerifiedBackup(missingReceipt));
});

test('fenced backup rejects changed source aggregates and wrong AS5 epochs', async () => {
  const source = await fixture({ fenced: true });
  const item = source.sheets[1].slots[0], header = JSON.parse(item.rows[0][0]);
  item.rows[0][0] = JSON.stringify({ ...header, opId: 'changed_source_op' }); item.sha256 = await slotDigest(item.rows);
  await assert.rejects(buildVerifiedBackup(source), /source records/);
  const fresh = await fixture({ fenced: true }), slot = fresh.sheets[1].slots[1];
  slot.rows[0][0] = JSON.stringify({ ...JSON.parse(slot.rows[0][0]), epoch: 'a'.repeat(64) }); slot.sha256 = await slotDigest(slot.rows);
  await assert.rejects(buildVerifiedBackup(fresh), /invalid fence epoch/);
});

test('reader rejects corrupt archives, raw payload mismatches, and validly hashed invalid history', async () => {
  const snapshot = await fixture(), bundle = await buildVerifiedBackup(snapshot), bytes = await encodeBackup(bundle);
  bytes[20] ^= 1;
  await assert.rejects(verifyBackupWithReader(bytes));
  snapshot.sheets[1].slots[0].rows[0][1] = Buffer.from('corrupt').toString('base64');
  snapshot.sheets[1].slots[0].sha256 = await slotDigest(snapshot.sheets[1].slots[0].rows);
  await assert.rejects(buildVerifiedBackup(snapshot), /payload hash/);
  const invalid = await fixture();
  invalid.sheets[0].slots[0] = await record('C', 0, 'not a commit', { opId: 'invalid_commit', key: 'invalid_commit' });
  await assert.rejects(verifyBackupWithReader(await encodeBackup(await buildVerifiedBackup(invalid))));
});

test('reader rejects inconsistent legacy manifest identity and missing referenced content', async () => {
  const wrong = await fixture();
  wrong.sheets[1].manifest.shardId = 'wrong_shard_1234';
  wrong.sheets[1].metaCells[1][1] = JSON.stringify(wrong.sheets[1].manifest);
  await assert.rejects(verifyBackupWithReader(await encodeBackup(await buildVerifiedBackup(wrong))), /source manifests/);
  const missing = await fixture();
  missing.sheets[1].slots = []; missing.sheets[1].occupiedSlots = []; missing.sheets[1].metadata.namedRanges = [];
  await assert.rejects(verifyBackupWithReader(await encodeBackup(await buildVerifiedBackup(missing))));
});
