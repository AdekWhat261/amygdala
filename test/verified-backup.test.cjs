'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildVerifiedBackup, encodeBackup, decodeBackup, createRestorePlan, slotDigest } = require('../src/verified-backup.cjs');
const { assessMigrationCoordination } = require('../src/migration-coordination.cjs');
const { TeamShardedStore, PARAMS } = require('../src/team-sharded-store.cjs');
const { prepareShadowMigration, planShadowResume, verifyShadowCopy } = require('../src/shadow-migration-plan.cjs');
const { restoreFixture } = require('../test-support/restore-fixture.cjs');

async function snapshot() {
  const rootId = 'root_fixture', shardIds = Array.from({ length: 8 }, (_, i) => `shard_${i}`), folderId = 'disposable_project';
  const sheets = await Promise.all([rootId, ...shardIds].map(async (id, i) => {
    const manifest = { type: 'amygdala-team-sharded', rootId, folderId, shardIds, index: i - 1 };
    const payload = Buffer.from('payload');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const rows = [[JSON.stringify({ opId: `op_${i}`, key: hash, hash, payloadHash: hash, blocks: 1, size: payload.length }), payload.toString('base64')]];
    const kind = i === 0 ? 'C' : 'D';
    return { id, manifest, metadata: { spreadsheetId: id, namedRanges: [{ name: `${kind}_0` }] },
      fileMetadata: { id, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folderId], trashed: false, driveId: null },
      metaCells: [['key', 'value'], ['manifest', JSON.stringify(manifest)]],
      occupiedSlots: [0], slots: [{ kind, slot: 0, rows, sha256: await slotDigest(rows) }],
      ...(i === 0 ? { teamPluginsRows: [['deviceId', 'createdAt', 'change']] } : {}) };
  }));
  return { stableSnapshot: true, verifyBlobs: true, remoteWrites: 0, project: { rootId, shardIds, folderId },
    fingerprint: 'f'.repeat(64), eventFingerprint: 'e'.repeat(64), sheets };
}

test('verified backup round-trips and makes a no-network restore plan preserving all shards and slots', async () => {
  const original = await snapshot();
  const backup = await buildVerifiedBackup(original);
  const decoded = await decodeBackup(await encodeBackup(backup));
  const plan = await createRestorePlan(decoded, { expectedRootId: 'root_fixture' });
  assert.equal(plan.remoteWrites, 0);
  assert.equal(plan.sheets.length, 9);
  assert.deepEqual(plan.sheets.map(sheet => sheet.id), ['root_fixture', ...Array.from({ length: 8 }, (_, i) => `shard_${i}`)]);
  assert.equal(plan.sheets.reduce((count, sheet) => count + sheet.slots.length, 0), 9);
  assert.deepEqual(plan.sheets[0].teamPluginsRows, [['deviceId', 'createdAt', 'change']]);
  assert.deepEqual(plan.sheets[4].slots[0].rows, original.sheets[4].slots[0].rows);
});

test('backup creation refuses unstable snapshots, missing shards, incomplete occupied slots, and corrupt slot rows', async () => {
  const base = await snapshot();
  await assert.rejects(buildVerifiedBackup({ ...base, stableSnapshot: false }), /stable/);
  await assert.rejects(buildVerifiedBackup({ ...base, sheets: base.sheets.slice(0, 8) }), /nine-sheet/);
  const missing = await snapshot(); missing.sheets[1].slots = [];
  await assert.rejects(buildVerifiedBackup(missing), /occupied-slot inventory/);
  const corrupt = await snapshot(); corrupt.sheets[2].slots[0].rows[0][1] = 'different';
  await assert.rejects(buildVerifiedBackup(corrupt), /checksum/);
  const forgedPayload = await snapshot(); forgedPayload.sheets[3].slots[0].rows[0][1] = Buffer.from('forged').toString('base64');
  forgedPayload.sheets[3].slots[0].sha256 = await slotDigest(forgedPayload.sheets[3].slots[0].rows);
  await assert.rejects(buildVerifiedBackup(forgedPayload), /payload hash/);
  const duplicate = await snapshot(); duplicate.sheets[2].slots.push(structuredClone(duplicate.sheets[2].slots[0]));
  await assert.rejects(buildVerifiedBackup(duplicate), /duplicate payload slot/);
  const wrongMeta = await snapshot(); wrongMeta.sheets[2].metaCells[1][1] = JSON.stringify({ ...wrongMeta.sheets[2].manifest, folderId: 'other' });
  await assert.rejects(buildVerifiedBackup(wrongMeta), /Meta cells/);
});

