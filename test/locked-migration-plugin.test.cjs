'use strict';
// Synthetic Google/Obsidian only. Real backup, restore reader, and V2 protocol execute in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { lockFixture } = require('../test-support/slot-lock-fixture.cjs');
const copy = value => structuredClone(value);
const mainPath = path.join(__dirname, '../src/main.cjs'), helperPath = path.join(__dirname, '../src/locked-migration-plugin.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8'), helperSource = fs.readFileSync(helperPath, 'utf8');
const host = createRequire(mainPath);
function evaluate(source, filename, injected) {
  const context = vm.createContext({ module: { exports: {} }, require: id => injected[id] || host(id),
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams,
    structuredClone, btoa, atob, setTimeout, clearTimeout, console });
  vm.runInContext(source, context, { filename }); return context.module.exports;
}
async function fixture(options = {}) {
  const f = options.remote || await lockFixture(), local = new Map([[`amygdala-team-scope-${f.rootId}`, 'Shared']]);
  const files = options.files || new Map(), directories = new Set(), state = { saves: [], saved: copy(options.saved || {}),
    boundaries: [], labels: [], sync: 0, requests: 0, auth: 0, settings: [], storeCalls: 0 };
  let plugin, phase = 'prepare';
  const hit = async label => { state.boundaries.push(`${phase}:${label}`); await options.boundary?.(plugin, label, phase, state, f); };
  class Setting {
    constructor() { this.row = {}; state.settings.push(this.row); }
    setName(value) { this.row.name = value; return this; } setDesc(value) { this.row.desc = value; return this; }
    addButton(callback) {
      const b = { setButtonText: v => { this.row.buttonText = v; return b; }, setDisabled: v => { this.row.disabled = v; return b; },
        onClick: fn => { this.row.click = fn; return b; } }; callback(b); return this;
    }
    addToggle(callback) {
      const t = { setValue: v => { this.row.value = v; return t; }, onChange: fn => { this.row.change = fn; return t; } }; callback(t); return this;
    }
  }
  const obsidian = { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {}, Setting,
    Notice: class { constructor(text) { state.labels.push(text); } }, requestUrl: async () => { state.requests++; throw new Error('Real Google forbidden'); } };
  const helperDeps = {};
  for (const id of ['./locked-migration.cjs', './google-locked-migration.cjs', './locked-migration-snapshot.cjs',
    './legacy-migration-remote-preview.cjs', './verified-backup.cjs', './backup-reader-verification.cjs', './slot-fence.cjs']) {
    helperDeps[id] = Object.fromEntries(Object.entries(host(id)).map(([name, value]) => [name,
      typeof value === 'function' && ['prepareLockedMigration', 'validateLockedPlan', 'executeSlotLocks', 'prepareSlotActivation',
        'executeSlotActivation', 'probeGoogleLockAtomicity', 'readLockedMigrationSnapshot', 'readOnlyMigrationSnapshot',
        'buildVerifiedBackup', 'encodeBackup', 'decodeBackup', 'verifyBackupWithReader', 'fenceDigest'].includes(name)
        ? async (...args) => { const result = await value(...args); await hit(name); return result; } : value]));
  }
  const helper = evaluate(helperSource, helperPath, helperDeps);
  const Store = class { constructor() {
    const store = options.storeFactory ? options.storeFactory(plugin, f) : f.make();
    for (const name of ['call', 'batch', 'manifestFor', 'spreadsheet', 'file', 'values', 'verifiedSlots', 'assertAccess', 'listEvents']) {
      const original = store[name].bind(store);
      store[name] = async (...args) => {
        if (name === 'batch') {
          const saved = state.saved.lockedMigrationPreparations?.[f.rootId];
          assert.equal(saved.attempted, true, 'attempted plan must be durable before any remote batch');
          const activation = args[1].some(req => req.addNamedRange?.namedRange?.name === 'AMYGDALA_ACTIVE_V2');
          if (activation) assert.equal(saved.activationAttempted, true);
          else if (args[1].some(req => req.addNamedRange?.namedRange?.name === 'AMYGDALA_LOCK_V2'))
            assert.ok(saved.atomicFenceProof, 'atomic rejection proof must be durable before locks');
          await hit('before-batch');
        }
        state.storeCalls++;
        const result = name === 'values' && args[1] === 'TeamPlugins!A2:C'
          ? { values: (await original(args[0], 'TeamPlugins!A1:C')).values.slice(1) } : await original(...args);
        await hit(`store:${name}`); return result;
      };
    }
    return store;
  } };
  const Main = evaluate(mainSource, mainPath, { obsidian, './locked-migration-plugin.cjs': helper,
    './team-sharded-store.cjs': { TeamShardedStore: Store } });
  plugin = new Main();
  Object.assign(plugin, { stopped: false, running: false, device: `fixture_${globalThis.crypto.randomUUID()}`, prefs: { auto: false },
    pluginData: copy(options.saved || {}), authHealth: {}, progressListeners: new Set(), diagnosticWrite: Promise.resolve(),
    connection: { id: f.rootId, kind: 'team', version: 4 }, autoSyncGeneration: 0,
    v4Auth: { accessToken: async () => { state.auth++; throw new Error('Real authorization forbidden'); } },
    saveData: async data => { await hit('saveData'); if (options.failSave?.(data, phase)) throw new Error('Synthetic save failure');
      state.saved = copy(data); state.saves.push(copy(data)); },
    drive: () => { state.sync++; throw new Error('Sync forbidden'); }, report: error => { throw error; } });
  plugin.app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    vault: { getAbstractFileByPath: name => ({ path: name, children: [] }), adapter: {
      exists: async name => { const value = files.has(name) || directories.has(name); await hit('exists'); return value; },
      mkdir: async name => { directories.add(name); await hit('mkdir'); },
      writeBinary: async (name, bytes) => { files.set(name, new Uint8Array(bytes).slice()); await hit('writeBinary'); },
      readBinary: async name => { const bytes = files.get(name); if (!bytes) throw new Error('Missing fixture backup'); await hit('readBinary'); return bytes.slice().buffer; }
    } } };
  if (options.saved) plugin.restorePreparedMigrationCandidate();
  const approve = () => { plugin.migrationAllParticipantsPaused = true;
    plugin.migrationWriteApprovedFingerprint = plugin.lastMigrationPreview.snapshotFingerprint; };
  const prepare = async () => { phase = 'prepare'; return plugin.prepareTeamMigration(); };
  const apply = async () => { phase = plugin.preparedTeamMigration()?.stage === 'final-ready' ? 'activate' : 'lock'; return plugin.applyTeamMigration(); };
  return { plugin, state, f, files, local, prepare, apply, approve, setPhase: value => { phase = value; } };
}

