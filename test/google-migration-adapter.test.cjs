'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleMigrationAdapter } = require('../src/google-migration-adapter.cjs');

test('Google migration adapter blocks migration, rollback, stale and outside-project writes without remote calls', async () => {
  let requests = 0, reads = 0;
  const store = {
    rootId: 'root_12345678',
    async manifestFor() { reads++; throw new Error('Unexpected manifest read'); },
    async call() { requests++; throw new Error('Unexpected remote call'); }
  };
  const adapter = createGoogleMigrationAdapter({ store, scopePath: 'Shared' });
  for (const [id, expected, target] of [
    ['root_12345678', { schema: 2 }, { schema: 3 }],
    ['shard_12345678', { schema: 2 }, { schema: 3 }],
    ['root_12345678', { schema: 3 }, { schema: 2 }],
    ['shard_12345678', { schema: 3 }, { schema: 2 }],
    ['shard_12345678', { schema: 2, index: 9 }, { schema: 3 }],
    ['other_12345678', {}, {}]
  ]) {
    await assert.rejects(adapter.writeManifest(id, expected, target), /Migration writes are disabled/);
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test('blocked Google migration adapter retains read-only manifest access', async () => {
  const rootId = 'root_12345678', manifest = { schema: 2, shardIds: [] };
  let reads = 0, requests = 0;
  const store = {
    rootId,
    async manifestFor(id) { assert.equal(id, rootId); reads++; return structuredClone(manifest); },
    async call() { requests++; throw new Error('Unexpected remote call'); }
  };
  const adapter = createGoogleMigrationAdapter({ store, scopePath: 'Shared' });
  assert.deepEqual(await adapter.readManifest(rootId), manifest);
  assert.equal(reads, 1);
  assert.equal(requests, 0);
});
