'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PARAMS, digest } = require('../src/team-sharded-store.cjs');
const { readOnlySchema2MigrationPreview, readOnlyMigrationSnapshot } = require('../src/legacy-migration-remote-preview.cjs');
const { buildVerifiedBackup } = require('../src/verified-backup.cjs');

async function fixture({ changeSecondRead = false, changeDataSecondRead = false, changePluginsSecondRead = false,
  migratedPreview = false } = {}) {
  const rootId = 'root_12345678';
  const shardIds = Array.from({ length: 8 }, (_, i) => `shard_${String(i).padStart(2, '0')}_123`);
  const root = { schema: 2, type: 'amygdala-team-sharded', version: 4, rootId, name: 'fixture', vaultId: 'vault_12345678',
    folderId: 'folder_12345678', shardIds, params: PARAMS, paramsDigest: await digest(PARAMS) };
  const shards = shardIds.map((shardId, index) => ({ schema: migratedPreview ? 3 : 2, type: 'amygdala-team-sharded', version: 4,
    vaultId: root.vaultId, rootId, folderId: root.folderId, shardId, index, paramsDigest: root.paramsDigest }));
  const included = { id: 'legacy_0001', path: 'Amygdala Beta1 QA/Shared/Board.canvas', hash: null, parents: [] };
  const outside = { id: 'legacy_0002', path: 'Board.canvas', hash: null, parents: [] };
  const fresh = { id: 'new_0001', path: 'Board.canvas', hash: null, parents: [included.id] };
  const eventList = migratedPreview ? [included, outside, fresh] : [{ id: 'legacy_0001', path: 'Old/Note.md', hash: null, parents: [] }];
  if (migratedPreview) {
    Object.assign(root, { schema: 3, pathProtocol: 'project-relative-v1', namespace: rootId,
      legacyQuarantine: { protocol: 'preserve-hidden-v1', revisionIds: [outside.id] },
      legacyPathMap: { protocol: 'prefix-rebase-v1', prefix: 'Amygdala Beta1 QA/Shared', revisionIds: [included.id] } });
    for (const shard of shards) Object.assign(shard, { pathProtocol: 'project-relative-v1', namespace: rootId });
  }
  const ids = [rootId, ...shardIds];
  const manifests = new Map([[rootId, root], ...shards.map(shard => [shard.shardId, shard])]);
  const files = ids.map(id => ({ id, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false,
    driveId: null, capabilities: { canEdit: true }, parents: [root.folderId] }));
  const sheetMeta = ids.map((id, i) => ({ spreadsheetId: id, namedRanges: i === 0 ? [{ name: 'AS4_C_000', range: { sheetId: 2, startRowIndex: 1, endRowIndex: 5 } }] : [],
    sheets: [{ properties: { sheetId: 1, title: 'Meta', gridProperties: { rowCount: 2 } } },
      { properties: { sheetId: 2, title: 'Payload', gridProperties: { rowCount: 1 + (i === 0 ? PARAMS.commitSlots * PARAMS.commitBlocks : PARAMS.dataSlots * PARAMS.dataChunks), columnCount: 2 } } },
      ...(i === 0 ? [{ properties: { sheetId: 3, title: 'TeamPlugins' } }] : [])] }));
  let reads = 0, dataReads = 0, pluginReads = 0, writes = 0;
  const store = {
    rootId, manifest: null, shards: null, rootMetadata: null, blobIndex: null, blobIndexPromise: null,
    async manifestFor(id) { return manifests.get(id); },
    async file(id) { return files[ids.indexOf(id)]; },
    async spreadsheet(id) { return sheetMeta[ids.indexOf(id)]; },
    slots(metadata, kind) { return kind === 'C' ? new Set(metadata.namedRanges.map(() => 0)) : new Set([0]); },
    async verifiedSlots(id, kind, slots, _progress, { preserveRaw = false } = {}) {
      assert.deepEqual(slots, [0]);
      if (kind === 'C') {
        reads++;
        const opId = reads > 1 && changeSecondRead ? 'commit_87654321' : 'commit_12345678';
        const payload = new TextEncoder().encode(JSON.stringify({ opId, events: eventList }));
        const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
        const header = { opId, key: opId, hash: payloadHash, payloadHash, blocks: 1, size: payload.length };
        return [{ header, payload, ...(preserveRaw ? { rawRows: [[JSON.stringify(header), Buffer.from(payload).toString('base64')]] } : {}) }];
      }
      dataReads++;
      const payload = new Uint8Array([1]);
      const hash = dataReads > 1 && changeDataSecondRead ? 'b'.repeat(64) : crypto.createHash('sha256').update(payload).digest('hex');
      const header = { opId: 'blob_12345678', key: hash, hash, payloadHash: hash, size: 1, blocks: 1, part: 0, parts: 1 };
      return [{ header, payload, ...(preserveRaw ? { rawRows: [[JSON.stringify(header), Buffer.from(payload).toString('base64')]] } : {}) }];
    },
    async blobSlots() { return new Map(); },
    async values(id, range) {
      if (range === 'Meta!A1:B2') return { values: [['key', 'value'], ['manifest', JSON.stringify(manifests.get(id))]] };
      pluginReads++;
      const change = pluginReads > 1 && changePluginsSecondRead ? 'updated' : 'initial';
      return { values: [['changeId', 'createdAt', 'change'], ['plugin_12345', '2026-10-01T00:00:00Z', change]] };
    },
    async validateSnapshot(events) { assert.deepEqual(events, eventList); },
    finishPass() {},
    async call(_url, options = {}) { if (options.method && options.method !== 'GET') writes++; throw new Error('Unexpected raw call'); }
  };
  return { store, getReads: () => reads, getWrites: () => writes };
}

