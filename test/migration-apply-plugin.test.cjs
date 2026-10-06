'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sourcePath = path.join(__dirname, '../src/main.cjs');
const source = fs.readFileSync(sourcePath, 'utf8'), hostRequire = createRequire(sourcePath);
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const rootId = 'root_fixture_1234', shardIds = Array.from({ length: 8 }, (_, i) => `shard_fixture_${i}`);
  const fingerprint = 'a'.repeat(64), epoch = 'b'.repeat(64), bundleSha256 = 'c'.repeat(64), scopePath = 'Pilot/Shared';
  const plan = { rootId, shardIds, scopePath, sourceFingerprint: fingerprint, epoch, backupBundleSha256: bundleSha256,
    report: { revisionCount: 3, pathCounts: { 'inside-selected-folder': 2, 'outside-selected-folder': 1, 'case-ambiguous': 0 },
      activeLegacyRevisionCount: 2, quarantinedRevisionCount: 1 },
    receipts: [...shardIds, rootId].map(spreadsheetId => ({ spreadsheetId, epoch })) };
  const proof = { verified: true, bundleSha256, sourceFingerprint: fingerprint, projectRootId: rootId,
    revisionCount: 3, blobGroups: 2, allBlobBytes: 20 };
  const atomicProof = { verified: true, projectRootId: rootId, sourceFingerprint: fingerprint,
    operation: 'duplicate-named-range-atomic-rejection', proofDigest: 'd'.repeat(64) };
  const bytes = new TextEncoder().encode('synthetic saved backup');
  const backupPath = `.easy-sync/recovery/migration/${rootId}/${bundleSha256}.json`;
  const preparation = { plan, proof, backupPath, preview: { eventFingerprint: 'e'.repeat(64) } };
  const data = clone(options.savedData || { fencedMigrationPreparations: { [rootId]: preparation } });
  const states = options.states || new Map([...shardIds, rootId].map(id => [id, 'source']));
  const state = { probe: 0, runner: 0, fences: 0, legacyWriter: 0, network: 0, auth: 0, backupReads: 0,
    restoreProofs: 0, sync: 0, saves: [], log: [], notices: [], saved: clone(data), snapshots: 0 };
  let plugin;
  const obsidian = { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {}, Setting: class {},
    Notice: class { constructor(message) { state.notices.push(message); } },
    requestUrl: async () => { throw new Error('Real requests forbidden in fixture'); } };
  const injected = {
    obsidian,
    './team-sharded-store.cjs': { TeamShardedStore: class {
      constructor(args) { this.rootId = args.rootId; }
      async call(_url, options = {}) { state.network++; state.log.push(options.method === 'POST' ? 'request-write' : 'request-read'); }
    } },
    './legacy-migration-remote-preview.cjs': { readOnlyMigrationSnapshot: async () => { state.snapshots++; throw new Error('No new snapshot on resume'); } },
    './backup-reader-verification.cjs': { verifyBackupWithReader: async actual => {
      state.restoreProofs++; state.log.push('verify-backup');
      if (options.corruptBackup || !Buffer.from(actual).equals(Buffer.from(bytes))) throw new Error('Corrupt saved backup');
      if (options.backupGate) await options.backupGate.promise;
      return clone({ ...proof, ...options.proofPatch });
    } },
    './fenced-migration.cjs': {
      prepareFencedMigration: async () => { throw new Error('No replacement plan on resume'); },
      createGoogleFenceAdapter: ({ store, plan: supplied }) => {
        assert.equal(supplied.epoch, epoch);
        return {
          readState: async receipt => {
            await store.call('https://fixture/read'); state.log.push(`read:${receipt.spreadsheetId}`);
            await options.onState?.(plugin, state, receipt);
            return { state: states.get(receipt.spreadsheetId) };
          },
          claimFence: async receipt => {
            assert.equal(state.saved.fencedMigrationPreparations[rootId].atomicFenceProof?.proofDigest, atomicProof.proofDigest,
              'Proof must be durably saved before any fence call');
            await store.call('https://fixture/write', { method: 'POST' });
            states.set(receipt.spreadsheetId, 'fenced'); state.fences++; state.log.push(`fence:${receipt.spreadsheetId}`);
            if (state.fences === options.crashAfter) throw new Error('Synthetic interruption after committed fence');
          },
          verifyActivation: async () => { state.log.push('verify-activation'); return { epoch, pathProtocol: 'project-relative-v1', namespace: rootId }; }
        };
      },
      probeGoogleFenceAtomicity: async args => {
        assert.equal(args.approved, true); assert.equal(args.approvalFingerprint, fingerprint);
        assert.ok(plan.receipts.every(receipt => state.log.includes(`read:${receipt.spreadsheetId}`)), 'All sheets must be checked before probe');
        state.probe++; state.log.push('probe');
        if (options.failedProbe) throw new Error('Atomic probe failed');
        return clone({ ...atomicProof, ...options.atomicPatch });
      },
      executeFencedMigration: async args => {
        state.runner++; assert.equal(args.approved, true); assert.equal(args.syncPaused, true);
        assert.equal(args.approvalFingerprint, fingerprint); assert.equal(args.plan.epoch, epoch);
        assert.equal(args.backupProof.bundleSha256, bundleSha256); assert.equal(args.atomicFenceProof.proofDigest, atomicProof.proofDigest);
        for (const receipt of args.plan.receipts) await args.adapter.readState(receipt);
        let writes = 0;
        for (const receipt of args.plan.receipts) {
          if ((await args.adapter.readState(receipt)).state === 'fenced') continue;
          await args.adapter.claimFence(receipt); writes++;
        }
        await args.adapter.verifyActivation();
        return { state: 'complete', epoch, writes, sourceFingerprint: fingerprint };
      }
    },
    './google-migration-adapter.cjs': { createGoogleMigrationAdapter: () => { state.legacyWriter++; throw new Error('Legacy writer forbidden'); } },
    './legacy-migration-runner.cjs': { executeSchema2Migration: async () => { state.legacyWriter++; throw new Error('Legacy runner forbidden'); } }
  };
  const context = vm.createContext({ module: { exports: {} }, require: id => injected[id] || hostRequire(id),
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams, structuredClone,
    btoa, atob, setTimeout, clearTimeout, console });
  vm.runInContext(source, context, { filename: sourcePath });
  plugin = new context.module.exports();
  const local = new Map([[`amygdala-team-scope-${rootId}`, scopePath]]);
  Object.assign(plugin, { device: 'fixture_device', stopped: false, running: false, prefs: { auto: false },
    pluginData: data, diagnosticWrite: Promise.resolve(), progressListeners: new Set(), autoSyncGeneration: 0,
    connection: { id: rootId, kind: 'team', version: 4 }, authHealth: {},
    v4Auth: { accessToken: async () => { state.auth++; throw new Error('Auth forbidden in fixture'); } },
    saveData: async saved => {
      await options.onSave?.(plugin, saved);
      state.saved = clone(saved); state.saves.push(clone(saved));
      state.log.push(saved.fencedMigrationPreparations[rootId]?.atomicFenceProof ? 'save-probe-proof' : 'save-plan');
    },
    drive: () => { state.sync++; throw new Error('Sync forbidden during migration'); } });
  plugin.app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    vault: { getAbstractFileByPath: folder => ({ path: folder, children: [] }), adapter: {
      readBinary: async target => { assert.equal(target, backupPath); state.backupReads++; state.log.push('read-backup'); return bytes.slice().buffer; }
    } } };
  plugin.restorePreparedMigrationCandidate();
  // Exercise dormant orchestration only. This fixture override is not evidence
  // that the production legacy-writer safety gate may be lifted.
  if (!options.productionGate) plugin.migrationLiveWriteBlocker = () => null;
  const approve = () => { plugin.migrationAllParticipantsPaused = true; plugin.migrationWriteApprovedFingerprint = fingerprint; };
  return { plugin, state, states, local, rootId, plan, proof, atomicProof, approve, preparation, backupPath };
}

