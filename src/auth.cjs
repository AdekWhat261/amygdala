'use strict';

function randomToken() {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Сервис входа не ответил вовремя.')), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
class GoogleAuth {
  constructor({ bridge, request, secrets, savePending, getPending, email, mode = 'personal', teamFormat = 3 }) {
    if (!['personal', 'team'].includes(mode)) throw new Error('Некорректный режим входа.');
    if (![2, 3, 4].includes(teamFormat)) throw new Error('Некорректный формат командного входа.');
    this.bridge = bridge.replace(/\/$/, ''); this.request = request; this.secrets = secrets;
    this.savePending = savePending; this.getPending = getPending; this.email = email; this.personalEmail = mode === 'personal' ? email : null; this.mode = mode; this.teamFormat = teamFormat;
    this.token = null; this.expires = 0; this.refreshing = null;
  }
  async post(path, body) {
    if (!this.bridge) throw new Error('Сервис входа ещё не опубликован.');
    const url = new URL(this.bridge);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Сервис входа должен использовать HTTPS.');
    let r;
    try { r = await deadline(this.request({ url: this.bridge + path, method: 'POST',
      contentType: 'application/json', body: JSON.stringify(body), throw: false }), 30000); }
    catch { throw new Error('Не удалось связаться с сервисом входа.'); }
    if (r.status < 200 || r.status >= 300) throw new Error('Не удалось выполнить вход Google. Попробуйте снова.');
    return r.json;
  }
  async start({ pickTeamStore = false } = {}) {
    this.requireTeamPicker = this.mode === 'team' && Boolean(pickTeamStore);
    const verifier = randomToken(), state = randomToken();
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await this.savePending({ verifier, state, created: Date.now(), pickTeamStore: this.requireTeamPicker });
    const r = await this.post('/auth/start', { challenge, state, mode: this.mode,
      ...(this.mode === 'team' ? { teamFormat: this.teamFormat } : {}), pickTeamStore });
    const url = new URL(r.url || r.authorizeUrl || r.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Неожиданный адрес входа.');
    const loginHint = this.email || this.personalEmail;
    if (loginHint) url.searchParams.set('login_hint', loginHint);
    return url.toString();
  }
  async complete({ code, state, picked_file_ids: pickedFileIds, scope: callbackScope }) {
    const pending = await this.getPending();
    if (!pending || typeof state !== 'string' || state !== pending.state || !Number.isFinite(pending.created) || pending.created > Date.now() || Date.now() - pending.created > 10 * 60 * 1000) throw new Error('Ссылка входа устарела или относится к другому устройству.');
    const pickedSpreadsheetIds = typeof pickedFileIds === 'string' && pickedFileIds ? pickedFileIds.split(',') : [];
    if (pickedFileIds !== undefined && pickedFileIds !== '' && (this.mode !== 'team' || typeof pickedFileIds !== 'string'
      || pickedSpreadsheetIds.length > (this.teamFormat === 4 ? 9 : 1)
      || new Set(pickedSpreadsheetIds).size !== pickedSpreadsheetIds.length
      || pickedSpreadsheetIds.some(id => !/^[A-Za-z0-9_-]{8,128}$/.test(id)))) throw new Error('Google Picker вернул некорректные или повторяющиеся таблицы.');
    const r = await this.post('/auth/exchange', { code, verifier: pending.verifier, state });
    if (!r.access_token || !r.refresh_token) throw new Error('Google не предоставил постоянный доступ. Повторите вход с подтверждением доступа.');
    if (this.mode === 'team' && this.teamFormat >= 3) {
      const granted = typeof r.scope === 'string' ? r.scope.split(/\s+/) : typeof callbackScope === 'string' ? callbackScope.split(/\s+/) : [];
      if (!granted.includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google не подтвердил доступ drive.file. Разрешение не сохранено; повторите подключение командной таблицы.');
      if (callbackScope && !callbackScope.split(/\s+/).includes('https://www.googleapis.com/auth/drive.file')) throw new Error('Google Picker завершился без разрешения drive.file. Повторите подключение командной таблицы.');
      if (!pickedSpreadsheetIds.length && (pending.pickTeamStore || this.requireTeamPicker)) throw new Error('Google Picker не вернул выбранную таблицу. Повторите подключение и выберите таблицу Amygdala.');
    }
    let email = null, name = '';
    if (this.mode === 'personal') {
      let me;
      try { me = await this.request({ url: 'https://openidconnect.googleapis.com/v1/userinfo',
        headers: { Authorization: `Bearer ${r.access_token}` }, throw: false }); }
      catch { throw new Error('Не удалось проверить аккаунт Google.'); }
      if (me.status !== 200 || me.json?.email_verified !== true || typeof me.json.email !== 'string') {
        throw new Error('Не удалось подтвердить аккаунт Google.');
      }
      email = me.json.email; name = typeof me.json.name === 'string' ? me.json.name : '';
    }
    await this.secrets.set(r.refresh_token);
    this.token = r.access_token; this.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
    await this.savePending(null);
    const pickedSpreadsheetId = pickedSpreadsheetIds[0] || null;
    return { email, name, pickedSpreadsheetId, pickedSpreadsheetIds };
  }
  async accessToken(forceRefresh = false) {
    if (forceRefresh) { this.token = null; this.expires = 0; }
    if (this.token && this.expires > Date.now() + 60000) return this.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const refreshToken = await this.secrets.get();
      if (!refreshToken) throw new Error('Подключите Google Drive.');
      const r = await this.post('/auth/refresh', { refreshToken });
      if (!r.access_token) throw new Error('Google не выдал доступ. Повторите вход.');
      if (r.refresh_token) await this.secrets.set(r.refresh_token);
      this.token = r.access_token; this.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
      return this.token;
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async disconnect() { await this.secrets.set(''); this.token = null; this.expires = 0; await this.savePending(null); }
}
module.exports = { GoogleAuth, randomToken };
