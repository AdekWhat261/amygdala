'use strict';
// Local preparation only. No recursive file discovery, publishing, or installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ASSETS = Object.freeze(['main.js', 'manifest.json', 'styles.css']);
const SOURCE_FILES = Object.freeze(['build.cjs', 'package.json', 'manifest.json', 'versions.json', 'styles.css']);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function plainPath(filename, { allowMissing = false } = {}) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links/junctions are not allowed: ${current}`);
  }
  return absolute;
}

function assertOutsideVault(directory) {
  let current = path.resolve(directory);
  for (;;) {
    if (path.basename(current).toLowerCase() === '.obsidian' || fs.existsSync(path.join(current, '.obsidian')))
      throw new Error('Preparation paths must be outside an Obsidian vault');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readFile(filename) {
  plainPath(filename);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Missing, oversized, or non-file input: ${filename}`);
  return fs.readFileSync(filename);
}

function readJson(filename) { return JSON.parse(readFile(filename).toString('utf8')); }

function inventory(root) {
  const sourceDir = plainPath(path.join(root, 'src'));
  // Inspect immediate source module names only, matching the existing bundler.
  // Never descend into work/, regression/, .local-preparation/, or user storage.
  const modules = fs.readdirSync(sourceDir).filter(name => name.endsWith('.cjs')).sort();
  if (!modules.length || modules.length > 128) throw new Error('Source inventory must contain 1–128 immediate .cjs modules');
  const names = [...SOURCE_FILES, ...modules.map(name => `src/${name}`)].sort();
  return names.map(name => {
    const bytes = readFile(path.join(root, ...name.split('/')));
    return { path: name, bytes: bytes.length, sha256: hash(bytes) };
  });
}

function validateManifests(root, dist) {
  const pkg = readJson(path.join(root, 'package.json'));
  const source = readJson(path.join(root, 'manifest.json'));
  const manifest = readJson(path.join(dist, 'manifest.json'));
  const versions = readJson(path.join(root, 'versions.json'));
  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  for (const value of [source, manifest]) {
    if (value.id !== 'amygdala-connection') throw new Error('Manifest id must be amygdala-connection');
    if (!versionPattern.test(value.version || '') || value.version !== pkg.version)
      throw new Error('Manifest/package version mismatch');
    if (value.isDesktopOnly !== false) throw new Error('Manifest must declare isDesktopOnly=false');
    if (!/^\d+\.\d+\.\d+$/.test(value.minAppVersion || '') || versions[value.version] !== value.minAppVersion)
      throw new Error('Invalid minAppVersion or versions map mismatch');
  }
  if (!readFile(path.join(root, 'manifest.json')).equals(readFile(path.join(dist, 'manifest.json'))))
    throw new Error('Built manifest differs from the source manifest');
  if (!readFile(path.join(root, 'styles.css')).equals(readFile(path.join(dist, 'styles.css'))))
    throw new Error('Built styles differ from the source styles');
  return { pkg, manifest };
}

function prepareRelease({ root = path.resolve(__dirname, '..'), dist, output, build = false } = {}) {
  if (!output || !path.isAbsolute(output)) throw new Error('Select an explicit absolute --output folder outside the vault');
  root = plainPath(root);
  dist = plainPath(dist || path.join(root, 'dist'), { allowMissing: build });
  output = plainPath(output, { allowMissing: true });
  for (const directory of [root, dist, output]) assertOutsideVault(directory);
  if (inside(root, output) || inside(dist, output) || inside(output, root) || inside(output, dist))
    throw new Error('Output must be separate from the source and dist folders');
  if (fs.existsSync(output)) throw new Error('Output already exists; select a new folder');
  if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('Output parent must already exist');
  if (build && dist !== path.join(root, 'dist')) throw new Error('--build uses only the existing build.cjs and root/dist');
  const before = inventory(root);
  if (build) {
    const pkg = readJson(path.join(root, 'package.json'));
    if (pkg.engines?.node !== process.versions.node) throw new Error('Build requires the exact package.engines.node runtime');
    const result = spawnSync(process.execPath, [path.join(root, 'build.cjs')], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Local build failed (exit ${result.status ?? 'unavailable'})`);
  }
  const { manifest } = validateManifests(root, dist);
  const assets = ASSETS.map(name => {
    const bytes = readFile(path.join(dist, name));
    if (!bytes.length) throw new Error(`Required asset is empty: ${name}`);
    return { name, bytes, sha256: hash(bytes) };
  });
  const sourceInventory = inventory(root);
  if (JSON.stringify(before) !== JSON.stringify(sourceInventory)) throw new Error('Source changed during preparation; rerun after edits finish');
  // Exclusive creation: an existing destination is never merged or overwritten.
  fs.mkdirSync(output);
  for (const asset of assets) fs.writeFileSync(path.join(output, asset.name), asset.bytes, { flag: 'wx' });
  const sums = assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join('');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sums, { flag: 'wx' });
  for (const asset of assets) {
    if (hash(readFile(path.join(output, asset.name))) !== asset.sha256) throw new Error('Output read-back hash mismatch');
  }
  if (readFile(path.join(output, 'SHA256SUMS.txt')).toString('utf8') !== sums) throw new Error('Checksum file read-back mismatch');
  validateManifests(root, output);
  if (JSON.stringify(sourceInventory) !== JSON.stringify(inventory(root))) throw new Error('Source changed during copy; output is not approved');
  return {
    status: 'PREPARED_LOCAL_ONLY', mode: build ? 'built' : 'already-built', output,
    id: manifest.id, version: manifest.version, minAppVersion: manifest.minAppVersion,
    assets: assets.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })),
    sourceInventory, sourceFingerprint: hash(JSON.stringify(sourceInventory)),
    provenance: build ? 'Built with the recorded source inventory and pinned Node runtime.'
      : 'Dist was supplied; source inventory is recorded, but correspondence to main.js is not established by this mode.',
    limits: 'No publication, installation, Google login, migration, or real device acceptance was performed. No source files or user data are copied.'
  };
}

function argumentsToOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--build') { options.build = true; continue; }
    if (!['--root', '--dist', '--output'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Usage: node scripts/release-package.cjs --output ABSOLUTE_NEW_FOLDER [--build] [--root SOURCE] [--dist DIST]');
    options[arg.slice(2)] = args[++i];
  }
  return options;
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(prepareRelease(argumentsToOptions(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`Release preparation failed: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { ASSETS, inventory, prepareRelease, argumentsToOptions };
