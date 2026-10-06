'use strict';
// Explicit public code inventory. Never discover or read private runtime files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const groups = {
  '': ['.gitattributes', '.node-version', 'build.cjs', 'LICENSE', 'manifest.json', 'package.json', 'README.md', 'run-tests.cjs', 'styles.css', 'versions.json'],
  src: ['auth.cjs', 'backup-reader-verification.cjs', 'connection-status.cjs', 'drive.cjs', 'engine.cjs', 'fenced-migration.cjs',
    'google-access-check.cjs', 'google-locked-migration.cjs', 'google-migration-adapter.cjs', 'journal.cjs', 'legacy-migration-preview.cjs',
    'legacy-migration-remote-preview.cjs', 'legacy-migration-runner.cjs', 'legacy-quarantine.cjs', 'local.cjs', 'main.cjs',
    'locked-migration.cjs', 'locked-migration-snapshot.cjs', 'migration-coordination.cjs', 'planner.cjs', 'shadow-migration-plan.cjs', 'sheets-read-limiter.cjs', 'slot-fence.cjs',
    'team-plugins.cjs', 'team-sharded-store.cjs', 'team-sheet-store.cjs', 'verified-backup.cjs'],
  test: ['auth.test.cjs', 'backup-reader-verification.test.cjs', 'bridge.test.mjs', 'connection-status.test.cjs',
    'drive.test.cjs', 'engine.test.cjs', 'fenced-migration.test.cjs', 'google-access-check.test.cjs',
    'google-migration-adapter.test.cjs', 'independent-lifecycle-review.test.cjs', 'legacy-migration-old-client.test.cjs',
    'legacy-migration-preview.test.cjs', 'legacy-migration-remote-preview.test.cjs', 'legacy-migration-runner.test.cjs',
    'locked-migration.test.cjs', 'migration-apply-plugin.test.cjs', 'migration-preparation-plugin.test.cjs', 'mobile-lifecycle.test.cjs',
    'plugin.test.cjs', 'public-source-export.test.cjs', 'release-package.test.cjs', 'slot-fence.test.cjs',
    'team-sheet-store.test.cjs', 'verified-backup.test.cjs'],
  'test-support': ['authentic-old-client.cjs', 'restore-fixture.cjs', 'slot-fence-fixture.cjs', 'slot-lock-fixture.cjs'],
  regression: ['independent-v3-tests.cjs', 'independent-v4-cost-tests.cjs', 'independent-v4-extended-tests.cjs',
    'independent-v4-legacy-journal-test.cjs', 'safety-tests.cjs', 'v4-tests.cjs'],
  'test-fixtures': ['authentic-beta7-main.js'],
  'test-fixtures/public-v0.3.0-bridge': ['README.md', 'worker.mjs'],
  docs: ['DEVICE_ACCEPTANCE.md', 'PUBLIC_SOURCE.md'],
  scripts: ['release-package.cjs', 'public-source-export.cjs'],
  '.github/workflows': ['ci.yml', 'release.yml']
};
const PUBLIC_FILES = Object.freeze(Object.entries(groups).flatMap(([dir, names]) => names.map(name => dir ? `${dir}/${name}` : name)).sort());
const PINNED_FILES = Object.freeze({
  'test-fixtures/authentic-beta7-main.js': 'cd377c8db0c9df6965d648d5b439fd52f88f37d5d5be9c627d81e07c43b65db4',
  'test-fixtures/public-v0.3.0-bridge/worker.mjs': 'd3b5fb0e1eb7e8f60c43ad0bdd5139e48b7bfe73ca8080381d9c9005a369c304',
  'test-fixtures/public-v0.3.0-bridge/README.md': 'b802a6f4a9569af76dee85306654dc227779aee938d4412215e6034086ebe226'
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function safePath(filename) {
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Public source paths cannot contain symbolic links or junctions');
    if (stat.isFile() && stat.nlink > 1) throw new Error('Public source files cannot be hard links');
  }
  return absolute;
}
function outsideVault(directory) {
  for (let current = path.resolve(directory);;) {
    if (path.basename(current).toLowerCase() === '.obsidian' || fs.existsSync(path.join(current, '.obsidian')))
      throw new Error('Public export paths must be outside Obsidian vaults');
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function scanText(text) {
  const findings = [];
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['provider-token', /(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|ya29\.[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|1\/\/[A-Za-z0-9_-]{30,})/],
    ['private-home-path', /(?:[A-Za-z]:\\{1,2}(?:Users|Documents and Settings)\\|\/(?:Users|home)\/[A-Za-z0-9_.-]+\/)/],
    ['external-source-traversal', /\.\.[/\\]\.\.[/\\]\.\.[/\\]/],
    ['real-google-resource-url', /https:\/\/(?:docs\.google\.com\/spreadsheets\/d|drive\.google\.com\/drive\/folders)\/[A-Za-z0-9_-]{20,}/]
  ];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [kind, pattern] of rules) if (pattern.test(line)) findings.push({ kind, line: index + 1 });
    const credential = /(?:clientSecret|refreshToken|accessToken|password|apiKey)\s*[:=]\s*['"]([^'"]{16,})['"]/g;
    for (const match of line.matchAll(credential)) {
      if (!/fixture|synthetic|test|example|unused|placeholder|redacted/i.test(match[1]))
        findings.push({ kind: 'credential-literal', line: index + 1 });
    }
  });
  return findings;
}
function classification(name) {
  if (name === 'test-fixtures/authentic-beta7-main.js') return 'hash-pinned-authentic-client-source';
  if (name.startsWith('test-fixtures/public-')) return 'hash-pinned-public-bridge-source';
  if (/^(test|test-support|regression)\//.test(name)) return 'synthetic-test-code';
  if (name.startsWith('src/')) return 'production-source';
  if (name.startsWith('.github/')) return 'workflow';
  if (name.endsWith('.md')) return 'documentation';
  return 'build-or-package-metadata';
}
function inventoryPublicSource(root = path.resolve(__dirname, '..')) {
  root = safePath(root); outsideVault(root);
  const files = [], findings = [];
  for (const name of PUBLIC_FILES) {
    // Every filename is compiled into the allowlist. No directory enumeration.
    const filename = safePath(path.join(root, ...name.split('/'))), stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Public input is missing, oversized, or not a file: ${name}`);
    const bytes = fs.readFileSync(filename), digest = sha256(bytes);
    if (PINNED_FILES[name] && digest !== PINNED_FILES[name]) throw new Error(`Pinned public fixture changed: ${name}`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error(`Binary data is not an allowed public source: ${name}`);
    findings.push(...scanText(text).map(item => ({ path: name, ...item })));
    files.push({ path: name, bytes: bytes.length, sha256: digest, classification: classification(name) });
  }
  if (findings.length) {
    const error = new Error('Public export blocked by privacy or portability findings; values are not logged');
    error.findings = findings; throw error;
  }
  return { format: 'amygdala-public-source-inventory-v1', files, sourceFingerprint: sha256(JSON.stringify(files)),
    fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    scan: { findings: [], scope: 'explicit-source-allowlist', note: 'Static checks are not proof that arbitrary source contains no private information.' },
    excluded: ['local preparation', 'built distribution', 'work directories', 'runtime settings and auth stores', 'notes', 'archives', 'dependencies'],
    fixtureProvenance: { authenticBeta7Sha256: PINNED_FILES['test-fixtures/authentic-beta7-main.js'],
      publicBridge: 'https://github.com/AdekWhat261/amygdala/tree/v0.3.0/bridge' },
    execution: 'No build, tests, authentication, network, Git action, publication, or installation performed by this helper.' };
}
function exportPublicSource({ root = path.resolve(__dirname, '..'), output } = {}) {
  root = safePath(root);
  if (!output || !path.isAbsolute(output)) throw new Error('Select an explicit absolute new output directory');
  output = safePath(output); outsideVault(output);
  if (isInside(root, output) || isInside(output, root)) throw new Error('Public output must be separate from candidate source');
  if (fs.existsSync(output)) throw new Error('Public output already exists; no merging or overwriting is allowed');
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('Public output parent must exist');
  const inventory = inventoryPublicSource(root);
  const captured = inventory.files.map(item => {
    const bytes = fs.readFileSync(safePath(path.join(root, ...item.path.split('/'))));
    if (sha256(bytes) !== item.sha256) throw new Error('Source changed during public export; retry after edits finish');
    return { ...item, content: bytes };
  });
  fs.mkdirSync(output);
  for (const file of captured) {
    const target = path.join(output, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { flag: 'wx' });
    if (sha256(fs.readFileSync(target)) !== file.sha256) throw new Error(`Public copy read-back mismatch: ${file.path}`);
  }
  if (inventoryPublicSource(root).sourceFingerprint !== inventory.sourceFingerprint)
    throw new Error('Source changed during public export; this output is not approved');
  fs.writeFileSync(path.join(output, 'PUBLIC_SOURCE_MANIFEST.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    let inventoryOnly = false;
    for (let at = 0; at < args.length; at++) {
      if (args[at] === '--inventory') { inventoryOnly = true; continue; }
      if (!['--root', '--output'].includes(args[at]) || !args[at + 1] || args[at + 1].startsWith('--'))
        throw new Error('Usage: node scripts/public-source-export.cjs [--root SOURCE] (--inventory | --output ABSOLUTE_NEW_DIRECTORY)');
      options[args[at].slice(2)] = args[++at];
    }
    if (inventoryOnly && options.output) throw new Error('Choose inventory or export, not both');
    const report = inventoryOnly ? inventoryPublicSource(options.root) : exportPublicSource(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, findings: error.findings || [] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
module.exports = { PUBLIC_FILES, PINNED_FILES, scanText, inventoryPublicSource, exportPublicSource };
