import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deleteStudioMcp } from '../src/resource-lifecycle.mjs';
import { createAgentEngineClient } from '../src/server-client.mjs';

test('cloud deletion reaches the tenant-scoped Action API and requires a positive acknowledgement', async t => {
  const requests = [];
  let response = { Code: 0, Data: { Deleted: true } };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, headers: req.headers, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const client = createAgentEngineClient({ configuration: { resolve: async () => ({ values: {
    cloudServerUrl: `http://127.0.0.1:${server.address().port}`, cloudAccountId: 'test-account', cloudServiceToken: 'test-only-service-token',
  } }) } });
  const services = { serverClient: client, localStore: { get: () => assert.fail('cloud delete must not modify local storage') } };
  const input = { resourceId: 'mcp-test-cloud', scope: 'cloud' };
  assert.deepEqual(await deleteStudioMcp(input, services), { ...input, deleted: true });
  assert.equal(requests[0].path, '/agentengine/api/v1/DeleteMCP');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { Id: input.resourceId });
  assert.equal(requests[0].headers['x-ksc-account-id'], 'test-account');
  assert.equal(requests[0].headers.authorization, 'Bearer test-only-service-token');
  response = { Code: 0, Data: { Deleted: false } };
  await assert.rejects(deleteStudioMcp(input, services), { code: 'MCP_DELETE_UNCONFIRMED' });
  response = { Code: 403, Message: 'private upstream detail' };
  await assert.rejects(deleteStudioMcp(input, services), error => error.code === 'SERVER_ACTION_FAILED' && !error.message.includes('private'));
  assert.equal(requests.length, 3, 'failed writes must not be automatically replayed');
});

test('local removal never falls through to cloud deletion when the record is missing', async () => {
  let removals = 0;
  const services = { localStore: { get: async id => id === 'mcp-local-present' ? {} : null, remove: async () => { removals += 1; return { deleted: true }; } }, serverClient: { action: () => assert.fail('cloud deletion needs explicit scope') } };
  assert.deepEqual(await deleteStudioMcp({ resourceId: 'mcp-local-present' }, services), { deleted: true });
  await assert.rejects(deleteStudioMcp({ resourceId: 'mcp-cloud-missing' }, services), { code: 'RESOURCE_NOT_FOUND' });
  assert.equal(removals, 1);
});

test('invalid identifiers and scopes cannot invoke a destructive operation', async () => {
  const services = { localStore: { get: () => assert.fail('invalid request read storage') }, serverClient: { action: () => assert.fail('invalid request reached cloud') } };
  for (const payload of [
    { resourceId: '', scope: 'cloud' }, { resourceId: 'x'.repeat(201), scope: 'cloud' },
    { resourceId: 'mcp-local-1234', scope: 'cloud' }, { resourceId: 'skill-test', scope: 'cloud' },
    { resourceId: 'mcp-test', scope: 'automatic' },
  ]) await assert.rejects(deleteStudioMcp(payload, services));
});