test('dormant integration with fixture-only gate override rechecks backup and persists probe proof before fences', async () => {
  const f = fixture();
  assert.equal(f.plugin.canApplyTeamMigration(), false, 'startup never creates consent');
  f.approve(); assert.equal(f.plugin.canApplyTeamMigration(), true);
  const result = await f.plugin.applyTeamMigration();
  assert.equal(result.state, 'complete'); assert.equal(f.state.probe, 1); assert.equal(f.state.fences, 9);
  assert.ok(f.state.log.indexOf('save-probe-proof') < f.state.log.findIndex(item => item.startsWith('fence:')));
  assert.equal(f.state.saved.fencedMigrationPreparations[f.rootId].completed, true);
  assert.equal(f.plugin.prefs.auto, false); assert.equal(f.plugin.lastMigrationPreview.migrationState, 'complete');
  assert.equal(f.state.legacyWriter + f.state.sync + f.state.auth, 0);
  assert.equal(f.plugin.canApplyTeamMigration(), false, 'completion needs no repeated approval or second execution');
  assert.equal(f.state.saved.fencedMigrationPreparations[f.rootId].backupPath, f.backupPath);
});

test('production legacy-writer gate blocks an otherwise fully approved prepared plan before any reads or requests', async () => {
  const f = fixture({ productionGate: true }); f.approve();
  assert.equal(f.plugin.canApplyTeamMigration(), false);
  await assert.rejects(f.plugin.applyTeamMigration(), /новый механизм.*ещё не подключён/);
  assert.equal(f.state.backupReads + f.state.network + f.state.probe + f.state.runner + f.state.fences, 0);
});

