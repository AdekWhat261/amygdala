'use strict';

const HASH = /^[a-f0-9]{64}$/i;

/**
 * Safe copy-on-write migration planner. The source is immutable; a destination
 * is a separate, empty project and remains unmounted until manual cutover.
 * This pure planner performs no I/O and cannot authorize a Google write.
 */
function prepareShadowMigration({ sourceId, sourceFingerprint, records, destinationId, destinationEmpty } = {}) {
  if (typeof sourceId !== 'string' || !sourceId || typeof destinationId !== 'string' || !destinationId || sourceId === destinationId)
    throw new Error('Shadow migration requires distinct source and destination projects');
  if (!HASH.test(sourceFingerprint || '') || destinationEmpty !== true || !Array.isArray(records))
    throw new Error('Stable source fingerprint, empty destination, and complete record inventory are required');
  const seen = new Set();
  const expectedRecords = records.map(record => {
    if (!record || typeof record.id !== 'string' || !record.id || !HASH.test(record.sha256 || '') || seen.has(record.id))
      throw new Error('Shadow migration inventory contains an invalid or duplicate record');
    seen.add(record.id);
    return Object.freeze({ id: record.id, sha256: record.sha256.toLowerCase() });
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!expectedRecords.length) throw new Error('Shadow migration inventory is empty');
  return Object.freeze({ version: 1, sourceId, sourceFingerprint: sourceFingerprint.toLowerCase(),
    destinationId, expectedRecords: Object.freeze(expectedRecords), sourceMutationCount: 0,
    destinationMustRemainUnshared: true, cutoverRequiresSeparateHumanAction: true, canWrite: false });
}

function planShadowResume(plan, destinationSnapshot) {
  if (!plan || plan.version !== 1 || plan.canWrite !== false || plan.sourceMutationCount !== 0
    || !destinationSnapshot || destinationSnapshot.projectId !== plan.destinationId
    || destinationSnapshot.sourceFingerprint !== plan.sourceFingerprint || !Array.isArray(destinationSnapshot.records))
    throw new Error('Shadow migration checkpoint identity or source fingerprint changed');
  const expected = new Map(plan.expectedRecords.map(record => [record.id, record.sha256]));
  const existing = new Set();
  for (const record of destinationSnapshot.records) {
    if (!record || !expected.has(record.id) || expected.get(record.id) !== record.sha256 || existing.has(record.id))
      throw new Error('Shadow destination contains an unexpected, duplicate, or mismatched record');
    existing.add(record.id);
  }
  return Object.freeze({ pending: Object.freeze(plan.expectedRecords.filter(record => !existing.has(record.id))),
    copiedCount: existing.size, expectedCount: expected.size, sourceMutationCount: 0, remoteWrites: 0 });
}

function verifyShadowCopy(plan, destinationSnapshot, finalSourceFingerprint) {
  if (finalSourceFingerprint !== plan.sourceFingerprint) throw new Error('Source changed during shadow copy; discard destination and re-preview');
  const state = planShadowResume(plan, destinationSnapshot);
  if (state.pending.length) throw new Error('Shadow destination is incomplete');
  return Object.freeze({ verified: true, sourceMutationCount: 0, remoteWrites: 0,
    destinationId: plan.destinationId, sourceFingerprint: plan.sourceFingerprint,
    requiresAllClientsKnownAndPaused: true, canCutOverAutomatically: false });
}

module.exports = { prepareShadowMigration, planShadowResume, verifyShadowCopy };
