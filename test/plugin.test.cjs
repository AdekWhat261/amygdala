'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('built plugin loads with public Obsidian API and remains offline until configured', async () => {
  let requests = 0;
  let mockRequest = null;
  const local = new Map(), secrets = new Map(), commands = [];
  const element = () => ({ text: '', setText(t) { this.text = t; }, addClass() {}, addEventListener() {} });
  class Plugin {
    addRibbonIcon() {} addStatusBarItem() { return element(); }
    addCommand(command) { commands.push(command.id); } addSettingTab() {}
    registerInterval() {} registerObsidianProtocolHandler() {}
  }
  const obsidian = { Plugin, FuzzySuggestModal: class {}, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, requestUrl: async req => { requests++; if (mockRequest) return mockRequest(req); throw new Error('Unexpected network'); } };
  const context = vm.createContext({ module: { exports: {} }, require: id => { assert.equal(id, 'obsidian'); return obsidian; },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams, btoa, setTimeout, clearTimeout,
    window: { setInterval() { return 1; } }, console });
  const source = fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8');
  vm.runInContext(source, context);
  const instance = new context.module.exports();
  let driveConstructionCalls = 0;
  instance.drive = () => { driveConstructionCalls++; throw new Error('Team project without an explicit local folder must fail closed'); };
  instance.app = { loadLocalStorage: k => local.get(k), saveLocalStorage: (k,v) => local.set(k,v),
    secretStorage: { getSecret: k => secrets.get(k), setSecret: (k,v) => secrets.set(k,v) },
    workspace: { onLayoutReady: fn => fn() } };
  local.set('amygdala-connection-connection', { kind: 'team', id: 'legacy-project-test' });
  local.set('amygdala-connection-preferences', { auto: true });
  await instance.onload();
  assert.equal(requests, 0);
  assert.equal(driveConstructionCalls, 0, 'automatic startup must stop before contacting the saved team project without a scoped folder');
  assert.match(instance.label, /Перед синхронизацией выберите локальную папку этого командного проекта/);
  assert.equal(instance.googleConnectionStatus().state, 'missing');
  assert.match(instance.googleConnectionStatus().text, /Командный проект v3 подключён/);
  instance.connection = { kind: 'team', version: 4, id: 'v4-project-test' };
  secrets.set(`amygdala-connection-team-v4-${instance.device}`, 'test-only-refresh-placeholder');
  assert.equal(instance.googleConnectionStatus().state, 'unverified', 'saved v4 project and credential are not proof of current access');
  instance.recordGoogleAccessVerified();
  assert.equal(instance.googleConnectionStatus().state, 'verified');
  instance.recordGoogleAuthRejected({ status: 401 });
  assert.equal(instance.googleConnectionStatus().state, 'rejected');
  instance.connection = null;
  assert.equal(instance.googleConnectionStatus().state, 'no-project');
  assert.equal(requests, 0, 'status classification must not call Google or OAuth');
  const sourceText = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(sourceText, /Проверить доступ/);
  instance.connection = { kind: 'team', version: 4, id: 'v4-project-test' };
  secrets.set(`amygdala-connection-team-v4-${instance.device}`, 'test-only-refresh-placeholder');
  instance.v4Auth = { accessToken: async () => 'fixture-only-token' };
  let syncCalls = 0;
  const pluginSync = instance.sync.bind(instance);
  instance.sync = async () => { syncCalls++; throw new Error('access check must not sync'); };
  mockRequest = async req => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, 'https://sheets.googleapis.com/v4/spreadsheets/v4-project-test?fields=spreadsheetId');
    assert.equal(req.body, undefined);
    assert.equal(req.headers.Authorization, 'Bearer fixture-only-token');
    assert.equal(Object.keys(req.headers).length, 1);
    return { status: 200, json: { spreadsheetId: 'v4-project-test' } };
  };
  assert.equal(await instance.checkGoogleAccess(), true, `unexpected access-check result: ${instance.label}`);
  assert.equal(syncCalls, 0);
  assert.equal(requests, 1);
  assert.equal(instance.googleConnectionStatus().state, 'verified');
  assert.match(instance.googleConnectionStatus().text, /сведений основной таблицы; синхронизация не запускалась/);
  instance.sync = pluginSync;
  instance.migrationApplying = true;
  await instance.sync(true);
  assert.equal(requests, 1, 'local sync must not start while the migration gate is held');
  instance.migrationApplying = false;
  instance.migrationPreparing = true;
  await instance.sync(true);
  await instance.sync(false);
  assert.equal(requests, 1, 'manual and automatic sync must not start while local backup preparation is active');
  instance.migrationPreparing = false;
  instance.prefs.auto = false;
  instance.teamScopePath = () => 'Pilot/Arbitrary Shared Folder';
  instance.lastMigrationPreview = { sourceSchema: 2, targetSchema: 3, stableSnapshot: true, migrationState: 'source',
    localScope: 'Pilot/Arbitrary Shared Folder', revisionCount: 378, quarantinedRevisionCount: 28, activeLegacyRevisionCount: 350,
    includedCurrentPathCount: 350, quarantinedCurrentPathCount: 28, remoteWrites: 0,
    pathCounts: { 'inside-selected-folder': 350, 'outside-selected-folder': 28, 'case-ambiguous': 0 },
    snapshotFingerprint: 'b'.repeat(64), eventFingerprint: 'a'.repeat(64) };
  assert.equal(instance.canApplyTeamMigration(), false, 'migration remains locked until all participant sync is attested paused');
  instance.migrationAllParticipantsPaused = true;
  instance.migrationWriteApprovedFingerprint = null;
  assert.equal(instance.canApplyTeamMigration(), false, 'participant pause alone is not migration approval');
  instance.migrationWriteApprovedFingerprint = instance.lastMigrationPreview.snapshotFingerprint;
  assert.equal(instance.matchesApprovedMigrationPreview(), true, 'the arbitrary-scope exact-preview review remains available');
  assert.equal(instance.canApplyTeamMigration(), false, 'exact approval and pause still require a prepared plan and verified saved backup');
  const requestsBeforeMigration = requests;
  const driveCallsBeforeMigration = driveConstructionCalls;
  await assert.rejects(instance.applyTeamMigration(), /новый механизм.*ещё не подключён/);
  assert.equal(requests, requestsBeforeMigration, 'blocked Apply must not contact Google');
  assert.equal(driveConstructionCalls, driveCallsBeforeMigration);
  assert.equal(instance.migrationApplying, false);
  instance.lastMigrationPreview.migrationState = 'partial';
  instance.approvedMigrationEventFingerprint = instance.lastMigrationPreview.eventFingerprint;
  assert.equal(instance.matchesApprovedMigrationPreview(), true);
  assert.equal(instance.canApplyTeamMigration(), false, 'resume requires the original saved prepared plan');
  await assert.rejects(instance.applyTeamMigration(), /новый механизм.*ещё не подключён/);
  assert.equal(requests, requestsBeforeMigration);
  instance.lastMigrationPreview.snapshotFingerprint = 'c'.repeat(64);
  assert.equal(instance.canApplyTeamMigration(), false, 'approval for one exact fingerprint cannot authorize another');
  assert.deepEqual(commands.sort(), ['choose-default-new-note-folder', 'connect', 'link-personal-note', 'rebind-personal-note-link', 'resolve-conflicts', 'sync-now']);
  instance.onunload();
  assert.equal(instance.stopped, true);
});

