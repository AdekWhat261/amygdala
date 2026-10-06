'use strict';
const assert = require('node:assert/strict');
const { fixture, OldStore, rangeMarker, encode, copy } = require('./slot-fence-fixture.cjs');
const { TeamShardedStore } = require('../src/team-sharded-store.cjs');
const { readOnlyMigrationSnapshot } = require('../src/legacy-migration-remote-preview.cjs');
const { prepareLockedMigration } = require('../src/locked-migration.cjs');
const { createGoogleLockAdapter } = require('../src/google-locked-migration.cjs');

async function lockFixture(options = {}) {
  const f = await fixture({ ...options, fenced: false }), batches = [];
  let attempts = 0;
  function wire(store) {
    const previousValues = store.values;
    store.values = async (id, range) => {
      if (range === 'TeamPlugins!A2:C') return { values: copy((f.books.get(id).teamPluginsRows || []).slice(1)) };
      const match = /^Meta!A(\d+):B(\d+)$/.exec(range);
      if (!match) return previousValues(id, range);
      const book = f.books.get(id), rows = [['key', 'value'], ['manifest', JSON.stringify(book.manifest)],
        ...(book.lock ? [['slotLock', JSON.stringify(book.lock)]] : []),
        ...(book.active ? [['slotActivation', JSON.stringify(book.active)]] : [])];
      return { values: copy(rows.slice(Number(match[1]) - 1, Number(match[2]))) };
    };
    store.batch = async (id, requests) => {
      attempts++;
      const book = f.books.get(id), additions = requests.filter(item => item.addNamedRange).map(item => item.addNamedRange.namedRange);
      if (new Set(additions.map(item => item.name)).size !== additions.length
        || additions.some(item => book.metadata.namedRanges.some(old => old.name === item.name || old.namedRangeId === item.namedRangeId))) {
        const error = new Error('Synthetic atomic duplicate named range');
        error.status = 400; error.googleDuplicateNamedRange = true; throw error;
      }
      // Validate the entire batch before applying any operation.
      for (const request of requests) {
        if (request.addNamedRange) continue;
        assert.ok(request.updateCells);
        const update = request.updateCells;
        assert.ok([1, 2].includes(update.range.sheetId));
        if (update.range.sheetId === 1) {
          assert.ok([2, 3].includes(update.range.startRowIndex));
          JSON.parse(update.rows[0].values[1].userEnteredValue.stringValue);
        }
      }
      book.metadata.namedRanges.push(...copy(additions));
      for (const request of requests) if (request.updateCells) {
        const update = request.updateCells;
        if (update.range.sheetId === 1) {
          book[update.range.startRowIndex === 2 ? 'lock' : 'active'] = JSON.parse(update.rows[0].values[1].userEnteredValue.stringValue);
        } else update.rows.forEach((row, index) => book.rows.set(update.range.startRowIndex + index,
          row.values.map(cell => cell.userEnteredValue?.stringValue || '')));
      }
      batches.push({ id, requests: copy(requests) });
      return {};
    };
    return store;
  }
  const make = (Class = TeamShardedStore, options = {}) => wire(f.make(Class, options));
  const store = make(), snapshot = await readOnlyMigrationSnapshot({ store, scopePath: 'Shared', verifyBlobs: true, includeBackupData: true });
  const plan = await prepareLockedMigration(snapshot), adapter = createGoogleLockAdapter({ store, plan });
  return { ...f, store, make, snapshot, plan, adapter, lockBatches: batches, getLockAttempts: () => attempts };
}
function initialApproval(f, changes = {}) {
  return { plan: f.plan, adapter: f.adapter, approved: true, syncPaused: true,
    approvalFingerprint: f.plan.sourceFingerprint,
    backupProof: { verified: true, bundleSha256: f.plan.backupBundleSha256,
      sourceFingerprint: f.plan.sourceFingerprint, projectRootId: f.plan.rootId },
    atomicFenceProof: { verified: true, projectRootId: f.plan.rootId, sourceFingerprint: f.plan.sourceFingerprint,
      operation: 'duplicate-named-range-atomic-rejection', proofDigest: 'a'.repeat(64) }, ...changes };
}
module.exports = { lockFixture, initialApproval, OldStore, rangeMarker, encode, copy };