test('synthetic main UI executes two separate stages with real backup-reader proofs and no automatic sync', async () => {
  const f = await fixture(), prepared = await f.prepare(); assert.ok(prepared);
  assert.equal(prepared.proof.verification, 'isolated-production-reader');
  assert.equal(f.state.storeCalls > 0, true); assert.equal(f.f.lockBatches.length, 0);
  assert.equal(f.plugin.canApplyTeamMigration(), false); f.approve();
  const first = await f.apply(); assert.equal(first.state, 'final-ready'); assert.equal(f.f.lockBatches.length, 9);
  const saved = f.plugin.preparedTeamMigration(); assert.equal(saved.finalProof.migrationStage, 'locked');
  assert.notEqual(saved.activation.sourceFingerprint, saved.plan.sourceFingerprint);
  assert.equal(f.plugin.migrationWriteApprovedFingerprint, null); assert.equal(f.plugin.migrationAllParticipantsPaused, false);
  assert.equal(f.plugin.canApplyTeamMigration(), false);
  f.plugin.migrationWriteApprovedFingerprint = prepared.plan.sourceFingerprint; f.plugin.migrationAllParticipantsPaused = true;
  assert.equal(f.plugin.canApplyTeamMigration(), false); f.approve();
  const second = await f.apply(); assert.ok(second, f.plugin.label); assert.equal(second.state, 'complete'); assert.equal(f.f.lockBatches.length, 10);
  assert.equal(f.plugin.prefs.auto, false); assert.equal(f.state.sync + f.state.auth + f.state.requests, 0);
  assert.equal(f.plugin.preparedTeamMigration().completed, true);
  assert.equal(f.plugin.canApplyTeamMigration(), false);
});

test('saved source and final stages restore after restart but never inherit consent', async () => {
  const first = await fixture(); await first.prepare();
  let next = await fixture({ remote: first.f, files: first.files, saved: first.state.saved });
  assert.equal(next.plugin.preparedTeamMigration().stage, 'source-ready'); assert.equal(next.plugin.canApplyTeamMigration(), false);
  assert.equal(next.plugin.migrationAllParticipantsPaused, false); next.approve(); assert.equal((await next.apply()).state, 'final-ready');
  next = await fixture({ remote: first.f, files: first.files, saved: next.state.saved });
  assert.equal(next.plugin.preparedTeamMigration().stage, 'final-ready'); assert.equal(next.plugin.migrationWriteApprovedFingerprint, null);
  next.approve(); const result = await next.apply(); assert.ok(result, next.plugin.label); assert.equal(result.state, 'complete');
});