test('mobile startup and project selection stay offline until explicit validated automatic sync', async () => {
  let requests = 0, statusCalls = 0, syncCalls = 0;
  const local = new Map();
  class Plugin {
    addRibbonIcon() {} addStatusBarItem() { statusCalls++; throw new Error('No mobile status bar'); }
    addCommand() {} addSettingTab() {} registerInterval() {} registerObsidianProtocolHandler() {}
  }
  const obsidian = { Plugin, Platform: { isMobile: true }, FuzzySuggestModal: class {}, Modal: class {},
    PluginSettingTab: class {}, Setting: class {}, Notice: class {},
    requestUrl: async () => { requests++; throw new Error('Unexpected network'); } };
  const context = vm.createContext({ module: { exports: {} }, require: () => obsidian,
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams,
    btoa, setTimeout, clearTimeout, window: { setInterval() { return 1; } }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8'), context);
  const p = new context.module.exports();
  p.app = { loadLocalStorage: key => local.get(key), saveLocalStorage: (key, value) => local.set(key, value),
    secretStorage: { getSecret: () => null, setSecret() {} }, workspace: { onLayoutReady: fn => fn() } };
  await p.onload();
  assert.equal(p.prefs.auto, false);
  assert.equal(statusCalls, 0);
  p.sync = async () => { syncCalls++; };
  p.prefs.auto = true;
  await p.selectVault({ kind: 'team', version: 4, id: 'fixture-project', name: 'fixture' });
  assert.equal(syncCalls, 0, 'linking must not upload or download notes implicitly');
  assert.equal(p.prefs.auto, false);
  assert.equal(local.get('amygdala-connection-preferences').auto, false);
  p.teamScopePath = () => null;
  await assert.rejects(p.setAutomaticSync(true), /локальную папку/);
  p.teamScopePath = () => 'Shared';
  let validations = 0;
  p.drive = () => ({ teamInfo: async () => { validations++; return { pathProtocol: undefined }; } });
  await assert.rejects(p.setAutomaticSync(true), /миграцию/);
  assert.equal(p.prefs.auto, false);
  p.drive = () => ({ teamInfo: async () => { validations++; return {
    pathProtocol: 'project-relative-v1', namespace: 'fixture-project' }; } });
  assert.equal(await p.setAutomaticSync(true), true);
  assert.equal(validations, 2);
  assert.equal(syncCalls, 0, 'enabling performs project validation only');
  assert.equal(await p.setAutomaticSync(false), false);
  let finishValidation;
  p.drive = () => ({ teamInfo: () => new Promise(resolve => { finishValidation = resolve; }) });
  const enabling = p.setAutomaticSync(true);
  await p.setAutomaticSync(false);
  finishValidation({ pathProtocol: 'project-relative-v1', namespace: 'fixture-project' });
  assert.equal(await enabling, false, 'late validation must not override a newer pause');
  assert.equal(p.prefs.auto, false);
  p.app.vault = { getAbstractFileByPath: path => ({ path, children: [] }) };
  p.prefs.auto = true;
  p.lastMigrationPreview = { snapshotFingerprint: 'a'.repeat(64) };
  p.migrationWriteApprovedFingerprint = 'a'.repeat(64);
  p.migrationAllParticipantsPaused = true;
  await p.setTeamScopeFolder('Other Shared');
  assert.equal(p.prefs.auto, false, 'changing local scope requires fresh project validation');
  assert.equal(local.get('amygdala-connection-preferences').auto, false);
  assert.equal(p.lastMigrationPreview, null, 'old scope cannot retain migration approval');
  assert.equal(p.migrationWriteApprovedFingerprint, null);
  p.migrationPreviewing = true;
  await assert.rejects(p.setTeamScopeFolder('Third Shared'), /текущей операции/);
  assert.equal(local.get(p.teamScopeKey()), 'Other Shared', 'in-flight preview must retain its selected scope');
  p.migrationPreviewing = false;
  assert.equal(requests, 0);
});
