'use strict';
const { sha256, bytes } = require('./drive.cjs');
const { validatePath, isExcluded, normalizeFolderPath, isWithinFolder } = require('./planner.cjs');

class DeviceState {
  constructor(id) { this.id = id; this.connection = null; this.persistedOutboxIds = new Set(); }
  async db() {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(`easy-sync-${this.id}`, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');
        if (!request.result.objectStoreNames.contains('outbox')) request.result.createObjectStore('outbox');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('Не удалось открыть локальный журнал синхронизации.'));
      request.onblocked = () => reject(new Error('Перезапустите Obsidian, чтобы обновить локальный журнал синхронизации.'));
    });
    return this.connection;
  }
  async load() {
    const db = await this.db();
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('current');
      request.onsuccess = () => resolve(request.result || { baseline: {}, outbox: [] });
      request.onerror = () => reject(new Error('Не удалось прочитать локальный журнал.'));
    });
    // Version 1 kept every pending byte array in one growing record. Migrate it
    // once so acknowledging one file never rewrites all remaining attachments.
    if (Array.isArray(stored.outbox)) {
      const migrated = { baseline: stored.baseline || {}, outbox: stored.outbox, ...(stored.scopeBinding ? { scopeBinding: stored.scopeBinding } : {}) };
      await this.save(migrated);
      return migrated;
    }
    const ids = Array.isArray(stored.outboxIds) ? stored.outboxIds : [];
    const outbox = await new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const store = tx.objectStore('outbox');
      const values = [];
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result === undefined) { tx.abort(); return; }
          values.push(request.result);
        };
      }
      tx.oncomplete = () => resolve(values);
      tx.onerror = tx.onabort = () => reject(new Error('Локальная очередь синхронизации повреждена.'));
    });
    this.persistedOutboxIds = new Set(ids);
    const byId = new Map(outbox.map(item => [item?.event?.id, item]));
    if (byId.size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('Локальная очередь синхронизации повреждена.');
    return { baseline: stored.baseline || {}, outbox: ids.map(id => byId.get(id)), ...(stored.scopeBinding ? { scopeBinding: stored.scopeBinding } : {}) };
  }
  async save(state) {
    const db = await this.db();
    const outbox = Array.isArray(state.outbox) ? state.outbox : [];
    const ids = outbox.map(item => item?.event?.id);
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Локальная очередь синхронизации повреждена.');
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'outbox'], 'readwrite');
      tx.objectStore('state').put({ baseline: state.baseline || {}, outboxIds: ids, ...(state.scopeBinding ? { scopeBinding: state.scopeBinding } : {}) }, 'current');
      const pending = tx.objectStore('outbox');
      for (const item of outbox) if (!this.persistedOutboxIds.has(item.event.id)) pending.put(item, item.event.id);
      for (const id of this.persistedOutboxIds) if (!ids.includes(id)) pending.delete(id);
      tx.oncomplete = () => { this.persistedOutboxIds = new Set(ids); resolve(); };
      tx.onerror = tx.onabort = () => reject(new Error('Не удалось сохранить локальный журнал. Проверьте свободное место на устройстве.'));
    });
  }
  async close() { if (this.connection) (await this.connection).close(); }
}

