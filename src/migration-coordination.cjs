'use strict';

/**
 * Advisory readiness assessment only. It is deliberately not a lock and cannot
 * authorize Google Sheets writes. Google Sheets offers no cross-workbook CAS.
 */
function assessMigrationCoordination(state = {}) {
  const blockers = [];
  if (state.writerSerialization !== 'provider-atomic') blockers.push('provider-atomic-writer-serialization-unavailable');
  if (state.rosterKnown !== true) blockers.push('active-client-roster-unknown');
  if (state.allClientsPaused !== true) blockers.push('all-clients-not-confirmed-paused');
  if (state.legacyClients === true || state.legacyClients == null) blockers.push('legacy-client-may-write');
  if (state.pendingOperationsKnown !== true || state.pendingOperations !== 0) blockers.push('pending-operations-not-cleared');
  if (state.backupVerified !== true) blockers.push('verified-backup-and-restore-required');
  if (state.snapshotFingerprint !== state.approvedFingerprint || !/^[a-f0-9]{64}$/i.test(state.snapshotFingerprint || ''))
    blockers.push('snapshot-fingerprint-not-currently-approved');
  return Object.freeze({ readyForReview: blockers.length === 0, canWrite: false, blockers: Object.freeze(blockers) });
}

module.exports = { assessMigrationCoordination };
