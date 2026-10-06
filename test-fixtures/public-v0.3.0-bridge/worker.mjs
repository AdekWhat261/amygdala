const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SAFE_STATE = /^[A-Za-z0-9_-]{32,256}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...HEADERS, ...extra } });
const escapeHtml = s => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;');

/** Keep clientSecret in the hosting provider's secret store, never in the plugin. */
export function createHandler({ clientId, clientSecret, redirectUri, allowedOrigin, fetchImpl = fetch } = {}) {
  let configured = false;
  try {
    const uri = new URL(redirectUri);
    configured = Boolean(clientId && clientSecret && !uri.username && !uri.password && !uri.hash && !uri.search && uri.pathname === '/oauth/callback' &&
      (uri.protocol === 'https:' || (uri.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname))));
  } catch {}

  return async request => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (origin && allowedOrigin && origin !== allowedOrigin) return json({ error: 'origin_not_allowed' }, 403);
    const cors = origin && allowedOrigin === origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const reply = (data, status = 200) => json(data, status, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' } });
    const methods = { '/health': 'GET', '/auth/start': 'POST', '/oauth/callback': 'GET', '/auth/exchange': 'POST', '/auth/refresh': 'POST' };
    if (!methods[url.pathname]) return reply({ error: 'not_found' }, 404);
    if (request.method !== methods[url.pathname]) return json({ error: 'method_not_allowed' }, 405, { ...cors, Allow: methods[url.pathname] });
    if (url.pathname === '/health') return reply({ configured });
    if (!configured) return reply({ error: 'not_configured' }, 503);

    if (url.pathname === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!state || !SAFE_STATE.test(state) || !code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code) || url.searchParams.has('error')) return reply({ error: 'authorization_failed' }, 400);
      const pickedFileIds = url.searchParams.get('picked_file_ids');
      if (pickedFileIds !== null && (pickedFileIds.length > 128 || !/^[A-Za-z0-9_-]{8,128}$/.test(pickedFileIds))) return reply({ error: 'invalid_picker_result' }, 400);
      const callback = new URLSearchParams({ code, state });
      if (pickedFileIds !== null) callback.set('picked_file_ids', pickedFileIds);
      const scope = url.searchParams.get('scope');
      if (scope !== null && (scope.length > 4096 || /[\x00-\x1f\x7f]/.test(scope))) return reply({ error: 'invalid_scope' }, 400);
      if (scope !== null) callback.set('scope', scope);
      const link = `obsidian://amygdala-connection-oauth?${callback}`;
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Open Obsidian</title></head><body><h1>Continue in Obsidian</h1><p><a href="${escapeHtml(link)}">Open Obsidian to finish connecting</a></p><p>If the app does not open, return to the device where you started connecting.</p></body></html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' }
      });
    }
    let data;
    try {
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return reply({ error: 'json_required' }, 415);
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'invalid_request' }, 400);
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); return reply({ error: 'body_too_large' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch { return reply({ error: 'invalid_request' }, 400); }

    if (url.pathname === '/auth/start') {
      if (typeof data.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.challenge) || typeof data.state !== 'string' || !SAFE_STATE.test(data.state)) return reply({ error: 'invalid_request' }, 400);
      const mode = data.mode === undefined ? 'personal' : data.mode;
      if (!['personal', 'team'].includes(mode)) return reply({ error: 'invalid_request' }, 400);
      const teamFormat = mode === 'team' && data.teamFormat === undefined ? 2 : data.teamFormat;
      if (mode === 'team' && ![2, 3].includes(teamFormat)) return reply({ error: 'invalid_request' }, 400);
      if (mode === 'personal' && data.teamFormat !== undefined) return reply({ error: 'invalid_request' }, 400);
      if (data.pickTeamStore !== undefined && typeof data.pickTeamStore !== 'boolean') return reply({ error: 'invalid_request' }, 400);
      if (data.pickTeamStore && (mode !== 'team' || teamFormat !== 3)) return reply({ error: 'invalid_request' }, 400);
      const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      const scope = mode === 'team' ? (teamFormat === 3 ? 'https://www.googleapis.com/auth/drive.file' : 'https://www.googleapis.com/auth/drive openid email') : 'https://www.googleapis.com/auth/drive.appdata openid email';
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', code_challenge: data.challenge, code_challenge_method: 'S256', state: data.state });
      if (data.pickTeamStore) {
        params.set('trigger_onepick', 'true');
        params.set('mimetypes', 'application/vnd.google-apps.spreadsheet');
      }
      authorize.search = params.toString();
      return reply({ url: authorize.href });
    }
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    if (url.pathname === '/auth/exchange') {
      if (typeof data.code !== 'string' || !data.code || data.code.length > 4096 || /[\x00-\x1f\x7f]/.test(data.code) || typeof data.verifier !== 'string' || !VERIFIER.test(data.verifier) || (data.state !== undefined && (typeof data.state !== 'string' || !SAFE_STATE.test(data.state)))) return reply({ error: 'invalid_request' }, 400);
      params.set('grant_type', 'authorization_code'); params.set('code', data.code); params.set('code_verifier', data.verifier); params.set('redirect_uri', redirectUri);
    } else {
      if (typeof data.refreshToken !== 'string' || !data.refreshToken || data.refreshToken.length > 8192 || /[\x00-\x20\x7f]/.test(data.refreshToken)) return reply({ error: 'invalid_request' }, 400);
      params.set('grant_type', 'refresh_token'); params.set('refresh_token', data.refreshToken);
    }
    try {
      const response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(), signal: AbortSignal.timeout(20000) });
      if (!response.ok) return reply({ error: 'token_exchange_failed' }, 400);
      const tokens = await response.json();
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) return reply({ error: 'provider_unavailable' }, 502);
      const result = { access_token: tokens.access_token, expires_in: tokens.expires_in };
      if (typeof tokens.refresh_token === 'string') result.refresh_token = tokens.refresh_token;
      if (typeof tokens.scope === 'string') result.scope = tokens.scope;
      return reply(result);
    } catch { return reply({ error: 'provider_unavailable' }, 502); }
  };
}

// Cloudflare Workers module entry point (also usable through createHandler elsewhere).
export default { fetch(request, env) { return createHandler({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.OAUTH_REDIRECT_URI, allowedOrigin: env.ALLOWED_ORIGIN })(request); } };