class LocalVault {
  constructor(app, { scopePath = null } = {}) {
    this.app = app; this.vault = app.vault;
    this.scopePath = scopePath === null ? null : normalizeFolderPath(scopePath);
  }
  localPath(path) {
    validatePath(path);
    return this.scopePath ? `${this.scopePath}/${path}` : path;
  }
  async scan() {
    const hashes = Object.create(null);
    for (const file of this.vault.getFiles()) {
      if (this.scopePath && (typeof file.path !== 'string' || !file.path.startsWith(`${this.scopePath}/`))) continue;
      if (isExcluded(file.path)) continue;
      validatePath(file.path);
      const syncPath = this.scopePath ? file.path.slice(this.scopePath.length + 1) : file.path;
      if (!syncPath) continue;
      validatePath(syncPath);
      if (file.stat.size > 100 * 1024 * 1024) throw new Error(`Файл больше 100 МБ: ${file.path}. Эта версия пока его не поддерживает.`);
      const data = await this.read(syncPath);
      if (data !== null) hashes[syncPath] = await sha256(data);
    }
    return hashes;
  }
  async read(path) {
    const file = this.vault.getFileByPath(this.localPath(path));
    if (!file) return null;
    const data = bytes(await this.vault.readBinary(file));
    if (!this.scopePath) return data;
    if (file.extension === 'canvas' || file.path.toLowerCase().endsWith('.canvas')) return this.mapCanvas(data, 'remote', file.path);
    if (file.extension === 'md' || file.path.toLowerCase().endsWith('.md')) return this.mapMarkdown(data, 'remote', file.path);
    return data;
  }
  resolveLinkedFile(linkPath, sourcePath) {
    const resolved = this.app.metadataCache?.getFirstLinkpathDest?.(linkPath, sourcePath);
    if (resolved) return resolved;
    const candidates = [linkPath, ...(linkPath.includes('.') ? [] : [`${linkPath}.md`])];
    for (const candidate of candidates) {
      const file = this.vault.getAbstractFileByPath?.(candidate);
      if (file && typeof file.path === 'string' && !Array.isArray(file.children)) return file;
    }
    return null;
  }
  mapReferenceTarget(rawTarget, direction, sourcePath) {
    if (!/^(?:https?:|mailto:|obsidian:)/iu.test(rawTarget) && rawTarget.includes('&')) {
      throw new Error('Entity-encoded or ampersand-containing local links need parser-backed scope mapping');
    }
    const match = /^([^#]*)(#.*)?$/u.exec(rawTarget);
    const linkPath = match?.[1] || '';
    const suffix = match?.[2] || '';
    if (!linkPath || /^(?:https?:|mailto:|obsidian:)/iu.test(linkPath)) return rawTarget;
    // Encoded local destinations require a real Markdown/URL parser; fail closed.
    if (/%[0-9a-f]{2}/iu.test(linkPath)) throw new Error('Encoded local links are not supported safely in team sync');
    if (/^file:/iu.test(linkPath) || linkPath.startsWith('/') || linkPath.includes('\\') || /^[a-z]:/iu.test(linkPath)) {
      throw new Error('A linked path cannot be shared safely');
    }
    if (direction === 'local') {
      validatePath(linkPath);
      if (isExcluded(linkPath)) throw new Error('A linked path is reserved');
      // Incoming paths are project-relative. Never resolve against private vault
      // basenames; prefix even unresolved links before the note becomes visible.
      return `${this.scopePath}/${linkPath}${suffix}`;
    }
    const resolved = this.resolveLinkedFile(linkPath, sourcePath);
    if (direction === 'remote') {
      if (resolved) {
        if (!isWithinFolder(resolved.path, this.scopePath)) throw new Error('A linked file is outside the selected team folder; remove or replace that link before syncing');
        const relative = resolved.path.slice(this.scopePath.length + 1);
        validatePath(relative);
        if (isExcluded(relative)) throw new Error('A linked path is reserved');
        return `${relative}${suffix}`;
      }
      if (isWithinFolder(linkPath, this.scopePath)) {
        const relative = linkPath.slice(this.scopePath.length + 1);
        validatePath(relative);
        if (isExcluded(relative)) throw new Error('A linked path is reserved');
        return `${relative}${suffix}`;
      }
      if (linkPath.split('/').includes('..')) throw new Error('A linked path cannot be shared safely');
      if (linkPath.includes('/')) throw new Error('An unresolved path link cannot be shared safely; use a link to a file inside the selected team folder');
      return rawTarget;
    }
    throw new Error('Unknown team path mapping direction');
  }
  mapMarkdown(data, direction, sourcePath) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = decoder.decode(data);
    // Conservative temporary barrier, not a complete Markdown parser. HTML and
    // reference definitions may carry destinations the inline mapper cannot see.
    if (/<[!/?a-z]/iu.test(text) || /^ {0,3}\[[^\]\n]+\]:/mu.test(text)) {
      throw new Error('HTML and reference-style Markdown need parser-backed scope mapping before team sync');
    }
    text = text.replace(/\[\[([^\]]+)\]\]/gu, (whole, inner) => {
      const split = inner.indexOf('|');
      const target = split < 0 ? inner : inner.slice(0, split);
      return `[[${this.mapReferenceTarget(target, direction, sourcePath)}${split < 0 ? '' : inner.slice(split)}]]`;
    });
    text = text.replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^\s)]+)([^)]*\))/gu, (whole, prefix, wrappedTarget, suffix) => {
      const wrapped = wrappedTarget.startsWith('<') && wrappedTarget.endsWith('>');
      const target = wrapped ? wrappedTarget.slice(1, -1) : wrappedTarget;
      const mapped = this.mapReferenceTarget(target, direction, sourcePath);
      return `${prefix}${wrapped ? `<${mapped}>` : mapped}${suffix}`;
    });
    return new TextEncoder().encode(text);
  }
  mapCanvas(data, direction, sourcePath) {
    let canvas;
    try { canvas = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { throw new Error('Canvas JSON is invalid; sync was stopped before sharing it'); }
    if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || (canvas.nodes !== undefined && !Array.isArray(canvas.nodes))) {
      throw new Error('Canvas structure is invalid; sync was stopped before sharing it');
    }
    const mapFile = path => {
      if (typeof path !== 'string') throw new Error('Canvas contains an invalid file reference');
      if (direction === 'remote') {
        if (!isWithinFolder(path, this.scopePath)) throw new Error('Canvas references a file outside the selected team folder; remove or replace it before syncing');
        const relative = path.slice(this.scopePath.length + 1);
        validatePath(relative);
        if (isExcluded(relative)) throw new Error('Canvas contains a reserved file reference');
        return relative;
      }
      validatePath(path);
      if (isExcluded(path)) throw new Error('Canvas contains a reserved file reference');
      return `${this.scopePath}/${path}`;
    };
    for (const node of canvas.nodes || []) {
      if (node?.type === 'file') node.file = mapFile(node.file);
      else if (node?.type === 'group' && node.background) node.background = mapFile(node.background);
      else if (node?.type === 'text' && typeof node.text === 'string') {
        node.text = new TextDecoder().decode(this.mapMarkdown(new TextEncoder().encode(node.text), direction, sourcePath));
      } else if (node?.type === 'link' && /^file:/iu.test(node.url || '')) {
        throw new Error('Canvas contains a local file URL that cannot be shared safely');
      }
    }
    return new TextEncoder().encode(`${JSON.stringify(canvas, null, 2)}\n`);
  }
  conflictPath(path, hash) {
    validatePath(path);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Некорректная версия конфликта.');
    return `.easy-sync/conflicts/${hash}/${path}`;
  }
  async writeConflict(path, hash, data) {
    const target = this.conflictPath(path, hash), value = bytes(data);
    if (await this.vault.adapter.exists(target)) {
      const current = bytes(await this.vault.adapter.readBinary(target));
      if (await sha256(current) !== hash) throw new Error('Локальная копия конфликта занята другими данными.');
      return target;
    }
    await this.folders(target, true);
    await this.vault.adapter.writeBinary(target, value.slice().buffer);
    const saved = bytes(await this.vault.adapter.readBinary(target));
    if (await sha256(saved) !== hash) throw new Error('Не удалось проверить локальную копию конфликта.');
    return target;
  }
  async readConflict(path, hash) {
    const target = this.conflictPath(path, hash);
    if (!await this.vault.adapter.exists(target)) return null;
    const data = bytes(await this.vault.adapter.readBinary(target));
    if (await sha256(data) !== hash) throw new Error('Локальная копия конфликта повреждена.');
    return data;
  }
  async folders(path, hidden = false) {
    const parts = path.split('/').slice(0, -1);
    let parent = '';
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (await this.vault.adapter.exists(parent)) continue;
      try { if (hidden) await this.vault.adapter.mkdir(parent); else await this.vault.createFolder(parent); }
      catch (error) { if (!await this.vault.adapter.exists(parent)) throw error; }
    }
  }
  async backup(path, data) {
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    await this.vault.adapter.writeBinary(target, bytes(data).slice().buffer);
    if (await sha256(await this.vault.adapter.readBinary(target)) !== await sha256(data)) throw new Error('Не удалось проверить резервную копию.');
  }
  async writeIfUnchanged(path, data, expectedHash) {
    validatePath(path);
    if (isExcluded(path)) throw new Error('Запись в служебную папку запрещена.');
    const localPath = this.localPath(path);
    let file = this.vault.getFileByPath(localPath);
    const current = await this.read(path);
    if ((current === null ? null : await sha256(current)) !== expectedHash) return false;
    if (current !== null && await sha256(data) === expectedHash) return true;
    const rawCurrent = file ? bytes(await this.vault.readBinary(file)) : null;
    let localData = bytes(data);
    if (this.scopePath && (path.toLowerCase().endsWith('.canvas') || file?.extension === 'canvas')) localData = this.mapCanvas(data, 'local', localPath);
    else if (this.scopePath && (path.toLowerCase().endsWith('.md') || file?.extension === 'md')) localData = this.mapMarkdown(data, 'local', localPath);
    if (!file) {
      await this.folders(localPath);
      if (await this.vault.adapter.exists(localPath)) return false;
      try { await this.vault.createBinary(localPath, localData.slice().buffer); }
      catch (error) { if (this.vault.getFileByPath(localPath)) return false; throw error; }
      return true;
    }
    await this.backup(path, rawCurrent);
    if (file.extension === 'md') {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const oldText = decoder.decode(rawCurrent), newText = decoder.decode(localData);
      let changed = false;
      await this.vault.process(file, text => {
        if (text !== oldText) return text;
        changed = true;
        return newText;
      });
      return changed;
    }
    // A displayed binary may be edited by another plugin: defer replacement.
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    const recovery = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(recovery, true);
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    // Preserve the actual file, including an edit arriving after the hash check.
    await this.vault.rename(file, recovery);
    try { await this.vault.createBinary(localPath, localData.slice().buffer); }
    catch (error) {
      if (!await this.vault.adapter.exists(localPath)) await this.vault.rename(file, localPath);
      return false;
    }
    return true;
  }
  async removeIfUnchanged(path, expectedHash) {
    validatePath(path);
    const localPath = this.localPath(path);
    if (isExcluded(path) || this.app.workspace.getActiveFile()?.path === localPath) return false;
    const current = await this.read(path);
    if (current === null) return true;
    if (await sha256(current) !== expectedHash) return false;
    // Moving the actual current file into recovery retains late changes too.
    const file = this.vault.getFileByPath(localPath);
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    if (this.app.workspace.getActiveFile()?.path === localPath) return false;
    await this.vault.rename(file, target);
    return true;
  }
}
module.exports = { DeviceState, LocalVault };
