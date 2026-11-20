import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedResourceClient } from '../src/managed-resource-client.mjs';

const permit = claims => `drp1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${'a'.repeat(64)}`;

test('managed resource client projects a v2 memory partition from the permit', async () => {
  let sent;
  const client = createManagedResourceClient({
    runtime: {
      identity: { agentId: 'xw-test', versionId: 'ver-1', manifestSha256: 'a'.repeat(64) },
      declaration: { resources: { memory: { id: 'mem-abc123' } } },
    },
    env: { AGENTENGINE_RESOURCE_SERVER_URL: 'https://resource.example/', AGENTKIT_RUNTIME_TOKEN: 'token' },
    getResourcePermit: () => permit({
      format: 'agentengine.dsh-memory-permit/v2', agent_id: 'xw-test', version_id: 'ver-1',
      manifest_sha256: 'a'.repeat(64), memory_id: 'mem-abc123', partition_version: 'v2',
      resource_account_id: '1234567890', subject_ref: 'aeu_c36aa5cba663b1a16fbb7dad207132f693553d0ca8767c4e1b089ea94efe0d43',
      subject_digest: 'b'.repeat(64), issued_at: 1, expires_at: 9999999999, nonce: 'c'.repeat(32), account_id: '1234567890',
    }),
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ Code: 0, Data: { Memories: [] }, RequestId: 'req-1' }), { status: 200 });
    },
  });
  await client.action('QueryMemorySdk', { MemoryCollectionId: 'mem-abc123', AgentUserId: 'legacy', Query: 'hello' });
  assert.equal(sent.AgentUserId, 'mp1-c101faf3891929df05f0eddbc9e8ce40');
});
