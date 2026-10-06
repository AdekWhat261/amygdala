'use strict';
const { readOnlyMigrationSnapshot } = require('./legacy-migration-remote-preview.cjs');
const GOOGLE_MIGRATION_WRITE_BLOCKER = 'Migration writes are disabled: protection against concurrent writers and verified backup/restore are not established.';

/** Read-only until a reviewed writer-serialization and backup/restore design is implemented. */
function createGoogleMigrationAdapter({ store, scopePath } = {}) {
  if (!store || typeof store.call !== 'function' || typeof store.manifestFor !== 'function')
    throw new Error('Google Sheets migration adapter is unavailable');
  const state = () => readOnlyMigrationSnapshot({ store, scopePath, verifyBlobs: false });
  return Object.freeze({
    readSnapshot: state,
    async readManifest(id) { return store.manifestFor(id); },
    async readEventFingerprint() { return (await state()).eventFingerprint; },
    async writeManifest() {
      // Read/compare followed by an unconditional batchUpdate cannot exclude another writer.
      // Preview approval and a pause checkbox must never enable that unsafe write path.
      throw new Error(GOOGLE_MIGRATION_WRITE_BLOCKER);
    }
  });
}

module.exports = { createGoogleMigrationAdapter, GOOGLE_MIGRATION_WRITE_BLOCKER };
