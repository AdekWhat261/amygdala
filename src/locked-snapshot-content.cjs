'use strict';
const { fenceDigest, ACTIVE_RANGE_NAME } = require('./slot-fence.cjs');
const { slotDigest } = require('./verified-backup.cjs');

/** Capture the protected pre-activation contents, including late legacy D records.
 * ACTIVE controls and subsequent AS5 records are excluded only for recovery of
 * the same activation; readState still validates every live control and payload.
 */
async function readFrozenSnapshotPass({ store, plan, readState, allowActive = false } = {}) {
  const sheets = [];
  for (const id of [plan.rootId, ...plan.shardIds]) {
    const state = await readState(id);
    if (state.state !== 'locked' || (!allowActive && state.active))
      throw new Error('Нужны все девять остановленных таблиц до активации.');
    const records = await store.verifiedSlots(id, state.kind, state.sourceSlots, undefined, { preserveRaw: true });
    const slots = await Promise.all(records.map(async (record, index) => ({
      kind: state.kind, slot: state.sourceSlots[index], rows: record.rawRows, sha256: await slotDigest(record.rawRows)
    })));
    const metadata = structuredClone(state.metadata);
    metadata.namedRanges = (metadata.namedRanges || [])
      .filter(item => !allowActive || (item.name !== ACTIVE_RANGE_NAME && !item.name.startsWith(`AS5_${state.kind}_`)))
      .sort((a, b) => a.name.localeCompare(b.name));
    metadata.sheets = (metadata.sheets || []).sort((a, b) => a.properties.sheetId - b.properties.sheetId);
    let teamPluginsRows;
    if (id === plan.rootId) {
      teamPluginsRows = (await store.values(id, 'TeamPlugins!A1:C')).values || [];
      if (allowActive) {
        // New plans retain the prefix length; old plans safely require an unchanged full catalogue.
        const count = plan.sourceTeamPluginsRowCount ?? teamPluginsRows.length;
        if (teamPluginsRows.length < count || teamPluginsRows.length > 5001)
          throw new Error('История командных плагинов изменилась или переполнена.');
        teamPluginsRows = teamPluginsRows.slice(0, count);
        if (await fenceDigest(teamPluginsRows) !== plan.teamPluginsDigest)
          throw new Error('Исходные строки командных плагинов изменились.');
        const original = plan.sourceSheets.find(sheet => sheet.id === id).metadata.sheets
          .find(sheet => sheet.properties.sheetId === 3);
        const current = metadata.sheets.find(sheet => sheet.properties.sheetId === 3);
        current.properties.gridProperties.rowCount = original.properties.gridProperties.rowCount;
      }
    }
    const file = state.file;
    sheets.push({ id, manifest: state.manifest, metadata,
      fileMetadata: { id, mimeType: file.mimeType, parents: file.parents,
        trashed: file.trashed, driveId: file.driveId || null },
      metaCells: (await store.values(id, 'Meta!A1:B3')).values || [],
      occupiedSlots: state.sourceSlots, slots,
      ...(id === plan.rootId ? { teamPluginsRows } : {}) });
  }
  const project = { rootId: plan.rootId, shardIds: plan.shardIds, folderId: plan.folderId };
  const fingerprint = await fenceDigest({ protocol: 'amygdala-frozen-snapshot-v2', lockId: plan.rootLock.lockId, project, sheets });
  return { stableSnapshot: true, verifyBlobs: true, remoteWrites: 0, project, sheets, fingerprint,
    migrationStage: 'locked', slotLockId: plan.rootLock.lockId };
}

module.exports = { readFrozenSnapshotPass };
