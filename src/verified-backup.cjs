'use strict';

const { hasFenceRange, parseFenceReceipt, fencedSlots, fenceDigest, sourceRecordsDigest,
  migrationEpoch, canonical, hasLockRange, hasActivationRange, parseSlotLock, lockedSlots,
  parseSlotActivation, assertActivationRange, rootLockId, activationEpoch } = require('./slot-fence.cjs');

const FORMAT = 'amygdala-google-sheets-backup';
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = value => encoder.encode(JSON.stringify(value));

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function canonicalDigest(value) { return sha256(json(value)); }

async function slotDigest(rows) { return canonicalDigest(rows); }

async function verifyRawSlot(item) {
  let header;
  try { header = JSON.parse(item.rows[0]?.[0]); } catch { throw new Error('A backup slot header is invalid'); }
  if (!header || header.hash !== header.payloadHash || !/^[a-f0-9]{64}$/i.test(header.hash || '')
    || !Number.isSafeInteger(header.blocks) || header.blocks < 1 || header.blocks > item.rows.length
    || !Number.isSafeInteger(header.size) || header.size < 0) throw new Error('A backup slot header is incomplete');
  const chunks = [];
  for (let index = 0; index < header.blocks; index++) {
    let encoded = item.rows[index]?.[1];
    if (encoded === undefined && item.kind === 'D' && index === 0 && header.size === 0) encoded = '';
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new Error('A backup slot payload is invalid');
    const binary = atob(encoded);
    chunks.push(Uint8Array.from(binary, char => char.charCodeAt(0)));
  }
  const payload = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0; for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
  if (payload.length !== header.size || await sha256(payload) !== header.hash)
    throw new Error('A backup slot payload hash does not match');
  return { header, payload };
}

