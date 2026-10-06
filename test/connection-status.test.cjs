'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VERIFIED_WINDOW_MS, connectionStatus } = require('../src/connection-status.cjs');

test('v3 linked project with a saved credential remains unverified until a successful Google request', () => {
  const status = connectionStatus({ connection: { kind: 'team', version: 3 }, credentialPresent: true });
  assert.equal(status.state, 'unverified');
  assert.match(status.text, /Командный проект v3 подключён/);
  assert.match(status.text, /ещё не проверен/);
});

test('v4 linked project identity alone never claims authenticated access', () => {
  const status = connectionStatus({ connection: { kind: 'team', version: 4, name: 'Private project title' }, credentialPresent: true });
  assert.equal(status.state, 'unverified');
  assert.match(status.text, /Командный проект v4 подключён/);
  assert.doesNotMatch(status.text, /Private project title/);
  assert.doesNotMatch(status.text, /недавно проверен/);
});

test('no saved project is reported independently from account credentials', () => {
  for (const credentialPresent of [null, false, true]) {
    assert.deepEqual(connectionStatus({ connection: null, credentialPresent }), { state: 'no-project', text: 'Проект не подключён' });
  }
});

test('missing credentials and a confirmed 401 have distinct status', () => {
  const connection = { kind: 'team', version: 4 };
  assert.equal(connectionStatus({ connection, credentialPresent: false }).state, 'missing');
  const rejected = connectionStatus({ connection, credentialPresent: true, authRejected: true });
  assert.equal(rejected.state, 'rejected');
  assert.match(rejected.text, /подключитесь повторно/);
});

test('only a recent successful protected request is presented as verified', () => {
  const connection = { kind: 'team', version: 4 };
  assert.equal(connectionStatus({ connection, credentialPresent: true, verifiedAt: 1000, now: 1000 }).state, 'verified');
  assert.equal(connectionStatus({ connection, credentialPresent: true, verifiedAt: 1000, now: 1000 + VERIFIED_WINDOW_MS + 1 }).state, 'unverified');
  assert.equal(connectionStatus({ connection, credentialPresent: true, verifiedAt: 2000, now: 1000 }).state, 'unverified');
});

test('read-only metadata proof is not presented as a sync or full-project verification', () => {
  const result = connectionStatus({ connection: { kind: 'team', version: 4 }, credentialPresent: true,
    verifiedAt: 1000, verifiedKind: 'metadata', now: 1000 });
  assert.equal(result.state, 'verified');
  assert.match(result.text, /сведений основной таблицы/);
  assert.match(result.text, /синхронизация не запускалась/);
  assert.doesNotMatch(result.text, /full project|sync verified/i);
});

test('secret storage read failure does not become a false signed-in or missing claim', () => {
  assert.equal(connectionStatus({ connection: { kind: 'team', version: 3 }, credentialPresent: null }).state, 'unknown');
});
