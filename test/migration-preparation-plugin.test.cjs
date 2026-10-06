'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sourcePath = path.join(__dirname, '../src/main.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const hostRequire = createRequire(sourcePath);
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const rootId = 'root_fixture_1234', scope = 'Pilot/Shared';
  const fingerprint = 'a'.repeat(64), bundleSha256 = 'b'.repeat(64);
  const bytes = new TextEncoder().encode('{"backup":"synthetic bytes only"}');
  const backup = { project: { rootId }, sourceFingerprint: fingerprint, bundleSha256 };
  const snapshot = { localScope: scope, fingerprint, eventFingerprint: 'e'.repeat(64), backupSnapshot: { marker: 'synthetic snapshot' } };
  const plan = { rootId, scopePath: scope, sourceFingerprint: fingerprint, backupBundleSha256: bundleSha256,
    epoch: 'c'.repeat(64), shardIds: Array.from({ length: 8 }, (_, i) => `fixture_shard_${i}`), report: { revisionCount: 2 }, remoteWrites: 0 };
  const proof = { verified: true, bundleSha256, sourceFingerprint: fingerprint, projectRootId: rootId,
    revisionCount: 2, blobGroups: 1, completeBlobGroups: 1, incompleteBlobGroups: 0, allBlobBytes: 12,
    remoteWrites: 0, networkRequests: 0, authenticationCalls: 0 };
  const state = { snapshotReads: 0, stores: 0, proofReads: 0, remoteWrites: 0, requests: 0, syncs: 0,
    fileWrites: 0, fileReads: 0, saved: [], notices: [], settings: [] };
  const local = new Map([[`amygdala-team-scope-${rootId}`, scope]]), files = new Map(), directories = new Set();
  const backupPath = `.easy-sync/recovery/migration/${rootId}/${bundleSha256}.json`;
  class Setting {
    constructor() { this.row = {}; state.settings.push(this.row); }
    setName(name) { this.row.name = name; return this; }
    setDesc(desc) { this.row.desc = desc; return this; }
    addButton(callback) {
      const button = { setButtonText: text => { this.row.buttonText = text; return button; },
        setDisabled: value => { this.row.disabled = value; return button; },
        onClick: fn => { this.row.click = fn; return button; } };
      callback(button); return this;
    }
  }
  const obsidian = { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {}, Setting,
    Notice: class { constructor(message) { state.notices.push(message); } },
    requestUrl: async () => { state.requests++; throw new Error('Unexpected real request'); } };
  const injections = {
    obsidian,
    './team-sharded-store.cjs': { TeamShardedStore: class { constructor(args) { this.args = args; state.stores++; } } },
    './legacy-migration-remote-preview.cjs': {
      readOnlySchema2MigrationPreview: async () => { throw new Error('Unexpected legacy preview'); },
      readOnlyMigrationSnapshot: async args => {
        state.snapshotReads++;
        assert.equal(args.scopePath, scope); assert.equal(args.verifyBlobs, true); assert.equal(args.includeBackupData, true);
        assert.equal(args.store.args.rootId, rootId);
        if (options.snapshotGate) await options.snapshotGate.promise;
        await options.onSnapshot?.();
        return clone(snapshot);
      }
    },
    './fenced-migration.cjs': { prepareFencedMigration: async input => {
      assert.deepEqual(input, snapshot); return clone({ ...plan, ...options.planPatch });
    } },
    './verified-backup.cjs': { buildVerifiedBackup: async input => {
      assert.deepEqual(input, snapshot.backupSnapshot); return clone(backup);
    }, encodeBackup: async () => bytes.slice() },
    './backup-reader-verification.cjs': { verifyBackupWithReader: async input => {
      state.proofReads++; assert.deepEqual(input, bytes);
      if (options.proofGate) await options.proofGate.promise;
      return clone({ ...proof, ...options.proofPatch });
    } },
    './google-migration-adapter.cjs': { GOOGLE_MIGRATION_WRITE_BLOCKER: 'Migration writes are disabled: live proof absent',
      createGoogleMigrationAdapter: () => { state.remoteWrites++; throw new Error('Forbidden writer'); } },
    './legacy-migration-runner.cjs': { executeSchema2Migration: async () => { state.remoteWrites++; throw new Error('Forbidden writer'); } }
  };
  const context = vm.createContext({ module: { exports: {} }, require: id => injections[id] || hostRequire(id),
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams,
    btoa, atob, setTimeout, clearTimeout, structuredClone, console });
  vm.runInContext(source, context, { filename: sourcePath });
  const plugin = new context.module.exports();
  Object.assign(plugin, { stopped: false, running: false, device: 'fixture_device', prefs: { auto: false },
    pluginData: {}, authHealth: {}, progressListeners: new Set(), diagnosticWrite: Promise.resolve(),
    connection: { id: rootId, kind: 'team', version: 4 }, autoSyncGeneration: 0,
    v4Auth: { accessToken: async () => { throw new Error('No authentication in fixture'); } },
    saveData: async data => { state.saved.push(clone(data)); await options.onSave?.(); },
    drive: () => { state.syncs++; throw new Error('Preparation must not sync'); },
    report: error => { throw error; } });
  plugin.app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    vault: { getAbstractFileByPath: folder => ({ path: folder, children: [] }), adapter: {
      exists: async item => files.has(item) || directories.has(item),
      mkdir: async item => { directories.add(item); },
      writeBinary: async (item, value) => { state.fileWrites++; files.set(item, new Uint8Array(value).slice()); },
      readBinary: async item => { state.fileReads++; const value = files.get(item); if (!value) throw new Error('Missing fixture backup');
        return (options.corruptRead ? new Uint8Array([1, 2, 3]) : value.slice()).buffer; }
    } } };
  return { plugin, state, files, directories, local, rootId, scope, plan, proof, bytes, backupPath };
}

