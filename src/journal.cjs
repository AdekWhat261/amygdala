'use strict';
const { validatePath, isExcluded, planSync } = require('./planner.cjs');
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/;
function validateRevision(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid revision');
  if (typeof event.id !== 'string' || !TOKEN.test(event.id)) throw new Error('Invalid revision id');
  validatePath(event.path);
  if (isExcluded(event.path)) throw new Error('Reserved revision path');
  if (event.hash !== null && (typeof event.hash !== 'string' || !/^[a-f0-9]{64}$/.test(event.hash))) throw new Error('Invalid revision hash');
  if (!Array.isArray(event.parents) || event.parents.some(id => typeof id !== 'string' || !TOKEN.test(id)) || new Set(event.parents).size !== event.parents.length) throw new Error('Invalid revision parents');
  const result = {id:event.id,path:event.path,hash:event.hash,parents:[...event.parents].sort()};
  if (event.actorId !== undefined) {
    if (typeof event.actorId !== 'string' || !/^[a-zA-Z0-9._@+-]{1,256}$/.test(event.actorId)) throw new Error('Invalid revision actor');
    result.actorId = event.actorId;
  }
  if (event.actorName !== undefined) {
    if (typeof event.actorName !== 'string' || !event.actorName.trim() || event.actorName.length > 120 || /[\u0000-\u001f\u007f]/.test(event.actorName)) throw new Error('Invalid revision actor name');
    result.actorName = event.actorName;
  }
  if (event.deviceId !== undefined) {
    if (typeof event.deviceId !== 'string' || !TOKEN.test(event.deviceId)) throw new Error('Invalid revision device');
    result.deviceId = event.deviceId;
  }
  if (event.createdAt !== undefined) {
    if (typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) || new Date(event.createdAt).toISOString() !== event.createdAt) throw new Error('Invalid revision timestamp');
    result.createdAt = event.createdAt;
  }
  return result;
}
function materialize(events) {
  if (!Array.isArray(events)) throw new Error('Events must be an array');
  const byId = new Map();
  for (const raw of events) {
    const event = validateRevision(raw);
    if (byId.has(event.id) && JSON.stringify(byId.get(event.id)) !== JSON.stringify(event)) throw new Error('Conflicting duplicate revision id');
    byId.set(event.id,event);
  }
  for (const event of byId.values()) for (const id of event.parents) {
    if (!byId.has(id)) throw new Error(`Missing parent: ${id}`);
    if (byId.get(id).path !== event.path) throw new Error('Parent path mismatch');
  }
  const visited = new Set(); const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Revision cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of byId.get(id).parents) visit(parent);
    visiting.delete(id); visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  const superseded = new Set([...byId.values()].flatMap(event => event.parents));
  const result = new Map();
  for (const event of byId.values()) if (!superseded.has(event.id)) {
    if (!result.has(event.path)) result.set(event.path,[]);
    result.get(event.path).push(event);
  }
  const active = Object.create(null);
  for (const [path,heads] of result) {
    heads.sort(compareHeads);
    if (heads.some(head => head.hash !== null)) active[path] = 'active';
  }
  planSync({local:active});
  return new Map([...result.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
}
function compareHeads(a,b) {
  const ak = `${a.hash === null ? '~' : a.hash}/${a.id}`;
  const bk = `${b.hash === null ? '~' : b.hash}/${b.id}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}
function conflictPath(path,hash) {
  validatePath(path);
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid conflict hash');
  const slash = path.lastIndexOf('/'); const dot = path.lastIndexOf('.');
  const split = dot > slash + 1 ? dot : path.length;
  return `${path.slice(0,split)} (conflict ${hash.slice(0,12)})${path.slice(split)}`;
}
function resolveHeads(heads) {
  const sorted = heads.map(validateRevision).sort(compareHeads);
  if (new Set(sorted.map(head=>head.path)).size > 1) throw new Error('Mixed head paths');
  const distinct = new Map();
  for (const head of sorted) if (head.hash !== null && !distinct.has(head.hash)) distinct.set(head.hash,head);
  const live = [...distinct.values()];
  const tombstones = sorted.filter(head => head.hash === null);
  return { canonical:live[0] || null, conflicts:live.slice(1).map(head=>({ ...head, conflictPath:conflictPath(head.path,head.hash) })), tombstones,
    heads:sorted.map(head=>head.id), hasConflict:live.length > 1 || (live.length > 0 && tombstones.length > 0) };
}
function planLocalRevisions({local = {},baseline = {},remoteHeads = new Map()} = {}) {
  planSync({local});
  const drafts = [];
  for (const path of [...new Set([...Object.keys(local),...Object.keys(baseline)])].sort()) {
    validatePath(path);
    if (isExcluded(path)) continue;
    const localHash = Object.hasOwn(local,path) ? local[path] : null;
    const base = Object.hasOwn(baseline,path) ? baseline[path] : null;
    if (base) {
      if (!Array.isArray(base.heads) || base.heads.some(id=>typeof id !== 'string' || !TOKEN.test(id)) || new Set(base.heads).size !== base.heads.length) throw new Error('Invalid baseline heads');
      if (base.hash !== null && (typeof base.hash !== 'string' || !/^[a-f0-9]{64}$/.test(base.hash))) throw new Error('Invalid baseline hash');
      if (localHash === base.hash) continue;
      drafts.push({path,hash:localHash,parents:[...base.heads].sort()});
    } else if (localHash !== null) {
      const remote = resolveHeads(remoteHeads.get(path) || []);
      if (remote.canonical?.hash === localHash) continue;
      drafts.push({path,hash:localHash,parents:[]});
    }
  }
  for (const draft of drafts) validateRevision({id:'draft',...draft});
  return drafts;
}
module.exports = {validateRevision,materialize,conflictPath,resolveHeads,planLocalRevisions};
