'use strict';
const { sha256, bytes } = require('./drive.cjs');
const { validatePath, isExcluded } = require('./planner.cjs');

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
      const migrated = { baseline: stored.baseline || {}, outbox: stored.outbox };
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
    return { baseline: stored.baseline || {}, outbox: ids.map(id => byId.get(id)) };
  }
  async save(state) {
    const db = await this.db();
    const outbox = Array.isArray(state.outbox) ? state.outbox : [];
    const ids = outbox.map(item => item?.event?.id);
    if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Локальная очередь синхронизации повреждена.');
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'outbox'], 'readwrite');
      tx.objectStore('state').put({ baseline: state.baseline || {}, outboxIds: ids }, 'current');
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
  constructor(app) { this.app = app; this.vault = app.vault; }
  async scan() {
    const hashes = Object.create(null);
    for (const file of this.vault.getFiles()) {
      if (isExcluded(file.path)) continue;
      validatePath(file.path);
      if (file.stat.size > 100 * 1024 * 1024) throw new Error(`Файл больше 100 МБ: ${file.path}. Эта версия пока его не поддерживает.`);
      const data = await this.read(file.path);
      if (data !== null) hashes[file.path] = await sha256(data);
    }
    return hashes;
  }
  async read(path) {
    validatePath(path);
    const file = this.vault.getFileByPath(path);
    if (!file) return null;
    return bytes(await this.vault.readBinary(file));
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
    let file = this.vault.getFileByPath(path);
    const current = await this.read(path);
    if ((current === null ? null : await sha256(current)) !== expectedHash) return false;
    if (current !== null && await sha256(data) === expectedHash) return true;
    if (!file) {
      await this.folders(path);
      if (await this.vault.adapter.exists(path)) return false;
      try { await this.vault.createBinary(path, bytes(data).slice().buffer); }
      catch (error) { if (this.vault.getFileByPath(path)) return false; throw error; }
      return true;
    }
    await this.backup(path, current);
    if (file.extension === 'md') {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const oldText = decoder.decode(current), newText = decoder.decode(data);
      let changed = false;
      await this.vault.process(file, text => {
        if (text !== oldText) return text;
        changed = true;
        return newText;
      });
      return changed;
    }
    // A displayed binary may be edited by another plugin: defer replacement.
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    const recovery = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(recovery, true);
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    // Preserve the actual file, including an edit arriving after the hash check.
    await this.vault.rename(file, recovery);
    try { await this.vault.createBinary(path, bytes(data).slice().buffer); }
    catch (error) {
      if (!await this.vault.adapter.exists(path)) await this.vault.rename(file, path);
      return false;
    }
    return true;
  }
  async removeIfUnchanged(path, expectedHash) {
    validatePath(path);
    if (isExcluded(path) || this.app.workspace.getActiveFile()?.path === path) return false;
    const current = await this.read(path);
    if (current === null) return true;
    if (await sha256(current) !== expectedHash) return false;
    // Moving the actual current file into recovery retains late changes too.
    const file = this.vault.getFileByPath(path);
    const target = `.easy-sync/recovery/${Date.now()}-${globalThis.crypto.randomUUID()}/${path}`;
    await this.folders(target, true);
    const latest = await this.read(path);
    if (!latest || await sha256(latest) !== expectedHash) return false;
    if (this.app.workspace.getActiveFile()?.path === path) return false;
    await this.vault.rename(file, target);
    return true;
  }
}
module.exports = { DeviceState, LocalVault };