test('partial locks resume the same immutable plan with saved atomic proof and no replacement source snapshot', async () => {
  const first = await fixture({ boundary: (_p, name, phase, _state, remote) => {
    if (phase === 'lock' && remote.lockBatches.length === 3 && name.startsWith('store:'))
      throw new Error('Synthetic process interruption');
  } });
  await first.prepare(); const original = copy(first.plugin.preparedTeamMigration().plan); first.approve();
  assert.equal(await first.apply(), null); assert.equal(first.f.lockBatches.length, 3);
  assert.equal(first.plugin.canPrepareTeamMigration(), false);
  const next = await fixture({ remote: first.f, files: first.files, saved: first.state.saved });
  assert.equal(next.plugin.canApplyTeamMigration(), false); next.approve(); assert.equal((await next.apply()).state, 'final-ready');
  assert.deepEqual(next.plugin.preparedTeamMigration().plan, original); assert.equal(next.f.lockBatches.length, 9);
  assert.equal(next.state.boundaries.some(label => label.endsWith(':readOnlyMigrationSnapshot')), false);
  assert.equal(next.state.boundaries.some(label => label.endsWith(':probeGoogleLockAtomicity')), false);
});

test('corrupt source backup, stale proof, plan tampering, wrong scope, root, queue, and exact consent fail before writes', async () => {
  const remote = await lockFixture();
  for (const mutate of [
    f => { f.files.set(f.plugin.preparedTeamMigration().backupPath, new Uint8Array([1])); },
    f => { const s = f.plugin.preparedTeamMigration(); s.proof = { ...s.proof, recordCount: s.proof.recordCount + 1 }; },
    f => { const s = f.plugin.preparedTeamMigration(); s.plan = copy(s.plan); s.plan.report.revisionCount++; },
    f => { f.local.set(f.plugin.teamScopeKey(), 'Other'); },
    f => { f.plugin.connection.id = 'other_root_1234'; },
    f => { f.plugin.pluginData.v4ScopedOperations = { [remote.rootId]: { pending: {} } }; },
    f => { f.plugin.pluginData.v4Operations = { [remote.rootId]: { pending: {} } }; },
    f => { f.plugin.pluginData.v4Operations = { old_pending: { opId: 'old_pending' } }; },
    f => { f.plugin.migrationWriteApprovedFingerprint = 'wrong'; },
    f => { f.plugin.migrationAllParticipantsPaused = false; }
  ]) {
    const f = await fixture({ remote }); await f.prepare(); f.approve(); mutate(f);
    try { assert.equal(await f.apply(), null); } catch (error) { assert.match(error.message, /Миграция недоступна/); }
    assert.equal(remote.lockBatches.length, 0); assert.equal(remote.getLockAttempts(), 0);
  }
});

test('save failures before probe, lock proof, and activation prevent the corresponding writes', async () => {
  for (const step of ['attempted', 'proof', 'activation']) {
    const f = await fixture({ failSave: (data, phase) => {
      const saved = data.lockedMigrationPreparations?.[f.f.rootId];
      return step === 'attempted' ? phase === 'lock' && saved.attempted && !saved.atomicFenceProof
        : step === 'proof' ? phase === 'lock' && Boolean(saved.atomicFenceProof) : phase === 'activate' && saved.activationAttempted;
    } });
    await f.prepare(); f.approve(); const first = await f.apply();
    if (step === 'activation') { assert.equal(first.state, 'final-ready'); f.approve(); assert.equal(await f.apply(), null);
      assert.equal(f.f.lockBatches.length, 9); assert.equal(f.plugin.preparedTeamMigration().activationAttempted, undefined); }
    else { assert.equal(first, null); assert.equal(f.f.lockBatches.length, 0);
      assert.equal(f.f.getLockAttempts(), step === 'proof' ? 1 : 0);
      assert.equal(f.plugin.preparedTeamMigration().atomicFenceProof, undefined); }
  }
});

test('corrupt final backup and stale final proof reject activation without a new remote batch', async () => {
  for (const corrupt of [true, false]) {
    const f = await fixture(); await f.prepare(); f.approve(); await f.apply();
    const saved = f.plugin.preparedTeamMigration();
    if (corrupt) f.files.set(saved.finalBackupPath, new Uint8Array([1])); else saved.finalProof = { ...saved.finalProof, slotLockId: 'stale' };
    const attempts = f.f.getLockAttempts(); f.approve(); assert.equal(await f.apply(), null);
    assert.equal(f.f.lockBatches.length, 9); assert.equal(f.f.getLockAttempts(), attempts);
  }
});

