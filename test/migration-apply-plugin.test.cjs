'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLockedMigrationMethods } = require('../src/locked-migration-plugin.cjs');
function legacyFixture(attempted) {
 const id = 'root_fixture_1234'; let reads = 0;
 const plugin = { connection: { id, kind: 'team', version: 4 }, prefs: { auto: false },
  pluginData: { fencedMigrationPreparations: { [id]: { attempted, plan: { rootId: id, scopePath: 'Shared' } } } },
  connectionAuthMode: () => 'team-v4', teamScopePath: () => 'Shared' };
 Object.assign(plugin, createLockedMigrationMethods({ createStore: () => { reads++; throw new Error('V1 store forbidden'); },
  locks: new Set(), Notice: class {}, Setting: class {} }));
 return { plugin, reads: () => reads };
}
for (const attempted of [false, true]) test('saved V1 plan stays blocked without reads or replacement: attempted=' + attempted, async () => {
 const f = legacyFixture(attempted); f.plugin.restorePreparedMigrationCandidate();
 f.plugin.migrationAllParticipantsPaused = true; f.plugin.migrationWriteApprovedFingerprint = 'a'.repeat(64);
 assert.equal(f.plugin.canPrepareTeamMigration(), false); assert.equal(f.plugin.canApplyTeamMigration(), false);
 await assert.rejects(f.plugin.applyTeamMigration(), /V1 заблокирован/);
 await assert.rejects(f.plugin.prepareTeamMigration(), /Сохранённый план не заменяется/);
 assert.equal(f.reads(), 0); assert.equal(f.plugin.pluginData.fencedMigrationPreparations.root_fixture_1234.attempted, attempted);
});
