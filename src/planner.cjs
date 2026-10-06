'use strict';

const EXCLUDED = new Set(['.obsidian', '.trash', '.git', '.easy-sync']);
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
// Conservative Unicode folding also catches sharp-s and final-sigma aliases.
const portableKey = path => path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

function validatePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) {
    throw new Error(`Invalid portable path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f\u007f]/u.test(part) || /[. ]$/u.test(part) || RESERVED.test(part)) {
      throw new Error(`Invalid portable path: ${JSON.stringify(path)}`);
    }
  }
  return path;
}

function normalizeFolderPath(path) {
  if (typeof path !== 'string') throw new TypeError('Folder path must be a string');
  const normalized = path.normalize('NFC').replace(/\/+$/u, '');
  if (!normalized) throw new Error('Choose a specific folder inside the vault');
  validatePath(normalized);
  if (isExcluded(normalized)) throw new Error('This folder is reserved for Obsidian or Amygdala');
  return normalized;
}

function isWithinFolder(path, folderPath) {
  validatePath(path);
  const folder = normalizeFolderPath(folderPath);
  return path.startsWith(`${folder}/`);
}

function isExcluded(path) {
  return path.split('/').some(part => EXCLUDED.has(part.toLowerCase()));
}

function entries(value, name) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain path-to-hash object`);
  }
  return Object.entries(value).map(([path, hash]) => {
    validatePath(path);
    if (typeof hash !== 'string' || hash.length === 0) throw new TypeError(`Invalid hash for ${path}`);
    return [path, hash];
  }).filter(([path]) => !isExcluded(path));
}

function planSync({ local, remote, baseline } = {}) {
  const maps = [new Map(entries(local, 'local')), new Map(entries(remote, 'remote')), new Map(entries(baseline, 'baseline'))];
  const [l, r, b] = maps;
  const paths = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
  const canonical = new Map();
  for (const path of paths) {
    const key = portableKey(path);
    if (canonical.has(key) && canonical.get(key) !== path) throw new Error(`Path collision: ${canonical.get(key)} and ${path}`);
    canonical.set(key, path);
  }
  // A file cannot coexist with a directory of the same portable name.
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = portableKey(parts.slice(0, i).join('/'));
      if (canonical.has(prefix)) throw new Error(`File/directory collision: ${canonical.get(prefix)} and ${path}`);
    }
  }
  const operations = [];
  const unchanged = [];
  for (const path of paths) {
    const localHash = l.get(path) ?? null;
    const remoteHash = r.get(path) ?? null;
    const baselineHash = b.get(path) ?? null;
    if (localHash === remoteHash) { unchanged.push(path); continue; }
    let kind;
    let reason;
    if (baselineHash === null) {
      if (localHash === null) kind = 'download';
      else if (remoteHash === null) kind = 'upload';
      else { kind = 'conflict'; reason = 'first-merge'; }
    } else if (localHash === baselineHash) {
      kind = remoteHash === null ? 'delete-local' : 'download';
    } else if (remoteHash === baselineHash) {
      kind = localHash === null ? 'delete-remote' : 'upload';
    } else {
      kind = 'conflict';
      reason = localHash === null || remoteHash === null ? 'edit-delete' : 'both-modified';
    }
    operations.push({ path, kind, localHash, remoteHash, baselineHash, ...(reason ? { reason } : {}) });
  }
  return { operations, unchanged };
}

module.exports = { planSync, validatePath, isExcluded, normalizeFolderPath, isWithinFolder };
