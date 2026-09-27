const test = require('node:test');
const assert = require('node:assert/strict');
const { TeamSheetStore } = require('../src/team-sheet-store.cjs');
const { sha256 } = require('../src/drive.cjs');

function fakeGoogle() {
  const sheets = new Map(); let spreadsheetId = null, folderId = null, folderCreated = false, sheetCreated = false, moved = false;
  const calls = [];
  const column = name => name.charCodeAt(0) - 65;
  const readRange = range => {
    const match = range.match(/^([^!]+)!([A-Z])(\d+):([A-Z])(\d*)$/);
    if (!match) throw new Error(`Unexpected range: ${range}`);
    const [, title, firstColumn, firstRow, lastColumn, lastRow] = match;
    const rows = sheets.get(title) || [];
    return rows.slice(Number(firstRow) - 1, lastRow ? Number(lastRow) : undefined)
      .map(row => row.slice(column(firstColumn), column(lastColumn) + 1));
  };
  const request = async request => {
    calls.push(request);
    assert.equal(request.headers.Authorization, 'Bearer TEST_TOKEN');
    const url = new URL(request.url), path = url.pathname;
    if (path === 'https://www.googleapis.com/drive/v3/files' || path === '/drive/v3/files') {
      if (request.method === 'POST') {
        folderCreated = true; folderId = 'folder_12345678';
        return { status: 200, json: { id: folderId, name: 'Amygdala — Team', webViewLink: `https://drive.google.com/drive/folders/${folderId}`, mimeType: 'application/vnd.google-apps.folder' } };
      }
    }
    if (path === '/v4/spreadsheets') {
      assert.ok(folderCreated); sheetCreated = true; spreadsheetId = 'sheet_12345678';
      for (const title of ['Meta', 'Events', 'Blobs', 'BlobIndex', 'TeamPlugins']) sheets.set(title, []);
      return { status: 200, json: { spreadsheetId, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` } };
    }
    if (path === `/drive/v3/files/${spreadsheetId}` && request.method === 'GET' && !moved) {
      return { status: 200, json: { id: spreadsheetId, parents: ['drive_root_123456'] } };
    }
    if (path === `/drive/v3/files/${spreadsheetId}` && request.method === 'PATCH') {
      assert.equal(url.searchParams.get('addParents'), folderId);
      assert.equal(url.searchParams.get('removeParents'), 'drive_root_123456');
      moved = true;
      return { status: 200, json: { id: spreadsheetId, parents: [folderId] } };
    }
    if (path === `/drive/v3/files/${spreadsheetId}` && request.method === 'GET') {
      assert.ok(sheetCreated);
      return { status: 200, json: { id: spreadsheetId, name: 'Amygdala — Team', mimeType: 'application/vnd.google-apps.spreadsheet',
        trashed: false, webViewLink: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, parents: [folderId], capabilities: { canEdit: true } } };
    }
    if (path === `/drive/v3/files/${spreadsheetId}/permissions`) {
      return { status: 200, json: { permissions: [{ id: 'perm_alice_123', type: 'user', emailAddress: 'alice@example.org', displayName: 'Alice', role: 'writer' }] } };
    }
    if (path.endsWith('/values:batchUpdate')) {
      const body = JSON.parse(request.body);
      for (const item of body.data) {
        const [title, cells] = item.range.split('!'), [, firstCol, firstRow] = cells.match(/^([A-Z])(\d+)/);
        const rows = sheets.get(title);
        for (let i = 0; i < item.values.length; i++) rows[Number(firstRow) - 1 + i] = [...(rows[Number(firstRow) - 1 + i] || [])];
        for (let r = 0; r < item.values.length; r++) for (let c = 0; c < item.values[r].length; c++) rows[Number(firstRow) - 1 + r][column(firstCol) + c] = item.values[r][c];
      }
      return { status: 200, json: { totalUpdatedCells: 18 } };
    }
    const decodedPath = decodeURIComponent(path);
    const append = decodedPath.match(/^\/v4\/spreadsheets\/[^/]+\/values\/(.+):append$/);
    if (append) {
      const [title, cells] = append[1].split('!');
      const range = cells.match(/^([A-Z]):([A-Z])$/);
      assert.ok(range, append[1]);
      const [, first, last] = range, rows = sheets.get(title), values = JSON.parse(request.body).values;
      const firstRow = rows.length + 1;
      rows.push(...values.map(row => Array(Number(column(last)) - Number(column(first)) + 1).fill(undefined).map((_, index) => row[index])));
      return { status: 200, json: { updates: { updatedRange: `${title}!${first}${firstRow}:${last}${firstRow + values.length - 1}` } } };
    }
    if (path.endsWith('/values:batchGet')) {
      return { status: 200, json: { valueRanges: url.searchParams.getAll('ranges').map(range => ({ values: readRange(range) })) } };
    }
    const get = decodedPath.match(/^\/v4\/spreadsheets\/[^/]+\/values\/(.+)$/);
    if (get) return { status: 200, json: { values: readRange(get[1]) } };
    throw new Error(`Unexpected Google API request: ${request.method} ${request.url}`);
  };
  return { request, calls, get ids() { return { folderId, spreadsheetId }; } };
}

test('team workbook is created inside the shared folder and exposes a stable actor ID', async () => {
  const google = fakeGoogle(), store = new TeamSheetStore({ request: google.request, getAccessToken: async () => 'TEST_TOKEN' });
  const vault = await store.createTeamVault('Team');
  assert.equal(vault.kind, 'team'); assert.equal(vault.version, 3); assert.equal(vault.folderId, 'folder_12345678');
  assert.equal(vault.id, 'sheet_12345678'); assert.ok(vault.webViewLink.includes('/folders/'));
  assert.deepEqual(await store.actorFor('alice@example.org'), { actorId: 'perm_alice_123', actorName: 'Alice' });
  assert.ok(google.calls.some(call => call.url.includes('sheets.googleapis.com/v4/spreadsheets')));
});

test('team sheet journal is append-only, idempotent and rejects a reused event ID', async () => {
  const google = fakeGoogle(), store = new TeamSheetStore({ request: google.request, getAccessToken: async () => 'TEST_TOKEN' });
  await store.createTeamVault('Team');
  const event = { id: 'event_12345678', path: 'notes/a.md', hash: null, parents: [] };
  await store.putEvent(event); await store.putEvent(event);
  assert.deepEqual(await store.listEvents(), [event]);
  await assert.rejects(store.putEvent({ ...event, path: 'notes/b.md' }), /Конфликт/);
});

test('team sheet stores binary blobs in indexed chunks and validates SHA-256 on read', async () => {
  const google = fakeGoogle(), store = new TeamSheetStore({ request: google.request, getAccessToken: async () => 'TEST_TOKEN' });
  await store.createTeamVault('Team');
  const bytes = new Uint8Array(2_000_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
  const hash = await sha256(bytes);
  await store.putBlob(hash, bytes);
  assert.deepEqual(await store.getBlob(hash), bytes);
  await assert.rejects(store.putBlob(hash, new Uint8Array([1, 2, 3])), /изменился/);
  const blobWrites = google.calls.filter(call => new URL(call.url).pathname.includes('Blobs'));
  assert.ok(blobWrites.length > 1, 'large blob was split into multiple Sheets API batches');
});