test('preparation writes only hidden recovery bytes, reads them back, verifies restore, then persists plan/path/proof', async () => {
  const f = fixture(), result = await f.plugin.prepareTeamMigration();
  assert.ok(result); assert.equal(f.state.snapshotReads, 1); assert.equal(f.state.proofReads, 1);
  assert.equal(f.state.fileWrites, 1); assert.equal(f.state.fileReads, 1);
  assert.deepEqual([...f.files.keys()], [f.backupPath]); assert.deepEqual(f.files.get(f.backupPath), f.bytes);
  assert.deepEqual(Object.keys(f.state.saved[0].fencedMigrationPreparations[f.rootId]).sort(), ['backupPath', 'plan', 'preview', 'proof']);
  assert.equal(f.plugin.lastMigrationPreview.eventFingerprint, 'e'.repeat(64));
  assert.equal(f.plugin.lastMigrationPreview.shardIds.length, 8);
  assert.equal(f.plugin.lastMigrationPreview.snapshotFingerprint, f.plan.sourceFingerprint);
  assert.equal(f.plugin.lastMigrationPreview.backupSnapshot, undefined);
  assert.equal(f.plugin.preparedTeamMigration().proof.verified, true);
  assert.equal(f.plugin.migrationWriteApprovedFingerprint, null); assert.equal(f.plugin.canApplyTeamMigration(), false);
  await assert.rejects(f.plugin.applyTeamMigration(), /новый механизм.*ещё не подключён/);
  assert.equal(f.state.requests + f.state.remoteWrites + f.state.syncs, 0);
  assert.match(f.plugin.label, /Восстановление проверено в памяти/);
  assert.equal(f.plugin.migrationPreparing, false);
});

test('existing matching backup is reused; existing mismatched bytes are never overwritten', async () => {
  const match = fixture(); match.files.set(match.backupPath, match.bytes.slice());
  assert.ok(await match.plugin.prepareTeamMigration()); assert.equal(match.state.fileWrites, 0);
  const mismatch = fixture(); mismatch.files.set(mismatch.backupPath, new Uint8Array([42]));
  assert.equal(await mismatch.plugin.prepareTeamMigration(), null);
  assert.deepEqual(mismatch.files.get(mismatch.backupPath), new Uint8Array([42]));
  assert.equal(mismatch.state.fileWrites, 0); assert.equal(mismatch.state.proofReads, 0); assert.equal(mismatch.state.saved.length, 0);
  assert.equal(mismatch.plugin.preparedTeamMigration(), null);
});

test('corrupt read-back, wrong proof, and mismatched plan cannot persist preparation or approval', async () => {
  for (const options of [{ corruptRead: true }, { proofPatch: { bundleSha256: 'd'.repeat(64) } },
    { proofPatch: { sourceFingerprint: 'd'.repeat(64) } }, { proofPatch: { projectRootId: 'another_root' } },
    { planPatch: { scopePath: 'Other Shared' } }]) {
    const f = fixture(options);
    assert.equal(await f.plugin.prepareTeamMigration(), null);
    assert.equal(f.state.saved.length, 0); assert.equal(f.plugin.preparedTeamMigration(), null);
    assert.equal(f.plugin.canApplyTeamMigration(), false); assert.equal(f.state.remoteWrites, 0);
  }
});

