'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('built plugin loads with public Obsidian API and remains offline until configured', async () => {
  let requests = 0;
  const local = new Map(), secrets = new Map(), commands = [];
  const element = () => ({ text: '', setText(t) { this.text = t; }, addClass() {}, addEventListener() {} });
  class Plugin {
    addRibbonIcon() {} addStatusBarItem() { return element(); }
    addCommand(command) { commands.push(command.id); } addSettingTab() {}
    registerInterval() {} registerObsidianProtocolHandler() {}
  }
  const obsidian = { Plugin, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, requestUrl: async () => { requests++; throw new Error('Unexpected network'); } };
  const context = vm.createContext({ module: { exports: {} }, require: id => { assert.equal(id, 'obsidian'); return obsidian; },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL, URLSearchParams, btoa,
    window: { setInterval() { return 1; } }, console });
  const source = fs.readFileSync(path.join(__dirname, '../dist/main.js'), 'utf8');
  vm.runInContext(source, context);
  const instance = new context.module.exports();
  instance.app = { loadLocalStorage: k => local.get(k), saveLocalStorage: (k,v) => local.set(k,v),
    secretStorage: { getSecret: k => secrets.get(k), setSecret: (k,v) => secrets.set(k,v) },
    workspace: { onLayoutReady: fn => fn() } };
  await instance.onload();
  assert.equal(requests, 0);
  assert.match(instance.label, /Подключите Google/);
  assert.deepEqual(commands.sort(), ['connect', 'link-personal-note', 'rebind-personal-note-link', 'resolve-conflicts', 'sync-now']);
  instance.onunload();
  assert.equal(instance.stopped, true);
});
