import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { parseManagedRuntimeManifest } from '../src/managed-runtime-manifest.mjs';
import { managedResourceBindings } from '../src/managed-resource-contract.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';

for (const profile of ['dsh-native', 'harness', 'codex']) test(`${profile} YAML direct MCPs use real HTTP/SSE with scoped credentials and no GetMCP`, async t => {
  const values = { MCP_HTTP_TOKEN: 'synthetic-http-one', MCP_SSE_TOKEN: 'synthetic-sse-one' };
  const http = await createMcpLoopbackService({ transport: 'http', getCredential: () => values.MCP_HTTP_TOKEN });
  const sse = await createMcpLoopbackService({ transport: 'sse', getCredential: () => values.MCP_SSE_TOKEN });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async name => ({ value: values[name] || '' }) },
    serverClient: { action: async () => { throw new Error('Direct MCP must not call a platform resource API'); } } });
  t.after(async () => { await adapters.close(); await Promise.all([http.close(), sse.close()]); });
  const declaration = { name: 'direct-mcp-fixture', framework: profile, artifact_type: 'ManagedRuntime',
    runtime: { name: profile, version: 'fixture-1' }, model: 'fixture-model', prompt: '', resources: {
      mcp_servers: [{ id: 'direct-http', endpoint: http.endpoint, env_refs: { Authorization: 'MCP_HTTP_TOKEN' } },
        { id: 'direct-sse', endpoint: sse.endpoint, transport: 'sse', env_refs: { Authorization: 'MCP_SSE_TOKEN' } }],
    } };
  const parsed = parseManagedRuntimeManifest(stringify(declaration), { runtimeName: profile, runtimeVersion: 'fixture-1' });
  const bindings = managedResourceBindings(parsed.resources);
  assert.deepEqual(bindings.mcpServers[0], { resourceId: 'direct-http', endpointUrl: http.endpoint, transport: 'http', envRefs: { Authorization: 'MCP_HTTP_TOKEN' } });
  const prepared = await prepareLocalResourceContext({ record: { spec: { runtime: { type: profile }, bindings } }, resourceAdapter: adapters });
  assert.deepEqual(prepared.tools.map(tool => tool.name), [http.toolName, sse.toolName]);
  for (const [index, service] of [http, sse].entries()) {
    const result = await adapters.callMcpTool(prepared.tools[index]._resourceId, service.toolName, {});
    assert.equal(result[0].text, service.receipt);
    assert.equal(service.counts.called, 1);
    assert.equal(service.counts.authenticated, service.counts.requests);
  }
  values.MCP_HTTP_TOKEN = 'synthetic-http-two';
  assert.equal((await adapters.callMcpTool(bindings.mcpServers[0], http.toolName, {}))[0].text, http.receipt);
  assert.equal(http.counts.called, 2);
  assert.equal(http.counts.initialized, 2, 'changed credentials must reconnect the client');
  delete values.MCP_HTTP_TOKEN;
  const before = http.counts.called;
  await assert.rejects(adapters.callMcpTool(bindings.mcpServers[0], http.toolName, {}), { code: 'MCP_CREDENTIAL_MISSING' });
  assert.equal(http.counts.called, before, 'missing current credentials must not reuse a cached authenticated client');
  assert.ok(!JSON.stringify(parsed).includes('synthetic-http-one'));
});