test('authenticated schema2 preview double-reads all manifests/history and performs zero writes', async () => {
  const f = await fixture();
  const report = await readOnlySchema2MigrationPreview({ store: f.store, scopePath: 'Amygdala Beta1 QA/Shared' });
  assert.equal(report.stableSnapshot, true);
  assert.equal(report.revisionCount, 1);
  assert.equal(report.currentPathCount, 1);
  assert.equal(report.pathCounts['outside-selected-folder'], 1);
  assert.equal(report.quarantinedRevisionCount, 1);
  assert.equal(report.projectRootId, 'root_12345678');
  assert.deepEqual(report.shardIds, Array.from({ length: 8 }, (_, i) => `shard_${String(i).padStart(2, '0')}_123`));
  assert.equal(report.remoteWrites, 0);
  assert.equal(f.getReads(), 2);
  assert.equal(f.getWrites(), 0);
});

test('completed preview reports mapped legacy data, quarantined data, and new project events separately', async () => {
  const f = await fixture({ migratedPreview: true });
  const report = await readOnlySchema2MigrationPreview({ store: f.store, scopePath: 'Alice/TeamA' });
  assert.equal(report.migrationState, 'complete');
  assert.equal(report.activeLegacyRevisionCount, 1);
  assert.equal(report.quarantinedRevisionCount, 1);
  assert.equal(report.activeProjectEventCount, 1);
  assert.equal(report.includedCurrentPathCount, 1);
  assert.equal(report.quarantinedCurrentPathCount, 1);
  assert.equal(report.remoteWrites, 0);
  assert.equal(f.getWrites(), 0);
});

test('preview aborts when manifest or commit history changes between read passes', async () => {
  const f = await fixture({ changeSecondRead: true });
  await assert.rejects(readOnlySchema2MigrationPreview({ store: f.store, scopePath: 'Shared' }), /changed during preview/);
  assert.equal(f.getWrites(), 0);
});

test('preview fingerprint covers data-slot hashes and TeamPlugins rows', async () => {
  for (const change of [{ changeDataSecondRead: true }, { changePluginsSecondRead: true }]) {
    const f = await fixture(change);
    await assert.rejects(readOnlySchema2MigrationPreview({ store: f.store, scopePath: 'Shared' }), /changed during preview/);
    assert.equal(f.getWrites(), 0);
  }
});

test('preview refuses invalid scope before any project reads', async () => {
  const f = await fixture();
  await assert.rejects(readOnlySchema2MigrationPreview({ store: f.store, scopePath: '../Private' }), /Invalid selected scope/);
  assert.equal(f.getReads(), 0);
  assert.equal(f.getWrites(), 0);
});

test('explicit backup snapshot captures nine manifests and raw occupied slots only after stable double read', async () => {
  const f = await fixture();
  const snapshot = await readOnlyMigrationSnapshot({ store: f.store, scopePath: 'Shared', verifyBlobs: true, includeBackupData: true });
  assert.equal(snapshot.backupSnapshot.stableSnapshot, true);
  assert.equal(snapshot.backupSnapshot.remoteWrites, 0);
  assert.equal(snapshot.backupSnapshot.sheets.length, 9);
  assert.equal(snapshot.backupSnapshot.sheets[0].slots[0].kind, 'C');
  assert.equal(snapshot.backupSnapshot.sheets[8].slots[0].kind, 'D');
  const bundle = await buildVerifiedBackup(snapshot.backupSnapshot);
  assert.equal(bundle.sheets.length, 9);
});
