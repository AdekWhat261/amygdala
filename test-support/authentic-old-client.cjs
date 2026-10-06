'use strict';
// Frozen authentic beta7 artifact; never uses the caller's vault or authorization.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const file = path.join(__dirname, '../test-fixtures/authentic-beta7-main.js');
const bytes = fs.readFileSync(file);
const expected = 'cd377c8db0c9df6965d648d5b439fd52f88f37d5d5be9c627d81e07c43b65db4';
if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Authentic beta7 fixture SHA-256 mismatch');
const footer = "module.exports=load('main.cjs');";
const source = bytes.toString('utf8');
if (source.split(footer).length !== 2) throw new Error('Unexpected authentic beta7 bundle format');
const context = vm.createContext({ module: { exports: {} }, console, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, URL, URLSearchParams, btoa, atob, structuredClone,
  crypto: crypto.webcrypto, setTimeout, clearTimeout,
  require: () => { throw new Error('Old client fixture cannot import a runtime integration'); } });
vm.runInContext(source.replace(footer, 'module.exports={load};'), context, { timeout: 1000 });
module.exports = context.module.exports.load('team-sharded-store.cjs');