test('scope, generation, or connection changes during reading abort before local backup write', async () => {
  for (const change of [f => f.local.set(`amygdala-team-scope-${f.rootId}`, 'Other Shared'),
    f => { f.plugin.autoSyncGeneration++; }, f => { f.plugin.connection = { ...f.plugin.connection }; },
    f => { f.plugin.connection.id = 'other_root_1234'; }]) {
    const gate = deferred(), f = fixture({ snapshotGate: gate });
    const pending = f.plugin.prepareTeamMigration(); change(f); gate.resolve();
    assert.equal(await pending, null); assert.equal(f.state.fileWrites, 0); assert.equal(f.state.saved.length, 0);
    assert.equal(f.plugin.migrationPreparationEligibility, null); assert.equal(f.plugin.canApplyTeamMigration(), false);
  }
});

test('late scope change during restore proof preserves backup bytes without persisting stale preparation', async () => {
  const gate = deferred(), f = fixture({ proofGate: gate });
  const pending = f.plugin.prepareTeamMigration();
  while (!f.state.proofReads) await new Promise(resolve => setImmediate(resolve));
  f.local.set(`amygdala-team-scope-${f.rootId}`, 'Other Shared'); gate.resolve();
  assert.equal(await pending, null); assert.equal(f.state.saved.length, 0);
  assert.deepEqual(f.files.get(f.backupPath), f.bytes); assert.equal(f.plugin.preparedTeamMigration(), null);
});

test('preparation blocks manual and automatic sync, scope changes, and duplicate preparation', async () => {
  const gate = deferred(), f = fixture({ snapshotGate: gate });
  const pending = f.plugin.prepareTeamMigration();
  await f.plugin.sync(true); await f.plugin.sync(false);
  await assert.rejects(f.plugin.setTeamScopeFolder('Other Shared'), /текущей операции/);
  await assert.rejects(f.plugin.prepareTeamMigration(), /завершите/);
  assert.equal(f.state.syncs + f.state.requests + f.state.remoteWrites, 0);
  gate.resolve(); assert.ok(await pending);
  await f.plugin.setTeamScopeFolder('Other Shared');
  assert.equal(f.plugin.preparedTeamMigration(), null);
  assert.ok(f.plugin.pluginData.fencedMigrationPreparations[f.rootId], 'Prepared plan and proof remain preserved');
  assert.deepEqual(f.files.get(f.backupPath), f.bytes, 'Existing backup bytes remain preserved');
  await f.plugin.setTeamScopeFolder(f.scope);
  assert.equal(f.plugin.preparedTeamMigration(), null, 'Returning to the old path must not silently reuse eligibility');
});

test('automatic enable and pending legacy operations are rejected before preparation reads', async () => {
  const gate = deferred(), paused = fixture({ snapshotGate: gate });
  const pending = paused.plugin.prepareTeamMigration();
  await assert.rejects(paused.plugin.setAutomaticSync(true), /текущей операции/);
  // Invalidating a generation also stops this preparation when its read returns.
  paused.plugin.onunload();
  gate.resolve(); assert.equal(await pending, null);
  // Use separate fixtures for gates that must reject before reading.
  for (const patch of [f => { f.plugin.prefs.auto = true; },
    f => { f.plugin.pluginData.v4ScopedOperations = { [f.rootId]: { old: { opId: 'old_pending' } } }; },
    f => { f.plugin.running = true; }, f => { f.plugin.checkingGoogleAccess = true; },
    f => { f.local.delete(`amygdala-team-scope-${f.rootId}`); }]) {
    const f = fixture(); patch(f);
    await assert.rejects(f.plugin.prepareTeamMigration(), /завершите/);
    assert.equal(f.state.snapshotReads + f.state.fileWrites + f.state.remoteWrites, 0);
  }
});

test('generation changes during persistence never grant preparation eligibility or migration approval', async () => {
  let f;
  f = fixture({ onSave: async () => { f.plugin.autoSyncGeneration++; } });
  assert.equal(await f.plugin.prepareTeamMigration(), null);
  assert.equal(f.plugin.preparedTeamMigration(), null); assert.equal(f.plugin.canApplyTeamMigration(), false);
  assert.equal(f.plugin.migrationWriteApprovedFingerprint, null);
  assert.ok(f.files.has(f.backupPath), 'Verified backup remains recoverable');
});

test('Russian preparation button is shared by modal and settings and distinguishes local proof from live migration', async () => {
  const f = fixture(), paragraphs = [];
  const el = { createEl: (_tag, value) => paragraphs.push(value.text) };
  f.plugin.renderMigrationPreparation(el, () => {});
  assert.equal(f.state.settings[0].buttonText, 'Подготовить резервную копию');
  assert.match(f.state.settings[0].desc, /полные данные девяти таблиц/);
  assert.match(f.state.settings[0].desc, /Ничего не записывает в Google/);
  assert.equal((source.match(/p\.renderMigrationPreparation\(el,/g) || []).length, 2);
  await f.state.settings[0].click();
  f.plugin.renderMigrationPreparation(el, () => {});
  assert.match(paragraphs[0], /не проверка живой миграции/);
});
