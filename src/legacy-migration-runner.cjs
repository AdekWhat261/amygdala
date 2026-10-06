'use strict';
const { canonical, classifyMigrationProgress } = require('./legacy-migration-preview.cjs');

function requireReady({ approved, syncPaused, adapter, expectedFingerprint, scopePath }) {
  if (approved !== true) throw new Error('Explicit migration approval is required');
  if (syncPaused !== true) throw new Error('All participants must be paused before migration metadata changes');
  if (!adapter || typeof adapter.readSnapshot !== 'function' || typeof adapter.readManifest !== 'function'
    || typeof adapter.readEventFingerprint !== 'function' || typeof adapter.writeManifest !== 'function') throw new Error('Migration adapter is incomplete');
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('Fresh preview fingerprint is required');
  if (typeof scopePath !== 'string' || !scopePath) throw new Error('Selected shared folder path is required');
}

async function fresh(adapter, scopePath, eventFingerprint) {
  const snapshot = await adapter.readSnapshot();
  if (!snapshot?.stableSnapshot || !snapshot.eventFingerprint) throw new Error('A stable read-only project snapshot is required');
  if (eventFingerprint && snapshot.eventFingerprint !== eventFingerprint) throw new Error('Concurrent project history change detected; stopping before the next manifest update');
  const progress = classifyMigrationProgress({ root: snapshot.root, shards: snapshot.shards, events: snapshot.events, scopePath });
  return { snapshot, progress };
}

async function guardedWrite(adapter, id, current, target, expectedEventFingerprint) {
  const before = await adapter.readManifest(id);
  if (canonical(before) === canonical(target)) return false;
  if (canonical(before) !== canonical(current)) throw new Error('Manifest changed concurrently; no update was attempted for this sheet');
  if (await adapter.readEventFingerprint() !== expectedEventFingerprint) throw new Error('Concurrent project history change detected; no manifest update was attempted');
  await adapter.writeManifest(id, current, target);
  const after = await adapter.readManifest(id);
  if (canonical(after) !== canonical(target)) throw new Error('Manifest read-back mismatch; migration is paused in a fail-closed state');
  if (await adapter.readEventFingerprint() !== expectedEventFingerprint) throw new Error('Project history changed during manifest update; migration stopped for review');
  return true;
}

/** Explicitly gated, shard-first/root-last migration executor. Caller supplies the authenticated adapter. */
async function executeSchema2Migration(options = {}) {
  requireReady(options);
  const { adapter, scopePath, expectedFingerprint } = options;
  let { snapshot, progress } = await fresh(adapter, scopePath);
  if (snapshot.fingerprint !== expectedFingerprint) throw new Error('Project differs from the approved preview; rerun preview and request approval');
  if (progress.state === 'complete') return Object.freeze({ state: 'complete', writes: 0, eventFingerprint: snapshot.eventFingerprint });
  if (!progress.plan) throw new Error('Migration target could not be reconstructed safely');
  const plan = progress.plan;
  let eventFingerprint = snapshot.eventFingerprint, writes = 0;

  for (let index = 0; index < plan.shardManifests.length; index++) {
    ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
    const target = plan.shardManifests[index], source = progress.sourceShards[index];
    const current = snapshot.shards[index];
    if (canonical(current) === canonical(target)) continue;
    if (canonical(current) !== canonical(source)) throw new Error('Shard does not match source or target; migration stopped');
    writes += Number(await guardedWrite(adapter, target.shardId, source, target, eventFingerprint));
    ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
  }

  ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
  if (progress.state !== 'partial' && progress.state !== 'source') throw new Error('Shard state changed before root commit');
  writes += Number(await guardedWrite(adapter, plan.rootManifest.rootId, progress.sourceRoot, plan.rootManifest, eventFingerprint));
  ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
  if (progress.state !== 'complete') throw new Error('Root commit did not produce a complete migration');
  return Object.freeze({ state: 'complete', writes, eventFingerprint: snapshot.eventFingerprint });
}

/** Restores shards first and the quarantine-bearing root last; partial rollback stays classifiable and fail-closed. */
async function rollbackSchema2Migration(options = {}) {
  requireReady(options);
  const { adapter, scopePath, expectedFingerprint } = options;
  let { snapshot, progress } = await fresh(adapter, scopePath);
  if (snapshot.fingerprint !== expectedFingerprint) throw new Error('Project differs from the approved rollback preview');
  if (!progress.canRollbackWithoutDataLoss) throw new Error('Rollback is unsafe after any project-relative event has been written');
  if (progress.state === 'source') return Object.freeze({ state: 'source', writes: 0 });
  let writes = 0, eventFingerprint = snapshot.eventFingerprint;
  for (let index = progress.sourceShards.length - 1; index >= 0; index--) {
    const current = snapshot.shards[index], source = progress.sourceShards[index];
    if (current.schema === 2) continue;
    const target = source;
    writes += Number(await guardedWrite(adapter, target.shardId, current, target, eventFingerprint));
    ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
    if (!progress.canRollbackWithoutDataLoss) throw new Error('Rollback stopped after concurrent project history changed');
  }
  if (snapshot.root.schema === 3) {
    writes += Number(await guardedWrite(adapter, progress.sourceRoot.rootId, snapshot.root, progress.sourceRoot, eventFingerprint));
    ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
  }
  ({ snapshot, progress } = await fresh(adapter, scopePath, eventFingerprint));
  if (progress.state !== 'source') throw new Error('Rollback read-back did not restore all schema 2 manifests');
  return Object.freeze({ state: 'source', writes, eventFingerprint: snapshot.eventFingerprint });
}

module.exports = { executeSchema2Migration, rollbackSchema2Migration };