test('backup decode rejects altered archive and restore plan rejects another project', async () => {
  const backup = await buildVerifiedBackup(await snapshot());
  const tampered = structuredClone(backup); tampered.sheets[1].slots[0].rows[0][1] = 'tampered';
  const damaged = await encodeBackup(backup); damaged[12] ^= 0xff;
  await assert.rejects(decodeBackup(damaged), /corrupt|checksum|malformed/);
  await assert.rejects(createRestorePlan(tampered), /checksum/);
  await assert.rejects(createRestorePlan(backup, { expectedRootId: 'other_project' }), /different project/);
});

test('restore recreates all captured sheets and raw rows in a fresh temporary fixture outside the vault boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amygdala-backup-fixture-'));
  try {
    const vaultRoot = path.join(root, 'disposable-vault');
    await fs.mkdir(vaultRoot);
    const original = await snapshot();
    const bundle = await buildVerifiedBackup(original);
    const plan = await createRestorePlan(bundle);
    const destination = path.join(root, 'restored-fixture');
    await restoreFixture(plan, destination, { vaultRoot });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'project.json'), 'utf8')), bundle.project);
    for (let i = 0; i < plan.sheets.length; i++) {
      const sheet = plan.sheets[i], sheetDir = path.join(destination, 'sheets', sheet.id);
      const metadata = JSON.parse(await fs.readFile(path.join(sheetDir, 'metadata.json'), 'utf8'));
      assert.deepEqual(metadata.manifest, original.sheets[i].manifest);
      for (const slot of sheet.slots) {
        const restored = JSON.parse(await fs.readFile(path.join(sheetDir, `${slot.kind}-${slot.slot}.json`), 'utf8'));
        assert.deepEqual(restored.rows, original.sheets[i].slots[0].rows);
        assert.equal(restored.sha256, slot.sha256);
      }
    }
    await assert.rejects(restoreFixture(plan, path.join(vaultRoot, 'must-not-exist'), { vaultRoot }), /inside a vault/);
    await assert.rejects(restoreFixture(plan, destination, { vaultRoot }), /must not already exist/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('migration coordination remains blocked for unknown roster, old client, pending write, absent backup, or stale fingerprint', () => {
  const good = { writerSerialization: 'provider-atomic', rosterKnown: true, allClientsPaused: true,
    legacyClients: false, pendingOperationsKnown: true, pendingOperations: 0, backupVerified: true,
    snapshotFingerprint: 'a'.repeat(64), approvedFingerprint: 'a'.repeat(64) };
  const ready = assessMigrationCoordination(good);
  assert.equal(ready.readyForReview, true);
  assert.equal(ready.canWrite, false);
  for (const patch of [
    { rosterKnown: false }, { legacyClients: true }, { pendingOperations: 1 }, { backupVerified: false },
    { approvedFingerprint: 'b'.repeat(64) }, { writerSerialization: 'best-effort-lock' }
  ]) assert.equal(assessMigrationCoordination({ ...good, ...patch }).readyForReview, false);
  assert.equal(assessMigrationCoordination({}).canWrite, false);
});

test('two isolated clients racing for the same append-only commit slot preserve both writes in distinct slots', async () => {
  const rootId = 'root_race_123456', namedRanges = [], payloads = new Map();
  const makeClient = () => {
    const client = new TeamShardedStore({ request: async () => { throw new Error('unexpected network'); },
      getAccessToken: async () => 'unused', rootId });
    client.manifest = { shardIds: Array(8).fill('shard_unused') };
    client.rootMetadata = { spreadsheetId: rootId, namedRanges: [] };
    client.slots = (metadata, kind) => new Set((metadata.namedRanges || []).map(item => Number(item.name.split('_').at(-1))).filter(Number.isInteger));
    client.updateSheetMetadata = (_id, fresh) => { client.rootMetadata = fresh; };
    client.spreadsheet = async () => ({ spreadsheetId: rootId, namedRanges: namedRanges.map(item => ({ ...item })) });
    client.verifiedSlot = async (_id, _kind, slot) => payloads.get(slot);
    client.batch = async (_id, requests) => {
      const marker = requests[0].addNamedRange.namedRange.name;
      if (namedRanges.some(item => item.name === marker)) { const error = new Error('duplicate marker'); error.status = 400; throw error; }
      const slot = Number(marker.split('_').at(-1));
      const encoded = requests[1].updateCells.rows[0].values[1].userEnteredValue.stringValue;
      const header = JSON.parse(requests[1].updateCells.rows[0].values[0].userEnteredValue.stringValue);
      const payload = new Uint8Array(Buffer.from(encoded, 'base64'));
      namedRanges.push({ namedRangeId: `id_${slot}`, name: marker, range: { sheetId: 2 } });
      payloads.set(slot, { header, payload });
    };
    return client;
  };
  const clients = [makeClient(), makeClient()];
  const outputs = await Promise.all(clients.map((client, index) => client.claim(rootId, 'C',
    new TextEncoder().encode(`device-${index}`), { opId: `operation_${index}`, key: `event_${index}` })));
  assert.deepEqual([...outputs].sort((a, b) => a - b), [0, 1]);
  assert.equal(namedRanges.length, 2);
  assert.equal(PARAMS.maxCommitClaims >= 2, true);
  const storedBodies = [...payloads.values()].map(record => new TextDecoder().decode(record.payload)).sort();
  assert.deepEqual(storedBodies, ['device-0', 'device-1']);
});

test('copy-on-write migration resumes an interrupted shadow copy idempotently without touching source or auto-cutting over', () => {
  const payloads = ['new note', 'canvas and asset'];
  const records = payloads.map((body, index) => ({ id: `record_${index}`, sha256: crypto.createHash('sha256').update(body).digest('hex') }));
  const source = Object.freeze({ id: 'legacy_root', revisions: 378 });
  const plan = prepareShadowMigration({ sourceId: 'legacy_root', destinationId: 'new_empty_root',
    sourceFingerprint: 'c'.repeat(64), records, destinationEmpty: true });
  const interrupted = { projectId: 'new_empty_root', sourceFingerprint: plan.sourceFingerprint, records: [records[0]] };
  const resume = planShadowResume(plan, interrupted);
  assert.deepEqual(resume.pending, [records[1]]);
  assert.equal(resume.sourceMutationCount, 0);
  assert.equal(resume.remoteWrites, 0);
  const complete = { ...interrupted, records: [...interrupted.records, records[1]] };
  const result = verifyShadowCopy(plan, complete, plan.sourceFingerprint);
  assert.equal(result.verified, true);
  assert.equal(result.canCutOverAutomatically, false);
  assert.deepEqual(source, { id: 'legacy_root', revisions: 378 });
});

test('shadow copy refuses concurrent source change, duplicate/extra destination records, and a non-empty initial target', () => {
  const records = [{ id: 'one', sha256: '1'.repeat(64) }, { id: 'two', sha256: '2'.repeat(64) }];
  const plan = prepareShadowMigration({ sourceId: 'legacy', destinationId: 'shadow',
    sourceFingerprint: 'd'.repeat(64), records, destinationEmpty: true });
  assert.throws(() => prepareShadowMigration({ sourceId: 'legacy', destinationId: 'shadow',
    sourceFingerprint: 'd'.repeat(64), records, destinationEmpty: false }), /empty destination/);
  const complete = { projectId: 'shadow', sourceFingerprint: plan.sourceFingerprint, records };
  assert.throws(() => verifyShadowCopy(plan, complete, 'e'.repeat(64)), /Source changed/);
  assert.throws(() => planShadowResume(plan, { ...complete, records: [...records, { id: 'extra', sha256: '3'.repeat(64) }] }), /unexpected/);
  assert.throws(() => planShadowResume(plan, { ...complete, records: [records[0], records[0]] }), /duplicate/);
});
