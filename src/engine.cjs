'use strict';
const { materialize, resolveHeads, planLocalRevisions, validateRevision } = require('./journal.cjs');
const { planSync } = require('./planner.cjs');

class SyncEngine {
  constructor({ remote, local, state, saveState, randomId, hash, actor = null, deviceId = null, progress = () => {} }) {
    Object.assign(this, { remote, local, state, saveState, randomId, hash, actor, deviceId, progress });
    this.state.baseline = Object.assign(Object.create(null),this.state.baseline || {});
    this.state.outbox ||= [];
    this.running = null;
  }
  sync() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async persist() { await this.saveState(this.state); }
  async flush(progress = {}) {
    const total = progress.total ?? this.state.outbox.length;
    let completed = progress.completed ?? 0;
    if (this.state.outbox.length) this.progress({ phase: 'upload', completed, total });
    if (this.state.outbox.length) await this.persist();
    while (this.state.outbox.length) {
      const batch = []; let queuedBytes = 0;
      for (const item of this.state.outbox) {
        const event = validateRevision(item.event);
        const bytes = event.hash === null ? null : Uint8Array.from(item.bytes || []);
        if (event.hash !== null && await this.hash(bytes) !== event.hash) throw new Error('Corrupt pending upload');
        if (batch.length && (batch.length >= 100 || queuedBytes + (bytes?.byteLength || 0) > 1024 * 1024)) break;
        batch.push({ event, bytes }); queuedBytes += bytes?.byteLength || 0;
        if (batch.length >= 100 || queuedBytes >= 1024 * 1024) break;
      }
      const blobs = batch.filter(item => item.event.hash !== null).map(item => ({ hash: item.event.hash, data: item.bytes }));
      if (this.remote.putBlobs) await this.remote.putBlobs(blobs);
      else for (const blob of blobs) await this.remote.putBlob(blob.hash, blob.data);
      const events = batch.map(item => item.event);
      if (this.remote.putEvents) await this.remote.putEvents(events);
      else for (const event of events) await this.remote.putEvent(event);
      // Acknowledge the whole batch only after every blob and event is durable.
      for (const { event } of batch) this.state.baseline[event.path] = { hash: event.hash, heads: [event.id] };
      this.state.outbox.splice(0, batch.length);
      await this.persist();
      completed += batch.length;
      this.progress({ phase: 'upload', completed, total });
    }
  }
  async checkedBlob(hash) {
    const bytes = await this.remote.getBlob(hash);
    if (!(bytes instanceof Uint8Array) || await this.hash(bytes) !== hash) throw new Error(`Blob integrity failure: ${hash}`);
    return bytes;
  }
  async verify() {
    this.progress({ phase: 'listing' });
    const events = await this.remote.listEvents();
    const merged = materialize(events);
    const snapshot = await this.local.scan();
    const expected = new Map();
    const hashes = new Set();
    for (const [path, heads] of merged) {
      const { canonical, conflicts, hasConflict } = resolveHeads(heads);
      if (canonical) { expected.set(path, canonical.hash); hashes.add(canonical.hash); }
      if (hasConflict) for (const variant of [canonical, ...conflicts].filter(Boolean)) hashes.add(variant.hash);
    }
    if (expected.size !== Object.keys(snapshot).length) throw new Error('Количество локальных и облачных файлов различается. Повторите синхронизацию.');
    for (const [path, hash] of expected) if (snapshot[path] !== hash) throw new Error(`Облачная копия не совпадает: ${path}`);
    for (const [path, heads] of merged) {
      const resolution = resolveHeads(heads);
      if (resolution.hasConflict) for (const variant of [resolution.canonical, ...resolution.conflicts].filter(Boolean)) {
        const copy = await this.local.readConflict(path, variant.hash);
        if (!copy || await this.hash(copy) !== variant.hash) throw new Error(`Не найдена локальная версия конфликта: ${path}`);
      }
    }
    let completed = 0;
    this.progress({ phase: 'verify', completed, total: hashes.size });
    const queue = [...hashes];
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const index = next++;
        await this.checkedBlob(queue[index]);
        completed += 1;
        this.progress({ phase: 'verify', completed, total: hashes.size });
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
    return { files: expected.size, conflicts: [...merged.values()].filter(heads => resolveHeads(heads).hasConflict).length, blobs: hashes.size };
  }
  async run() {
    // A failed/incomplete listing cannot authorize local edits or deletion.
    await this.remote.assertAccess?.();
    this.progress({ phase: 'listing' });
    let events = await this.remote.listEvents();
    materialize([...events,...this.state.outbox.map(item=>item.event)]);
    const knownIds = new Set([...events,...this.state.outbox.map(item=>item.event)].map(event=>event.id));
    for (const base of Object.values(this.state.baseline)) {
      if (!Array.isArray(base.heads) || base.heads.some(id=>!knownIds.has(id))) throw new Error('Remote history missing previously synchronized revisions');
    }
    await this.flush();
    events = await this.remote.listEvents();
    const remoteHeads = materialize(events);
    const snapshot = await this.local.scan();
    this.progress({ phase: 'planning', total: Object.keys(snapshot).length });
    const remotePaths = Object.fromEntries([...remoteHeads].filter(([,heads]) => heads.some(h => h.hash !== null)).map(([path]) => [path,'remote']));
    planSync({local:snapshot, remote:remotePaths});
    const drafts = planLocalRevisions({local:snapshot, baseline:this.state.baseline, remoteHeads});
    const deferred = [];
    let uploaded = 0, queuedCount = 0, queuedBytes = 0;
    this.progress({ phase: 'upload', completed: uploaded, total: drafts.length });
    for (const draft of drafts) {
      let bytes = null;
      if (draft.hash !== null) {
        bytes = await this.local.read(draft.path);
        if (!bytes || await this.hash(bytes) !== draft.hash) { deferred.push(draft.path); continue; }
      }
      this.state.outbox.push({event:validateRevision({id:this.randomId(), ...draft, ...this.revisionMetadata()}), bytes:bytes === null ? null : bytes.slice()});
      // Bound the durable upload batch by both bytes and event count. This
      // keeps recovery safe while allowing append-oriented remotes to batch.
      queuedCount += 1; queuedBytes += bytes?.byteLength || 0;
      await this.persist();
      materialize([...events,...this.state.outbox.map(item=>item.event)]);
      // Legacy per-record stores keep the original one-file-at-a-time
      // durability and memory behavior. Append-oriented stores may batch.
      if (!this.remote.putEvents || queuedCount >= 100 || queuedBytes >= 1024 * 1024) {
        await this.flush({ completed: uploaded, total: drafts.length });
        uploaded += queuedCount; queuedCount = 0; queuedBytes = 0;
      }
    }
    if (queuedCount) { await this.flush({ completed: uploaded, total: drafts.length }); uploaded += queuedCount; }
    this.progress({ phase: 'reconciling' });
    events = await this.remote.listEvents();
    const merged = materialize(events);
    const destinations = Object.fromEntries(Object.keys(snapshot).map(path=>[path,'local']));
    for (const [path,heads] of merged) {
      const resolution = resolveHeads(heads);
      if (resolution.canonical) destinations[path] = 'remote';
      for (const conflict of resolution.conflicts) destinations[conflict.conflictPath] = 'conflict';
    }
    planSync({local:destinations});
    const applied = []; const conflicts = [];
    for (const [path,heads] of merged) {
      const resolution = resolveHeads(heads);
      const { canonical, conflicts:copies, heads:ids } = resolution;
      const expected = Object.hasOwn(snapshot,path) ? snapshot[path] : null;
      if (canonical && canonical.hash === expected && !resolution.hasConflict) {
        const current = await this.local.read(path);
        if (current === null || await this.hash(current) !== expected) {
          deferred.push(path);
          continue;
        }
        const base = this.state.baseline[path];
        if (!base || base.hash !== expected || JSON.stringify(base.heads) !== JSON.stringify(ids)) {
          this.state.baseline[path] = {hash:expected, heads:ids};
          await this.persist();
        }
        applied.push(path);
        continue;
      }
      // Fetch and validate all variants before touching this note.
      const hashes = [...new Set([canonical, ...copies].filter(Boolean).map(e=>e.hash))];
      const blobs = new Map();
      for (const hash of hashes) blobs.set(hash,await this.checkedBlob(hash));
      if (resolution.hasConflict) {
        for (const variant of [canonical, ...copies].filter(Boolean)) await this.local.writeConflict(path, variant.hash, blobs.get(variant.hash));
        conflicts.push(path);
      }
      let accepted;
      if (canonical) {
        accepted = await this.local.writeIfUnchanged(path, blobs.get(canonical.hash), expected);
      } else if (expected !== null) {
        // Only a previously tracked note can be removed. The adapter must
        // retain a recovery copy before deleting or replacing any local file.
        accepted = Object.hasOwn(this.state.baseline,path) && await this.local.removeIfUnchanged(path,expected);
      } else {
        accepted = await this.local.read(path) === null;
      }
      if (!accepted) { deferred.push(path); continue; }
      this.state.baseline[path] = {hash:canonical?.hash ?? null, heads:ids};
      await this.persist();
      applied.push(path);
    }
    return { applied, conflicts:[...new Set(conflicts)], deferred:[...new Set(deferred)] };
  }
  revisionMetadata() {
    if (!this.actor) return {};
    return { actorId: this.actor.actorId, actorName: this.actor.actorName, ...(this.deviceId ? { deviceId: this.deviceId } : {}), createdAt: new Date().toISOString() };
  }
  async listConflicts() {
    await this.remote.assertAccess?.();
    const events = await this.remote.listEvents();
    const merged = materialize(events), result = [];
    for (const [path, heads] of merged) {
      const resolution = resolveHeads(heads);
      if (!resolution.hasConflict) continue;
      const variants = [resolution.canonical, ...resolution.conflicts, ...resolution.tombstones].filter(Boolean);
      for (const variant of variants) if (variant.hash !== null) {
        const data = await this.checkedBlob(variant.hash);
        await this.local.writeConflict(path, variant.hash, data);
      }
      result.push({ path, variants: variants.map(variant => ({ id: variant.id, hash: variant.hash, deleted: variant.hash === null,
        actorId: variant.actorId || '', actorName: variant.actorName || (variant.actorId ? 'Участник' : 'Старое изменение'),
        deviceId: variant.deviceId || '', createdAt: variant.createdAt || '',
        copyPath: variant.hash === null ? null : this.local.conflictPath(path, variant.hash) })) });
    }
    return result;
  }
  async resolveConflict(path, variantId, manualBytes = null) {
    await this.remote.assertAccess?.();
    const events = await this.remote.listEvents();
    const headsByPath = materialize(events), heads = headsByPath.get(path);
    if (!heads) throw new Error('Эта заметка больше не содержит конфликта. Синхронизируйте и обновите список.');
    const resolution = resolveHeads(heads);
    if (!resolution.hasConflict) throw new Error('Конфликт уже разрешён. Синхронизируйте и обновите список.');
    let hash, data = null;
    if (variantId === 'manual') {
      if (!(manualBytes instanceof Uint8Array)) throw new Error('Не удалось прочитать итоговую заметку.');
      data = manualBytes.slice(); hash = await this.hash(data);
      await this.remote.putBlob(hash, data);
    } else {
      const variant = heads.find(head => head.id === variantId);
      if (!variant) throw new Error('Версия конфликта больше недоступна. Обновите список.');
      hash = variant.hash;
      if (hash !== null) data = await this.checkedBlob(hash);
    }
    const current = await this.local.read(path), currentHash = current === null ? null : await this.hash(current);
    if (hash === null) {
      if (!await this.local.removeIfUnchanged(path, currentHash)) throw new Error('Закройте или сохраните изменённую заметку и повторите разрешение конфликта.');
    } else if (!await this.local.writeIfUnchanged(path, data, currentHash)) {
      throw new Error('Заметка изменилась во время разрешения конфликта. Синхронизируйте и повторите.');
    }
    const event = validateRevision({ id: this.randomId(), path, hash, parents: [...resolution.heads].sort(), ...this.revisionMetadata() });
    this.state.outbox.push({ event, bytes: data });
    await this.flush();
    return event;
  }
}
module.exports = { SyncEngine };