async function buildVerifiedBackup(snapshot) {
  if (!snapshot || snapshot.stableSnapshot !== true || snapshot.remoteWrites !== 0
    || snapshot.verifyBlobs !== true || !snapshot.project || !Array.isArray(snapshot.sheets)
    || snapshot.sheets.length !== 9 || !/^[a-f0-9]{64}$/i.test(snapshot.fingerprint || '')) {
    throw new Error('A stable, blob-verified nine-sheet snapshot is required');
  }
  const { rootId, shardIds, folderId } = snapshot.project;
  if (typeof rootId !== 'string' || !rootId || typeof folderId !== 'string' || !folderId
    || !Array.isArray(shardIds) || shardIds.length !== 8 || new Set([rootId, ...shardIds]).size !== 9) {
    throw new Error('Backup project identity is incomplete or duplicated');
  }
  const expectedIds = [rootId, ...shardIds];
  const locked = snapshot.sheets.some(sheet => hasLockRange(sheet?.metadata) || hasActivationRange(sheet?.metadata));
  const fenced = !locked && snapshot.sheets.some(sheet => hasFenceRange(sheet?.metadata) || sheet?.metaCells?.length === 3);
  const controlSheet = snapshot.sheets.find(sheet => sheet.id === rootId);
  const active = locked && hasActivationRange(controlSheet?.metadata)
    ? parseSlotActivation([controlSheet.metaCells?.[3]]) : null;
  if (locked && (snapshot.sheets.some(sheet => !hasLockRange(sheet?.metadata) || hasFenceRange(sheet?.metadata))
    || snapshot.sheets.some(sheet => sheet.id !== rootId && hasActivationRange(sheet.metadata))))
    throw new Error('Backup requires all nine immutable locks and root-only activation');
  if (active) assertActivationRange(controlSheet.metadata);
  const receipts = new Map();
  const seenSheets = new Set();
  const sheets = await Promise.all(snapshot.sheets.map(async sheet => {
    if (!sheet || !expectedIds.includes(sheet.id) || seenSheets.has(sheet.id)
      || !sheet.manifest || sheet.manifest.rootId !== rootId || sheet.manifest.folderId !== folderId
      || !sheet.metadata || sheet.metadata.spreadsheetId !== sheet.id || !sheet.fileMetadata || sheet.fileMetadata.id !== sheet.id
      || sheet.fileMetadata.mimeType !== 'application/vnd.google-apps.spreadsheet'
      || !Array.isArray(sheet.fileMetadata.parents) || sheet.fileMetadata.parents.length !== 1 || sheet.fileMetadata.parents[0] !== folderId
      || sheet.fileMetadata.trashed !== false || sheet.fileMetadata.driveId != null
      || !Array.isArray(sheet.metaCells) || sheet.metaCells.length !== (locked ? (sheet.id === rootId && active ? 4 : 3) : fenced ? 3 : 2)
      || !Array.isArray(sheet.occupiedSlots) || !Array.isArray(sheet.slots)) throw new Error('Backup sheet metadata is incomplete');
    let metaManifest;
    try { metaManifest = JSON.parse(sheet.metaCells[1]?.[1]); } catch { throw new Error('Backup Meta manifest cell is invalid'); }
    if (sheet.metaCells[0]?.[0] !== 'key' || sheet.metaCells[0]?.[1] !== 'value'
      || sheet.metaCells[1]?.[0] !== 'manifest' || await canonicalDigest(metaManifest) !== await canonicalDigest(sheet.manifest))
      throw new Error('Backup Meta cells do not match the parsed manifest');
    const kind = sheet.id === rootId ? 'C' : 'D';
    let receipt, fenceSets;
    if (fenced || locked) {
      receipt = locked ? parseSlotLock([sheet.metaCells[2]]) : parseFenceReceipt([sheet.metaCells[2]]);
      fenceSets = locked ? lockedSlots(sheet.metadata, kind, receipt) : fencedSlots(sheet.metadata, kind, receipt);
      if (sheet.manifest.schema !== 2 || receipt.rootId !== rootId
        || receipt.sourceManifestDigest !== await fenceDigest(sheet.manifest))
        throw new Error('Backup fence does not match the raw source manifest');
      receipts.set(sheet.id, receipt);
    } else if ((sheet.metadata.namedRanges || []).some(item => /^AS5_[DC]_/.test(item.name || ''))) {
      throw new Error('Backup has new slots without a fence receipt');
    }
    seenSheets.add(sheet.id);
    if (sheet.id === rootId && !Array.isArray(sheet.teamPluginsRows))
      throw new Error('Root TeamPlugins rows are required for a complete backup');
    const slots = await Promise.all(sheet.slots.map(async item => {
      const allowedKind = sheet.id === rootId ? item.kind === 'C' : item.kind === 'D';
      if (!allowedKind || !Number.isSafeInteger(item.slot) || item.slot < 0 || !Array.isArray(item.rows)
        || item.rows.length === 0 || item.rows.some(row => !Array.isArray(row)
          || row.some(cell => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)))
        || item.sha256 !== await slotDigest(item.rows)) throw new Error('A backup slot is missing or failed its checksum');
      await verifyRawSlot(item);
      return { kind: item.kind, slot: item.slot, rows: item.rows.map(row => [...row]), sha256: item.sha256 };
    }));
    const keySet = new Set(slots.map(item => `${item.kind}:${item.slot}`));
    if (keySet.size !== slots.length) throw new Error('Backup contains a duplicate payload slot');
    const expectedKind = sheet.id === rootId ? 'C' : 'D';
    const expected = [...new Set(sheet.occupiedSlots)].sort((a, b) => a - b);
    const actual = slots.map(item => item.slot).sort((a, b) => a - b);
    if (expected.some(slot => !Number.isSafeInteger(slot) || slot < 0)
      || expected.length !== sheet.occupiedSlots.length || expectedKind !== slots[0]?.kind && slots.length > 0
      || JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Backup occupied-slot inventory is incomplete or inconsistent');
    if (fenced || locked) {
      if (canonical([...fenceSets.occupied].sort((a, b) => a - b)) !== canonical(actual))
        throw new Error('Backup fence occupied-slot inventory is incomplete');
      const bySlot = new Map(slots.map(item => [item.slot, item]));
      const sourceRecords = await Promise.all(receipt.sourceSlots.map(slot => verifyRawSlot(bySlot.get(slot))));
      if (await sourceRecordsDigest(receipt.sourceSlots, sourceRecords) !== receipt.sourceRecordsDigest)
        throw new Error('Backup source records differ from the fence receipt');
      if (locked && kind === 'D') {
        const approved = await Promise.all(receipt.approvedSourceSlots.map(slot => verifyRawSlot(bySlot.get(slot))));
        if (await sourceRecordsDigest(receipt.approvedSourceSlots, approved) !== receipt.approvedSourceRecordsDigest)
          throw new Error('Backup approved original data differs from its lock');
      }
      const epoch = locked ? active?.epoch : receipt.epoch;
      for (const slot of fenceSets.fresh) {
        const record = await verifyRawSlot(bySlot.get(slot));
        if (!epoch || record.header.epoch !== epoch || typeof record.header.opId !== 'string'
          || !record.header.opId.startsWith(`${kind === 'C' ? 'commit' : 'blob'}_${epoch}_`))
          throw new Error('Backup new slot has an invalid fence epoch');
        if (kind === 'C') {
          let commit; try { commit = JSON.parse(decoder.decode(record.payload)); } catch { throw new Error('Backup new commit is invalid'); }
          if (commit.epoch !== epoch || commit.opId !== record.header.opId)
            throw new Error('Backup new commit has an invalid fence epoch');
        }
      }
    }
    return {
      id: sheet.id,
      manifest: structuredClone(sheet.manifest),
      metadata: structuredClone(sheet.metadata),
      fileMetadata: { id: sheet.fileMetadata.id, mimeType: sheet.fileMetadata.mimeType,
        parents: [...sheet.fileMetadata.parents], trashed: sheet.fileMetadata.trashed, driveId: sheet.fileMetadata.driveId || null },
      metaCells: structuredClone(sheet.metaCells),
      occupiedSlots: [...sheet.occupiedSlots],
      ...(sheet.id === rootId ? { teamPluginsRows: structuredClone(sheet.teamPluginsRows) } : {}),
      slots
    };
  }));
  if (expectedIds.some(id => !seenSheets.has(id))) throw new Error('Backup is missing a project sheet');
  if (fenced || locked) {
    const control = receipts.get(rootId);
    if (locked ? control.lockId !== await rootLockId(control) : control.epoch !== await migrationEpoch(control))
      throw new Error('Backup root control identity is invalid');
    if (active && (active.rootId !== rootId || active.lockId !== control.lockId
      || active.rootLockDigest !== await fenceDigest(control) || active.epoch !== await activationEpoch(active)
      || active.sourceFingerprint === control.sourceFingerprint || active.backupBundleSha256 === control.backupBundleSha256))
      throw new Error('Backup activation does not bind a distinct frozen snapshot');
    for (let index = 0; index < expectedIds.length; index++) {
      const id = expectedIds[index], receipt = receipts.get(id);
      if (locked ? receipt.lockId !== control.lockId : receipt.epoch !== control.epoch)
        throw new Error('Backup contains different migration identities');
      const proofs = locked ? active?.shardReceiptDigests : control.shardReceiptDigests;
      if (index && proofs && (proofs[index - 1].spreadsheetId !== id || proofs[index - 1].digest !== await fenceDigest(receipt)))
        throw new Error('Backup shard fence digest is invalid');
      if (locked && index) {
        const approved = control.approvedShards[index - 1];
        if (approved.spreadsheetId !== id || approved.sourceManifestDigest !== receipt.sourceManifestDigest
          || canonical(approved.sourceSlots) !== canonical(receipt.approvedSourceSlots)
          || approved.sourceRecordsDigest !== receipt.approvedSourceRecordsDigest)
          throw new Error('Backup shard lost approved source identity');
      }
      const target = index ? control.targetShards[index - 1] : control.targetRoot;
      const reconstructed = { ...target, schema: 2 };
      delete reconstructed.pathProtocol; delete reconstructed.namespace;
      if (!index) { delete reconstructed.legacyQuarantine; delete reconstructed.legacyPathMap; }
      if (canonical(reconstructed) !== canonical(sheets.find(sheet => sheet.id === id).manifest))
        throw new Error('Backup fence target differs from the source manifest');
    }
  }
  const content = {
    format: FORMAT, version: VERSION, capturedAt: snapshot.capturedAt || new Date().toISOString(),
    project: { rootId, shardIds: [...shardIds], folderId },
    sourceFingerprint: snapshot.fingerprint,
    eventFingerprint: snapshot.eventFingerprint || null,
    sheets
  };
  return Object.freeze({ ...content, bundleSha256: await canonicalDigest(content) });
}