test('unprepared, changed scope, pending operations, or non-exact approval produce zero network calls', async () => {
  for (const change of [f => { delete f.plugin.pluginData.fencedMigrationPreparations[f.rootId]; },
    f => { f.local.set(`amygdala-team-scope-${f.rootId}`, 'Other Shared'); },
    f => { f.plugin.migrationWriteApprovedFingerprint = f.plan.sourceFingerprint.slice(0, 16); },
    f => { f.plugin.migrationAllParticipantsPaused = false; },
    f => { f.plugin.pluginData.v4ScopedOperations = { [f.rootId]: { pending: {} } }; }]) {
    const f = fixture(); f.approve(); change(f);
    await assert.rejects(f.plugin.applyTeamMigration(), /Миграция недоступна/);
    assert.equal(f.state.network + f.state.probe + f.state.fences + f.state.backupReads, 0);
  }
});

test('corrupt saved backup and failed or mismatched atomic proof result in zero fences', async () => {
  for (const options of [{ corruptBackup: true }, { proofPatch: { bundleSha256: 'f'.repeat(64) } },
    { failedProbe: true }, { atomicPatch: { sourceFingerprint: 'f'.repeat(64) } }]) {
    const f = fixture(options); f.approve();
    assert.equal(await f.plugin.applyTeamMigration(), null);
    assert.equal(f.state.runner, 0); assert.equal(f.state.fences, 0); assert.equal(f.state.legacyWriter, 0);
    assert.equal(f.plugin.migrationApplying, false);
    assert.equal(f.state.saved.fencedMigrationPreparations[f.rootId].plan.epoch, f.plan.epoch);
  }
});

test('interrupted execution and restart retain original plan/epoch/proof, require explicit consent, and skip completed fences', async () => {
  const first = fixture({ crashAfter: 2 }); first.approve();
  assert.equal(await first.plugin.applyTeamMigration(), null);
  assert.equal(first.state.fences, 2); assert.equal(first.plugin.lastMigrationPreview.migrationState, 'partial');
  assert.equal(first.plugin.canPrepareTeamMigration(), false, 'partial fences cannot be replaced by a new plan');
  const second = fixture({ savedData: first.state.saved, states: first.states });
  assert.equal(second.plugin.lastMigrationPreview.migrationState, 'partial');
  assert.equal(second.plugin.migrationWriteApprovedFingerprint, null);
  assert.equal(second.plugin.canApplyTeamMigration(), false);
  second.approve(); const resumed = await second.plugin.applyTeamMigration();
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.writes, 7);
  assert.equal(second.state.probe, 0, 'matching persisted proof is reused');
  assert.equal(second.state.backupReads, 1, 'saved backup is re-read on resume');
  assert.equal(second.state.restoreProofs, 1); assert.equal(second.state.snapshots, 0);
  assert.deepEqual(second.state.saved.fencedMigrationPreparations[second.rootId].plan, first.plan);
});

test('a persisted probe proof for another root, fingerprint, operation, or invalid digest cannot be reused', async () => {
  for (const patch of [{ projectRootId: 'other_root_1234' }, { sourceFingerprint: 'f'.repeat(64) },
    { operation: 'different-operation' }, { proofDigest: 'short' }]) {
    const f = fixture(); f.approve();
    f.plugin.pluginData.fencedMigrationPreparations[f.rootId].atomicFenceProof = { ...f.atomicProof, ...patch };
    assert.equal(await f.plugin.applyTeamMigration(), null);
    assert.equal(f.state.probe + f.state.runner + f.state.fences, 0);
  }
});

test('scope/generation changes at an awaited read stop before probe and fence writes', async () => {
  for (const change of [p => { p.autoSyncGeneration++; }, p => { p.connection = { ...p.connection }; },
    p => { p.app.saveLocalStorage(p.teamScopeKey(), 'Other Shared'); }]) {
    let changed = false;
    const f = fixture({ onState: async p => { if (!changed) { changed = true; change(p); } } }); f.approve();
    assert.equal(await f.plugin.applyTeamMigration(), null);
    assert.equal(f.state.probe + f.state.runner + f.state.fences, 0);
  }
});

test('selection, auto changes, access checks, previews, and sync cannot interfere with an applying migration', async () => {
  const gate = deferred(), f = fixture({ backupGate: gate }); f.approve();
  const applying = f.plugin.applyTeamMigration();
  await f.plugin.sync(true); await f.plugin.sync(false);
  await assert.rejects(f.plugin.selectVault({ id: 'other_root', kind: 'team', version: 4 }), /текущей операции/);
  await assert.rejects(f.plugin.setAutomaticSync(false), /окончания миграции/);
  await assert.rejects(f.plugin.previewTeamMigration(), /текущей операции/);
  assert.equal(await f.plugin.checkGoogleAccess(), false);
  assert.equal(f.state.sync + f.state.network + f.state.auth, 0);
  gate.resolve(); assert.equal((await applying).state, 'complete');
});

test('failed persistence of probe proof prevents the runner and all fence writes', async () => {
  const f = fixture({ onSave: async (_p, data) => {
    if (data.fencedMigrationPreparations.root_fixture_1234.atomicFenceProof) throw new Error('Synthetic local save failure');
  } }); f.approve();
  assert.equal(await f.plugin.applyTeamMigration(), null);
  assert.equal(f.state.probe, 1); assert.equal(f.state.runner + f.state.fences, 0);
});