test('committed activation with failed completion save resumes idempotently with the exact saved final plan', async () => {
  const first = await fixture({ failSave: (data, phase) => phase === 'activate'
    && data.lockedMigrationPreparations?.[first.f.rootId]?.completed === true });
  await first.prepare(); first.approve(); await first.apply();
  const activation = copy(first.plugin.preparedTeamMigration().activation);
  first.approve(); assert.equal(await first.apply(), null); assert.equal(first.f.lockBatches.length, 10);
  const next = await fixture({ remote: first.f, files: first.files, saved: first.state.saved });
  assert.equal(next.plugin.preparedTeamMigration().stage, 'final-ready'); assert.equal(next.plugin.canApplyTeamMigration(), false);
  next.approve(); const resumed = await next.apply(); assert.ok(resumed, next.plugin.label);
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.writes, 0); assert.equal(next.f.lockBatches.length, 10);
  assert.deepEqual(next.plugin.preparedTeamMigration().activation, activation);
  assert.equal(next.state.boundaries.some(label => /readOnlyMigrationSnapshot|readLockedMigrationSnapshot/.test(label)), false);
});

test('connection, queue, pause and consent changes during awaited backup validation prevent every remote batch', async () => {
  for (const change of [p => { p.connection = { ...p.connection }; }, p => { p.connection.name = 'changed'; },
    p => { p.pluginData.v4Operations = { pending: {} }; }, p => { p.prefs.auto = true; },
    p => { p.migrationAllParticipantsPaused = false; }, p => { p.migrationWriteApprovedFingerprint = 'wrong'; },
    p => { p.stopped = true; }]) {
    let changed = false;
    const f = await fixture({ boundary: (plugin, name, phase) => {
      if (!changed && phase === 'lock' && name === 'verifyBackupWithReader') { changed = true; change(plugin); }
    } });
    await f.prepare(); f.approve(); assert.equal(await f.apply(), null);
    assert.equal(f.f.getLockAttempts(), 0); assert.equal(f.plugin.canApplyTeamMigration(), false);
  }
});

test('applying migration blocks sync, preview, scope and automatic changes until the guarded await returns', async () => {
  let release, enter;
  const ready = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ boundary: async (_p, name, phase) => { if (phase === 'lock' && name === 'verifyBackupWithReader') { enter(); await gate; } } });
  await f.prepare(); f.approve(); const pending = f.apply(); await ready;
  await f.plugin.sync(true); await f.plugin.sync(false);
  await assert.rejects(f.plugin.setTeamScopeFolder('Other'), /текущей операции/);
  await assert.rejects(f.plugin.setAutomaticSync(false), /окончания миграции/);
  await assert.rejects(f.plugin.previewTeamMigration(), /завершите операции/);
  assert.equal(f.state.sync + f.state.auth + f.state.requests, 0);
  release(); assert.equal((await pending).state, 'final-ready');
});

test('production request boundaries stop before a request when token or limiter awaits invalidate the scope', async () => {
  for (const boundary of ['token', 'limiter']) {
    let requests = 0;
    const f = await fixture({ storeFactory: (plugin, remote) => {
      const { TeamShardedStore } = host('./team-sharded-store.cjs');
      return new TeamShardedStore({ rootId: remote.rootId,
        getAccessToken: async () => { if (boundary === 'token') plugin.autoSyncGeneration++; return 'synthetic-token'; },
        limiter: { acquire: async () => { if (boundary === 'limiter') plugin.autoSyncGeneration++; } },
        sleep: async () => {}, request: async () => { requests++; throw new Error('No real request permitted'); } });
    } });
    assert.equal(await f.prepare(), null); assert.equal(requests, 0); assert.equal(f.files.size, 0);
  }
});

test('read-only preview displays exact scope, quarantine and fingerprint without offering write consent', async () => {
  const f = await fixture(), preview = await f.plugin.previewTeamMigration(), paragraphs = [];
  assert.ok(preview.stableSnapshot);
  f.plugin.renderMigrationPreparation({ createEl: (_tag, props) => paragraphs.push(props.text) }, () => {});
  assert.ok(paragraphs.some(text => text.includes(preview.snapshotFingerprint) && text.includes(preview.localScope)));
  assert.ok(paragraphs.some(text => text.includes(`в карантине: ${preview.quarantinedRevisionCount}`)));
  assert.equal(f.state.settings.some(row => /Разрешить/.test(row.name)), false);
  assert.equal(f.plugin.preparedTeamMigration(), null);
  assert.equal(f.plugin.canApplyTeamMigration(), false);
  assert.equal(f.f.getLockAttempts(), 0);
});