async function verifyBackup(bundle) {
  if (!bundle || bundle.format !== FORMAT || bundle.version !== VERSION || !Array.isArray(bundle.sheets)
    || !bundle.project || !/^[a-f0-9]{64}$/i.test(bundle.bundleSha256 || '')) throw new Error('Unsupported or malformed backup bundle');
  const { bundleSha256, ...content } = bundle;
  if (await canonicalDigest(content) !== bundleSha256) throw new Error('Backup bundle checksum mismatch');
  const rebuilt = await buildVerifiedBackup({ ...content, fingerprint: content.sourceFingerprint,
    stableSnapshot: true, remoteWrites: 0, verifyBlobs: true });
  if (rebuilt.bundleSha256 !== bundleSha256) throw new Error('Backup bundle validation failed');
  return true;
}

async function encodeBackup(bundle) {
  await verifyBackup(bundle);
  return json(bundle);
}

async function decodeBackup(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Backup bytes must be a byte array');
  let parsed;
  try { parsed = JSON.parse(decoder.decode(bytes)); }
  catch { throw new Error('Backup archive is corrupt or unreadable'); }
  await verifyBackup(parsed);
  return parsed;
}

/** A fixture-friendly restore plan; it never talks to Google or writes a vault. */
async function createRestorePlan(bundle, { expectedRootId } = {}) {
  await verifyBackup(bundle);
  if (expectedRootId && bundle.project.rootId !== expectedRootId) throw new Error('Backup belongs to a different project');
  return Object.freeze({
    project: structuredClone(bundle.project),
    sourceFingerprint: bundle.sourceFingerprint,
    sheets: bundle.sheets.map(sheet => ({
      id: sheet.id, manifest: structuredClone(sheet.manifest), metaCells: structuredClone(sheet.metaCells),
      metadata: structuredClone(sheet.metadata), fileMetadata: structuredClone(sheet.fileMetadata),
      occupiedSlots: [...sheet.occupiedSlots], teamPluginsRows: structuredClone(sheet.teamPluginsRows || []),
      slots: sheet.slots.map(slot => ({ ...slot, rows: slot.rows.map(row => [...row]) }))
    })),
    remoteWrites: 0
  });
}

module.exports = { FORMAT, VERSION, slotDigest, buildVerifiedBackup, verifyBackup, encodeBackup, decodeBackup, createRestorePlan };
