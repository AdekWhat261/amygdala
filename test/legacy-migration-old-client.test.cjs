'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARAMS, digest, assertManifest: assertBeta1Manifest } = require('../src/team-sharded-store.cjs');
const { assertManifest: assertBeta7Manifest } = require('../test-support/authentic-old-client.cjs');

test('authentic beta7 and beta1 clients both fail closed on a mixed schema rollout', async () => {
  const rootId = 'root_12345678';
  const shardIds = Array.from({ length: 8 }, (_, i) => `shard_${String(i).padStart(2, '0')}_123`);
  const root = { schema: 2, type: 'amygdala-team-sharded', version: 4, rootId, name: 'fixture', vaultId: 'vault_12345678',
    folderId: 'folder_12345678', shardIds, params: PARAMS, paramsDigest: await digest(PARAMS) };
  const shards = shardIds.map((shardId, index) => ({ schema: 2, type: 'amygdala-team-sharded', version: 4,
    vaultId: root.vaultId, rootId, folderId: root.folderId, shardId, index, paramsDigest: root.paramsDigest }));
  const mixed = shards.map((shard, index) => index === 0 ? { ...shard, schema: 3,
    pathProtocol: 'project-relative-v1', namespace: rootId } : shard);
  assert.throws(() => assertBeta7Manifest(root, mixed, rootId));
  assert.throws(() => assertBeta1Manifest(root, mixed, rootId));
});