test('shared Russian controls describe consequential first stage and separate final SHA-256 consent', async () => {
  const f = await fixture(); await f.prepare(); const paragraphs = [];
  const el = { createEl: (_tag, props) => paragraphs.push(props.text) };
  f.plugin.renderMigrationPreparation(el, () => {});
  assert.ok(f.state.settings.some(row => /необратимо остановить/.test(row.desc || '')));
  assert.ok(f.state.settings.some(row => row.buttonText === 'Остановить старые записи'));
  f.approve(); await f.apply(); f.state.settings.length = 0; f.plugin.renderMigrationPreparation(el, () => {});
  assert.ok(f.state.settings.some(row => /Отдельное согласие для нового SHA-256/.test(row.desc || '')));
  assert.ok(f.state.settings.some(row => row.buttonText === 'Активировать проект'));
  assert.ok(paragraphs.some(text => text.includes('SHA-256 итогового снимка')));
});

test('pending legacy operations block preparation before any snapshot reads', async () => {
  for (const legacy of [{ old_pending: { opId: 'old_pending' } }, { root_12345678: { pending: {} } },
    { old_pending: { rootId: 'root_12345678', opId: 'old_pending' } }]) {
    const f = await fixture(); f.plugin.pluginData.v4Operations = legacy;
    await assert.rejects(f.prepare(), /ожидающие операции/); assert.equal(f.state.storeCalls, 0);
  }
});

test('all orchestration await types stop subsequent writes on scope or generation changes', async () => {
  const baseline = await fixture(); await baseline.prepare();
  const sourceData = copy(baseline.state.saved), sourceFiles = new Map([...baseline.files].map(([name, bytes]) => [name, bytes.slice()]));
  baseline.approve(); await baseline.apply();
  const finalData = copy(baseline.state.saved), finalFiles = new Map([...baseline.files].map(([name, bytes]) => [name, bytes.slice()]));
  baseline.approve(); await baseline.apply();
  const targets = [...new Set(baseline.state.boundaries)].filter(label => !label.endsWith(':before-batch'));
  // Each await family is exercised at its first occurrence in each orchestration stage.
  // Repeated table/slot reads share the same guarded wrapper.
  for (const change of ['scope', 'generation']) for (const target of targets) {
    const phase = target.slice(0, target.indexOf(':')), label = target.slice(target.indexOf(':') + 1);
    const remote = await lockFixture();
    // New synthetic projects have identical source bytes and IDs. Use the saved plan unchanged.
    if (phase === 'activate') {
      const { executeSlotLocks } = host('./locked-migration.cjs');
      const { initialApproval } = require('../test-support/slot-lock-fixture.cjs');
      // Bind locks to the saved plan's backup identity rather than this fixture's capture time.
      remote.plan = copy(sourceData.lockedMigrationPreparations[remote.rootId].plan);
      const { createGoogleLockAdapter } = host('./google-locked-migration.cjs');
      remote.adapter = createGoogleLockAdapter({ store: remote.store, plan: remote.plan });
      await executeSlotLocks(initialApproval(remote));
    }
    let invalidated = false, attemptsAtChange, filesAtChange;
    const f = await fixture({ remote, saved: phase === 'prepare' ? undefined : phase === 'lock' ? sourceData : finalData,
      files: phase === 'prepare' ? undefined : new Map([...(phase === 'lock' ? sourceFiles : finalFiles)].map(([name, bytes]) => [name, bytes.slice()])),
      boundary: (plugin, name, currentPhase, _state, source) => {
        if (!invalidated && currentPhase === phase && name === label) {
          invalidated = true; attemptsAtChange = source.getLockAttempts(); filesAtChange = f.files.size;
          if (change === 'generation') plugin.autoSyncGeneration++; else f.local.set(plugin.teamScopeKey(), 'Other');
        }
      } });
    if (phase === 'prepare') assert.equal(await f.prepare(), null, target);
    else { f.approve(); assert.equal(await f.apply(), null, target); }
    assert.equal(invalidated, true, `${change}:${target}`);
    assert.equal(remote.getLockAttempts(), attemptsAtChange, `No later batch after ${change}:${target}`);
    assert.equal(f.files.size, filesAtChange, `No later backup after ${change}:${target}`);
    assert.equal(f.plugin.migrationWriteApprovedFingerprint, null);
    assert.equal(f.plugin.canApplyTeamMigration(), false);
  }
});
