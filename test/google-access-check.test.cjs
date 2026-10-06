'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkGoogleProjectAccess } = require('../src/google-access-check.cjs');

const connection = { kind: 'team', version: 4, id: 'root_sheet_12345678', name: 'private title' };

test('checks only linked root spreadsheet metadata with an authenticated GET', async () => {
  let calls = 0;
  const result = await checkGoogleProjectAccess({ connection, getAccessToken: async () => 'opaque-test-token',
    request: async req => {
      calls++;
      assert.equal(req.method, 'GET');
      assert.equal(req.url, 'https://sheets.googleapis.com/v4/spreadsheets/root_sheet_12345678?fields=spreadsheetId');
      assert.equal(req.headers.Authorization, 'Bearer opaque-test-token');
      assert.equal(req.body, undefined);
      assert.equal(req.throw, false);
      return { status: 200, json: { spreadsheetId: connection.id } };
    } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, readOnly: true, checked: 'linked-root-spreadsheet-metadata' });
});

test('one rejected access token can be refreshed and retried once without logging tokens', async () => {
  const seen = [];
  let refreshes = 0;
  const result = await checkGoogleProjectAccess({ connection, getAccessToken: async () => 'old-token',
    refreshAccessToken: async () => { refreshes++; return 'rotated-token'; },
    request: async req => {
      seen.push(req.headers.Authorization);
      return seen.length === 1 ? { status: 401 } : { status: 200, json: { spreadsheetId: connection.id } };
    } });
  assert.equal(refreshes, 1);
  assert.deepEqual(seen, ['Bearer old-token', 'Bearer rotated-token']);
  assert.equal(result.ok, true);
});

test('403 and 404 remain access failures and never trigger refresh', async () => {
  for (const status of [403, 404]) {
    let refreshes = 0;
    await assert.rejects(checkGoogleProjectAccess({ connection, getAccessToken: async () => 'token',
      refreshAccessToken: async () => { refreshes++; return 'new-token'; },
      request: async () => ({ status }) }), error => error.status === status && !/token|private title|root_sheet_/.test(error.message));
    assert.equal(refreshes, 0);
  }
});

test('401 after one refresh is surfaced without provider response content', async () => {
  let calls = 0;
  await assert.rejects(checkGoogleProjectAccess({ connection, getAccessToken: async () => 'token',
    refreshAccessToken: async () => 'refreshed',
    request: async () => { calls++; return { status: 401, text: 'SECRET BODY' }; } }),
  error => error.status === 401 && !error.message.includes('SECRET BODY'));
  assert.equal(calls, 2);
});

test('invalid connection cannot make requests or fetch a credential', async () => {
  let requests = 0, credentials = 0;
  await assert.rejects(checkGoogleProjectAccess({ connection: { kind: 'team', version: 2, id: '../private' },
    getAccessToken: async () => { credentials++; return 'token'; }, request: async () => { requests++; } }));
  assert.equal(credentials, 0);
  assert.equal(requests, 0);
});

test('wrong root identity is rejected without disclosing the returned id', async () => {
  await assert.rejects(checkGoogleProjectAccess({ connection, getAccessToken: async () => 'token',
    request: async () => ({ status: 200, json: { spreadsheetId: 'different-private-id' } }) }),
  error => !error.message.includes('different-private-id'));
});
