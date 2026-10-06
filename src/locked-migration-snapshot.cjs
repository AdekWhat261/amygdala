'use strict';
const { createGoogleLockAdapter } = require('./google-locked-migration.cjs');
const { validateLockedPlan } = require('./locked-migration.cjs');
const { readFrozenSnapshotPass } = require('./locked-snapshot-content.cjs');

/** Full bytes of all frozen records, including unreferenced late D allocations. */
async function readLockedMigrationSnapshot({ store, plan } = {}) {
  await validateLockedPlan(plan);
  const adapter = createGoogleLockAdapter({ store, plan });
  const readPass = () => readFrozenSnapshotPass({ store, plan, readState: adapter.readState });
  const first = await readPass(), second = await readPass();
  if (first.fingerprint !== second.fingerprint) throw new Error('Полный снимок изменился между проверками.');
  return second;
}

module.exports = { readLockedMigrationSnapshot };
