'use strict';

const assert = require('node:assert/strict');
const { TeamShardedStore, PARAMS, digest } = require('../src/team-sharded-store.cjs');
const { previewSchema2Migration } = require('../src/legacy-migration-preview.cjs');
const { FENCE_PROTOCOL, FENCE_RANGE_NAME, FENCE_ROW_KEY, LIMITS, allocationMarker, fenceDigest,
  sourceRecordsDigest, migrationEpoch, parseFenceReceipt, namedSlots } = require('../src/slot-fence.cjs');
const { TeamShardedStore: OldStore } = require('./authentic-old-client.cjs');
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const copy = value => structuredClone(value);

function rangeMarker(kind, slot, namespace = 'AS4') {
  const name = allocationMarker(kind, slot, namespace), start = 1 + slot * LIMITS[kind].blocks;
  return { name, namedRangeId: name, range: { sheetId: 2, startRowIndex: start, endRowIndex: start + LIMITS[kind].blocks } };
}
const fenceMarker = () => ({ name: FENCE_RANGE_NAME, namedRangeId: FENCE_RANGE_NAME,
  range: { sheetId: 1, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 } });

async function fixture({ revisionCount = 1, fenced = true } = {}) {
  const rootId = 'root_12345678', shardIds = Array.from({ length: 8 }, (_, i) => `shard_${i}_12345678`);
  const root = { schema: 2, type: 'amygdala-team-sharded', version: 4, rootId, vaultId: 'vault_12345678',
    folderId: 'folder_12345678', shardIds, params: PARAMS, paramsDigest: await digest(PARAMS) };
  const shards = shardIds.map((shardId, index) => ({ schema: 2, type: root.type, version: 4, rootId,
    vaultId: root.vaultId, folderId: root.folderId, shardId, index, paramsDigest: root.paramsDigest }));
  const legacy = { id: 'legacy_0001', path: 'Private/Note.md', hash: null, parents: [] };
  const legacyEvents = Array.from({ length: revisionCount }, (_, index) => index === 0 ? legacy
    : { id: `legacy_${String(index + 1).padStart(4, '0')}`, path: `Private/Note-${index}.md`, hash: null, parents: [] });
  const plan = previewSchema2Migration({ root, shards, events: legacyEvents, scopePath: 'Shared' });
  const seed = { sourceFingerprint: 'a'.repeat(64), scopePath: 'Shared', targetRoot: plan.rootManifest, targetShards: plan.shardManifests };
  const epoch = await migrationEpoch(seed), books = new Map(), receipts = [];
  let writes = 0, attempts = 0;
  const batches = [];
  for (let index = 0; index < 9; index++) {
    const id = index === 0 ? rootId : shardIds[index - 1], kind = index === 0 ? 'C' : 'D';
    const manifest = index === 0 ? root : shards[index - 1];
    books.set(id, { manifest: copy(manifest), receipt: null, rows: new Map(),
      teamPluginsRows: [['changeId', 'createdAt', 'change']], metadata: { spreadsheetId: id,
      namedRanges: [], sheets: [{ properties: { sheetId: 1, title: 'Meta', gridProperties: { rowCount: 100, columnCount: 2 } } },
        { properties: { sheetId: 2, title: 'Payload', gridProperties: { rowCount: 1 + LIMITS[kind].physical * LIMITS[kind].blocks, columnCount: 2 } } },
        ...(index === 0 ? [{ properties: { sheetId: 3, title: 'TeamPlugins', gridProperties: { rowCount: 6000, columnCount: 3 } } }] : [])] } });
  }
  async function record(id, kind, slot, payload, header, namespace = 'AS4') {
    const bytes = payload instanceof Uint8Array ? payload : encode(payload);
    const hash = await require('../src/drive.cjs').sha256(bytes);
    const blockSize = kind === 'C' ? PARAMS.commitBlockBytes : PARAMS.chunkBytes, blocks = Math.max(1, Math.ceil(bytes.length / blockSize));
    const full = { ...header, hash, payloadHash: hash, size: bytes.length, blocks };
    const book = books.get(id);
    const mark = rangeMarker(kind, slot, namespace);
    if (!book.metadata.namedRanges.some(item => item.name === mark.name)) book.metadata.namedRanges.push(mark);
    for (let i = 0; i < blocks; i++) book.rows.set(1 + slot * LIMITS[kind].blocks + i,
      [i === 0 ? JSON.stringify(full) : '', Buffer.from(bytes.subarray(i * blockSize, (i + 1) * blockSize)).toString('base64')]);
    return { header: full, payload: bytes };
  }
  const originalRecords = [];
  for (let offset = 0; offset < legacyEvents.length; offset += 100) {
    const slot = offset / 100, opId = slot === 0 ? 'commit_original' : `commit_original_${slot}`;
    originalRecords.push(await record(rootId, 'C', slot, { opId, events: legacyEvents.slice(offset, offset + 100) }, { opId, key: opId }));
  }
  const original = originalRecords[0];
  for (let index = 0; index < 9; index++) {
    const id = index === 0 ? rootId : shardIds[index - 1], book = books.get(id), kind = index === 0 ? 'C' : 'D';
    const sourceSlots = index === 0 ? originalRecords.map((_, slot) => slot) : [];
    receipts.push({ protocol: FENCE_PROTOCOL, epoch, kind: index === 0 ? 'root' : 'shard', rootId, spreadsheetId: id,
      sourceManifestDigest: await fenceDigest(book.manifest), sourceSlots,
      sourceRecordsDigest: await sourceRecordsDigest(sourceSlots, index === 0 ? originalRecords : []) });
    if (fenced) {
      book.metadata.namedRanges = Array.from({ length: LIMITS[kind].physical }, (_, slot) => rangeMarker(kind, slot));
      book.metadata.namedRanges.push(fenceMarker());
    }
  }
  Object.assign(receipts[0], seed, { shardReceiptDigests: await Promise.all(receipts.slice(1).map(async receipt =>
    ({ spreadsheetId: receipt.spreadsheetId, digest: await fenceDigest(receipt) }))) });
  if (fenced) receipts.forEach(receipt => { books.get(receipt.spreadsheetId).receipt = copy(receipt); });

  function readRows(id, range) {
    const book = books.get(id);
    if (range === 'Meta!A1:B2') return [['key', 'value'], ['manifest', JSON.stringify(book.manifest)]];
    if (range === 'Meta!A1:B3') return [['key', 'value'], ['manifest', JSON.stringify(book.manifest)],
      ...(book.receipt ? [[FENCE_ROW_KEY, JSON.stringify(book.receipt)]] : [])];
    if (range === 'Meta!A2:B2') return [['manifest', JSON.stringify(book.manifest)]];
    if (range === 'Meta!A3:B3') return book.meta3Rows ? copy(book.meta3Rows) : book.receipt ? [[FENCE_ROW_KEY, JSON.stringify(book.receipt)]] : [];
    if (range === 'TeamPlugins!A1:C') return copy(book.teamPluginsRows);
    const match = /^Payload!A(\d+):B(\d+)$/.exec(range);
    if (!match) throw new Error(`Unexpected range: ${range}`);
    const rows = [];
    for (let index = Number(match[1]) - 1; index < Number(match[2]); index++) rows.push(copy(book.rows.get(index) || []));
    while (rows.length && !rows[rows.length - 1].some(value => value !== '')) rows.pop();
    return rows;
  }
  function wire(store) {
    store.file = async id => ({ id, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false,
      parents: [root.folderId], capabilities: { canEdit: true } });
    store.spreadsheet = async id => copy(books.get(id).metadata);
    store.values = async (id, range) => ({ values: readRows(id, range) });
    store.call = async url => {
      const parsed = new URL(url), id = parsed.pathname.split('/')[3];
      if (!parsed.pathname.endsWith('/values:batchGet')) throw new Error(`Unexpected call: ${url}`);
      return { valueRanges: parsed.searchParams.getAll('ranges').map(range => ({ range, values: readRows(id, range) })) };
    };
    store.batch = async (id, requests) => {
      attempts++;
      const book = books.get(id), additions = requests.filter(item => item.addNamedRange).map(item => item.addNamedRange.namedRange);
      if (new Set(additions.map(item => item.name)).size !== additions.length
        || new Set(additions.map(item => item.namedRangeId)).size !== additions.length
        || additions.some(item => book.metadata.namedRanges.some(old => old.name === item.name || old.namedRangeId === item.namedRangeId))) {
        const error = new Error('Duplicate named range'); error.status = 400; error.googleDuplicateNamedRange = true; throw error;
      }
      // Validate every write before applying any part of this synthetic atomic batch.
      for (const item of requests) if (item.updateCells && item.updateCells.range.sheetId === 1) {
        assert.equal(item.updateCells.range.startRowIndex, 2);
        assert.equal(item.updateCells.rows.length, 1);
        assert.equal(item.updateCells.rows[0].values[0].userEnteredValue.stringValue, FENCE_ROW_KEY);
        JSON.parse(item.updateCells.rows[0].values[1].userEnteredValue.stringValue);
      }
      book.metadata.namedRanges.push(...copy(additions));
      for (const item of requests) if (item.updateCells) {
        const update = item.updateCells;
        if (update.range.sheetId === 1) book.receipt = JSON.parse(update.rows[0].values[1].userEnteredValue.stringValue);
        else {
          assert.equal(update.range.sheetId, 2);
          update.rows.forEach((row, index) => book.rows.set(update.range.startRowIndex + index,
            row.values.map(cell => cell.userEnteredValue?.stringValue || '')));
        }
      }
      batches.push({ id, requests: copy(requests) });
      writes++; return {};
    };
    return store;
  }
  const make = (Class = TeamShardedStore, options = {}) => wire(new Class({ rootId, request: async () => { throw new Error('No network'); },
    getAccessToken: async () => 'fixture-token', limiter: { acquire: async () => {}, defer() {} }, sleep: async () => {}, ...options }));
  return { rootId, shardIds, root, shards, epoch, books, receipts, legacy, original, record, make,
    batches, getWrites: () => writes, getAttempts: () => attempts };
}


module.exports = { fixture, rangeMarker, fenceMarker, OldStore, encode, copy };
