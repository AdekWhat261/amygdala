'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
test('modal and settings share the V2 preparation and consent controls', () => {
  assert.equal((source.match(/p\.renderMigrationPreparation\(el,/g) || []).length, 2);
  assert.match(source, /createLockedMigrationMethods/);
  assert.doesNotMatch(source, /executeFencedMigration|probeGoogleFenceAtomicity|createGoogleFenceAdapter/);
});
