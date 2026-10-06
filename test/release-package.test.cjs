'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareRelease } = require('../scripts/release-package.cjs');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amygdala-package-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source'), dist = path.join(root, 'dist'), output = path.join(temp, 'release');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  const manifest = { id: 'amygdala-connection', version: '0.4.1-beta.1', minAppVersion: '1.11.4', isDesktopOnly: false };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: manifest.version, engines: { node: process.versions.node } }));
  fs.writeFileSync(path.join(root, 'versions.json'), JSON.stringify({ [manifest.version]: manifest.minAppVersion }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'styles.css'), '/* synthetic styles */');
  fs.copyFileSync(path.join(root, 'styles.css'), path.join(dist, 'styles.css'));
  fs.writeFileSync(path.join(root, 'src/main.cjs'), "module.exports = 'synthetic';\n");
  fs.copyFileSync(path.join(root, 'src/main.cjs'), path.join(dist, 'main.js'));
  fs.writeFileSync(path.join(root, 'build.cjs'), "const fs=require('node:fs'); fs.copyFileSync('src/main.cjs','dist/main.js');\n");
  return { root, dist, output, temp, manifest };
}

test('packages exactly three assets and full SHA-256 checksums, with stable bounded source inventory', t => {
  const f = fixture(t), report = prepareRelease(f);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ['SHA256SUMS.txt', 'main.js', 'manifest.json', 'styles.css']);
  const sums = fs.readFileSync(path.join(f.output, 'SHA256SUMS.txt'), 'utf8');
  for (const asset of report.assets) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output, asset.name))).digest('hex');
    assert.equal(actual, asset.sha256);
    assert.ok(sums.includes(`${actual}  ${asset.name}\n`));
  }
  const again = prepareRelease({ ...f, output: path.join(f.temp, 'second-release') });
  assert.deepEqual(again.sourceInventory, report.sourceInventory);
  assert.equal(again.sourceFingerprint, report.sourceFingerprint);
  assert.match(report.provenance, /not established/);
});

test('ignores synthetic extra secrets and nested work content without opening them', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dist, 'synthetic-secret.txt'), 'NEVER_PACKAGE_SYNTHETIC_SECRET');
  fs.mkdirSync(path.join(f.dist, 'private'));
  fs.writeFileSync(path.join(f.dist, 'private/credentials.fixture'), 'SYNTHETIC_ONLY');
  for (const name of ['work', '.local-preparation', 'regression']) {
    fs.mkdirSync(path.join(f.root, name));
    fs.writeFileSync(path.join(f.root, name, 'private.fixture'), 'SYNTHETIC_ONLY');
  }
  const original = fs.readFileSync;
  fs.readFileSync = function(filename, ...args) {
    assert.ok(!/synthetic-secret|credentials\.fixture|private\.fixture/.test(String(filename)), 'Excluded files must never be read');
    return original.call(this, filename, ...args);
  };
  try {
    const report = prepareRelease(f);
    assert.ok(!JSON.stringify(report).includes('SYNTHETIC_ONLY'));
    assert.deepEqual(fs.readdirSync(f.output).sort(), ['SHA256SUMS.txt', 'main.js', 'manifest.json', 'styles.css']);
  } finally { fs.readFileSync = original; }
});

test('rejects mismatched package or versions-map versions before output creation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.throws(() => prepareRelease(f), /version mismatch/);
  assert.equal(fs.existsSync(f.output), false);
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: f.manifest.version }));
  fs.writeFileSync(path.join(f.root, 'versions.json'), JSON.stringify({ [f.manifest.version]: '1.0.0' }));
  assert.throws(() => prepareRelease(f), /versions map mismatch/);
});

test('rejects missing or empty required assets', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dist, 'styles.css'));
  assert.throws(() => prepareRelease(f), /ENOENT/);
  fs.copyFileSync(path.join(f.root, 'styles.css'), path.join(f.dist, 'styles.css'));
  fs.writeFileSync(path.join(f.dist, 'main.js'), '');
  assert.throws(() => prepareRelease(f), /asset is empty/);
  assert.equal(fs.existsSync(f.output), false);
});

test('rejects desktop-only, wrong id, stale manifest, and invalid minimum app version', t => {
  const f = fixture(t);
  for (const [patch, error] of [[{ isDesktopOnly: true }, /isDesktopOnly/], [{ id: 'other-plugin' }, /Manifest id/],
    [{ minAppVersion: 'invalid' }, /minAppVersion/], [{ version: '0.4.1-beta.2' }, /version mismatch/]]) {
    fs.writeFileSync(path.join(f.dist, 'manifest.json'), JSON.stringify({ ...f.manifest, ...patch }));
    assert.throws(() => prepareRelease(f), error);
  }
});

test('requires new explicit separate output outside detected vaults', t => {
  const f = fixture(t);
  assert.throws(() => prepareRelease({ ...f, output: 'relative-release' }), /explicit absolute/);
  assert.throws(() => prepareRelease({ ...f, output: path.join(f.root, 'release') }), /separate/);
  const vault = path.join(f.temp, 'synthetic-vault');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  assert.throws(() => prepareRelease({ ...f, output: path.join(vault, 'release') }), /outside an Obsidian vault/);
  fs.mkdirSync(f.output);
  fs.writeFileSync(path.join(f.output, 'keep.txt'), 'preserve');
  assert.throws(() => prepareRelease(f), /already exists/);
  assert.equal(fs.readFileSync(path.join(f.output, 'keep.txt'), 'utf8'), 'preserve');
});

test('can run the pinned local builder and rejects a different Node version', t => {
  const f = fixture(t);
  assert.equal(prepareRelease({ ...f, build: true }).mode, 'built');
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: f.manifest.version, engines: { node: '0.0.0' } }));
  assert.throws(() => prepareRelease({ ...f, build: true, output: path.join(f.temp, 'other-release') }), /exact package.engines.node/);
});
