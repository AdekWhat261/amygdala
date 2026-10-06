'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PUBLIC_FILES, PINNED_FILES, scanText, inventoryPublicSource, exportPublicSource } = require('../scripts/public-source-export.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), temp = fs.mkdtempSync(path.join(parent, 'amygdala-public-source-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(temp)), parent);
    assert.ok(path.basename(temp).startsWith('amygdala-public-source-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'candidate'), output = path.join(temp, 'public');
  fs.mkdirSync(root);
  for (const name of PUBLIC_FILES) {
    const destination = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (PINNED_FILES[name]) fs.copyFileSync(path.join(__dirname, '..', ...name.split('/')), destination);
    else fs.writeFileSync(destination, `// synthetic public file: ${name}\n`);
  }
  return { root, output, temp };
}

test('exports only exact allowlisted files with stable hashes and no directory enumeration', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.local-preparation'));
  fs.writeFileSync(path.join(f.root, '.local-preparation/private.fixture'), 'synthetic excluded contents');
  fs.writeFileSync(path.join(f.root, 'src/unreviewed.cjs'), 'synthetic excluded module');
  const enumerate = fs.readdirSync, read = fs.readFileSync;
  fs.readdirSync = () => { throw new Error('Directory enumeration is forbidden'); };
  fs.readFileSync = function(filename, ...args) {
    assert.ok(!/private\.fixture|unreviewed\.cjs/.test(String(filename)));
    return read.call(this, filename, ...args);
  };
  let report;
  try { report = exportPublicSource(f); } finally { fs.readdirSync = enumerate; fs.readFileSync = read; }
  assert.equal(report.fileCount, PUBLIC_FILES.length);
  assert.equal(inventoryPublicSource(f.root).sourceFingerprint, report.sourceFingerprint);
  assert.equal(fs.existsSync(path.join(f.output, '.local-preparation')), false);
  assert.equal(fs.existsSync(path.join(f.output, 'src/unreviewed.cjs')), false);
  assert.ok(fs.existsSync(path.join(f.output, 'PUBLIC_SOURCE_MANIFEST.json')));
  assert.ok(!JSON.stringify(report).includes(f.temp));
});

test('pin mismatch stops before output creation', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'test-fixtures/authentic-beta7-main.js'), '\n// changed fixture\n');
  assert.throws(() => exportPublicSource(f), /Pinned public fixture changed/);
  assert.equal(fs.existsSync(f.output), false);
});

test('scanner reports categories/lines without leaking matched credential or private path', t => {
  const f = fixture(t), secret = 'ghp_' + 'A'.repeat(36);
  fs.writeFileSync(path.join(f.root, 'src/main.cjs'), `const unexpected = '${secret}';`);
  let error; try { exportPublicSource(f); } catch (caught) { error = caught; }
  assert.ok(error); assert.equal(error.findings[0].kind, 'provider-token');
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(fs.existsSync(f.output), false);
  const privatePath = 'C:' + String.raw`\Users\private-person\notes`;
  assert.ok(scanText(privatePath).some(item => item.kind === 'private-home-path'));
});

test('existing output and vault destination are refused without changing them', t => {
  const f = fixture(t);
  fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'keep'), 'unchanged');
  assert.throws(() => exportPublicSource(f), /already exists/);
  assert.equal(fs.readFileSync(path.join(f.output, 'keep'), 'utf8'), 'unchanged');
  const vault = path.join(f.temp, 'synthetic-vault'); fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  assert.throws(() => exportPublicSource({ root: f.root, output: path.join(vault, 'export') }), /outside Obsidian vaults/);
});
