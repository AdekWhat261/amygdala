'use strict';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
const ID = /^[A-Za-z0-9_-]{8,128}$/;

function accessError(status, message) {
  const error = new Error(message);
  if (Number.isInteger(status)) error.status = status;
  return error;
}

async function checkGoogleProjectAccess({ connection, getAccessToken, refreshAccessToken, request, timeoutMs = 20000 } = {}) {
  if (!connection || connection.kind !== 'team' || connection.version !== 4 || !ID.test(connection.id || ''))
    throw accessError(null, 'Read-only Google access check requires a linked Team v4 project');
  if (typeof getAccessToken !== 'function' || typeof request !== 'function')
    throw accessError(null, 'Read-only Google access check is unavailable');

  const url = `${SHEETS}${encodeURIComponent(connection.id)}?fields=spreadsheetId`;
  const send = async token => {
    if (typeof token !== 'string' || !token) throw accessError(null, 'Saved Google sign-in is unavailable');
    let timer;
    let response;
    try {
      response = await Promise.race([
        request({ url, method: 'GET', headers: { Authorization: `Bearer ${token}` }, throw: false }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })
      ]);
    } catch {
      throw accessError(null, 'Google read-only access check could not reach the Sheets API');
    } finally { clearTimeout(timer); }
    if (response?.status < 200 || response?.status >= 300) {
      const status = Number.isInteger(response?.status) ? response.status : null;
      if (status === 401) throw accessError(status, 'Google rejected the saved sign-in');
      if (status === 403) throw accessError(status, 'Google denied metadata access to the linked project');
      if (status === 404) throw accessError(status, 'Google could not find or expose the linked project file');
      throw accessError(status, 'Google read-only access check failed');
    }
    if (response?.json?.spreadsheetId !== connection.id)
      throw accessError(null, 'Google returned unexpected project metadata');
    return { ok: true, readOnly: true, checked: 'linked-root-spreadsheet-metadata' };
  };

  const token = await getAccessToken();
  try { return await send(token); }
  catch (error) {
    if (error?.status !== 401 || typeof refreshAccessToken !== 'function') throw error;
    const refreshed = await refreshAccessToken();
    return send(refreshed);
  }
}

module.exports = { checkGoogleProjectAccess };
