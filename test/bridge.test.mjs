import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../test-fixtures/public-v0.3.0-bridge/worker.mjs';
const state = 's'.repeat(43), verifier = 'v'.repeat(43);
const config = { clientId: 'client', clientSecret: 'SECRET', redirectUri: 'https://bridge.example/oauth/callback' };
const post = (path, data, headers = {}) => new Request(`https://bridge.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('personal start keeps appdata scope and PKCE; never reveals secret', async () => {
  const r = await createHandler(config)(post('/auth/start', { challenge: verifier, state, redirectUri: 'https://evil.example' }));
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.text(); assert.ok(!body.includes('SECRET'));
  const url = new URL(JSON.parse(body).url);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata openid email');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});
test('legacy team start stays compatible; team format 3 uses drive.file and native Picker', async () => {
  const handler = createHandler(config);
  const old = await handler(post('/auth/start', { challenge: verifier, state, mode: 'team' }));
  const oldUrl = new URL((await old.json()).url);
  assert.equal(oldUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive openid email');
  const r = await handler(post('/auth/start', { challenge: verifier, state, mode: 'team', teamFormat: 3 }));
  assert.equal(r.status, 200);
  const url = new URL((await r.json()).url);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.has('trigger_onepick'), false);
  const picked = await handler(post('/auth/start', { challenge: verifier, state, mode: 'team', teamFormat: 3, pickTeamStore: true }));
  const pickUrl = new URL((await picked.json()).url);
  assert.equal(pickUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(pickUrl.searchParams.get('trigger_onepick'), 'true');
  assert.equal(pickUrl.searchParams.has('allow_folder_selection'), false);
  assert.equal(pickUrl.searchParams.get('mimetypes'), 'application/vnd.google-apps.spreadsheet');
  assert.equal((await handler(post('/auth/start', { challenge: verifier, state, mode: 'personal', pickTeamStore: true }))).status, 400);
  assert.equal((await handler(post('/auth/start', { challenge: verifier, state, mode: 'team', pickTeamStore: true }))).status, 400);
  assert.equal((await handler(post('/auth/start', { challenge: verifier, state, mode: 'admin' }))).status, 400);
});
test('exchange and refresh use correct grants and whitelist response fields', async () => {
  const requests = [];
  const handler = createHandler({ ...config, fetchImpl: async (url, options) => { requests.push({ url, params: new URLSearchParams(options.body) }); return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file', id_token: 'private', unexpected: 'SECRET' }); } });
  let r = await handler(post('/auth/exchange', { code: 'code', verifier, state }));
  assert.deepEqual(await r.json(), { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' });
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].params.get('grant_type'), 'authorization_code');
  assert.equal(requests[0].params.get('code_verifier'), verifier);
  assert.equal(requests[0].params.get('client_secret'), 'SECRET');
  r = await handler(post('/auth/refresh', { refreshToken: 'refresh' }));
  assert.equal(r.status, 200);
  assert.equal(requests[1].params.get('grant_type'), 'refresh_token');
  assert.equal(requests[1].params.get('refresh_token'), 'refresh');
});
test('callback safely encodes code, state, Picker file and granted scope without token exchange', async () => {
  const handler = createHandler({ ...config, fetchImpl: () => { throw new Error('must not fetch'); } });
  const r = await handler(new Request(`https://bridge.example/oauth/callback?${new URLSearchParams({ code: '\"><script>alert(1)</script>', state, picked_file_ids: 'spreadsheetId_12345', scope: 'https://www.googleapis.com/auth/drive.file' })}`));
  assert.equal(r.status, 200); const html = await r.text();
  assert.ok(html.includes('obsidian://amygdala-connection-oauth?')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&amp;state=')); assert.ok(html.includes('&amp;picked_file_ids=spreadsheetId_12345')); assert.ok(html.includes('&amp;scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file'));
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'none'"));
  const invalid = await handler(new Request(`https://bridge.example/oauth/callback?${new URLSearchParams({ code: 'code', state, picked_file_ids: 'one,two' })}`));
  assert.equal(invalid.status, 400);
  const invalidScope = await handler(new Request(`https://bridge.example/oauth/callback?${new URLSearchParams({ code: 'code', state, scope: 'bad\nscope' })}`));
  assert.equal(invalidScope.status, 400);
});
test('rejects invalid inputs, methods, origins, oversized body and unsafe config', async () => {
  const handler = createHandler({ ...config, allowedOrigin: 'app://obsidian.md' });
  assert.equal((await handler(post('/auth/exchange', { code: 'x', verifier: 'short' }))).status, 400);
  assert.equal((await handler(post('/auth/start', { challenge: verifier, state: 'short' }))).status, 400);
  assert.equal((await handler(post('/auth/start', { challenge: verifier, state }, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(post('/auth/refresh', { refreshToken: 'a'.repeat(20000) }))).status, 413);
  assert.equal((await handler(new Request('https://bridge.example/auth/start'))).status, 405);
  assert.deepEqual(await (await createHandler({ ...config, redirectUri: 'http://unsafe.example/oauth/callback' })(new Request('https://bridge.example/health'))).json(), { configured: false });
});
test('provider and transport errors are sanitized', async () => {
  for (const fetchImpl of [async () => Response.json({ error_description: 'SECRET code refresh' }, { status: 400 }), async () => { throw new Error('SECRET'); }]) {
    const r = await createHandler({ ...config, fetchImpl })(post('/auth/exchange', { code: 'code', verifier }));
    assert.ok(r.status >= 400); assert.ok(!(await r.text()).includes('SECRET'));
  }
});
