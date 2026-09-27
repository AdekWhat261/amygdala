'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleAuth } = require('../src/auth.cjs');

const scope = 'https://www.googleapis.com/auth/drive.file';
function auth({ granted = scope, mode = 'team' } = {}) {
  let pending = { verifier: 'v'.repeat(43), state: 's'.repeat(43), created: Date.now() };
  let saved = null, exchanges = 0;
  const instance = new GoogleAuth({ bridge: 'https://bridge.example', mode, request: async request => {
    if (request.url.endsWith('/auth/exchange')) {
      exchanges++;
      return { status: 200, json: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, ...(granted === null ? {} : { scope: granted }) } };
    }
    throw new Error(`Unexpected request ${request.url}`);
  }, secrets: { get: async () => saved, set: async value => { saved = value; } },
  savePending: async value => { pending = value; }, getPending: async () => pending });
  return { instance, get pending() { return pending; }, get saved() { return saved; }, get exchanges() { return exchanges; } };
}

test('team OAuth persists a token only after drive.file is confirmed and Picker selected the store', async () => {
  const f = auth({ granted: null }); f.instance.requireTeamPicker = true;
  await assert.rejects(f.instance.complete({ code: 'one-use-code', state: 's'.repeat(43), picked_file_ids: 'spreadsheet_12345678' }), /drive\.file/);
  assert.equal(f.saved, null);
  await assert.rejects(f.instance.complete({ code: 'one-use-code', state: 's'.repeat(43), scope, picked_file_ids: '' }), /Picker/);
  assert.equal(f.saved, null);
  const result = await f.instance.complete({ code: 'one-use-code', state: 's'.repeat(43), scope, picked_file_ids: 'spreadsheet_12345678' });
  assert.equal(result.pickedSpreadsheetId, 'spreadsheet_12345678');
  assert.equal(f.saved, 'refresh');
  assert.equal(f.pending, null);
});

test('legacy broader grants are rejected by team 0.3 without replacing stored credentials', async () => {
  const f = auth({ granted: 'https://www.googleapis.com/auth/drive openid email' });
  await assert.rejects(f.instance.complete({ code: 'one-use-code', state: 's'.repeat(43) }), /drive\.file/);
  assert.equal(f.saved, null);
});

test('legacy team 0.2 keeps its existing broader grant in a separate auth format', async () => {
  const f = auth({ granted: 'https://www.googleapis.com/auth/drive openid email' });
  f.instance.teamFormat = 2;
  const result = await f.instance.complete({ code: 'one-use-code', state: 's'.repeat(43) });
  assert.equal(result.pickedSpreadsheetId, null);
  assert.equal(f.saved, 'refresh');
});
