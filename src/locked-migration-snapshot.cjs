'use strict';
const { createGoogleLockAdapter } = require('./google-locked-migration.cjs');
const { validateLockedPlan } = require('./locked-migration.cjs');
const { fenceDigest } = require('./slot-fence.cjs');
const { slotDigest } = require('./verified-backup.cjs');

/** Full bytes of all frozen records, including unreferenced late D allocations. */
async function readLockedMigrationSnapshot({ store, plan } = {}) {
  await validateLockedPlan(plan);
  const adapter = createGoogleLockAdapter({ store, plan });
  async function readPass() {
    const sheets = [];
    for (const id of [plan.rootId, ...plan.shardIds]) {
      const state = await adapter.readState(id);
      if (state.state !== 'locked' || state.active) throw new Error('Нужны все девять остановленных таблиц до активации.');
      const records = await store.verifiedSlots(id, state.kind, state.sourceSlots, undefined, { preserveRaw: true });
      const slots = await Promise.all(records.map(async (record, index) => ({
        kind: state.kind, slot: state.sourceSlots[index], rows: record.rawRows, sha256: await slotDigest(record.rawRows)
      })));
      const file = state.file;
      sheets.push({ id, manifest: state.manifest, metadata: state.metadata,
        fileMetadata: { id, mimeType: file.mimeType, parents: file.parents,
          trashed: file.trashed, driveId: file.driveId || null },
        metaCells: (await store.values(id, 'Meta!A1:B3')).values || [],
        occupiedSlots: state.sourceSlots, slots,
        ...(id === plan.rootId ? { teamPluginsRows: (await store.values(id, 'TeamPlugins!A1:C')).values || [] } : {}) });
    }
    const project = { rootId: plan.rootId, shardIds: plan.shardIds, folderId: plan.folderId };
    const fingerprint = await fenceDigest({ protocol: 'amygdala-frozen-snapshot-v2', lockId: plan.rootLock.lockId, project, sheets });
    return { stableSnapshot: true, verifyBlobs: true, remoteWrites: 0, project, sheets, fingerprint,
      migrationStage: 'locked', slotLockId: plan.rootLock.lockId };
  }
  const first = await readPass(), second = await readPass();
  if (first.fingerprint !== second.fingerprint) throw new Error('Полный снимок изменился между проверками.');
  return second;
}

module.exports = { readLockedMigrationSnapshot };
