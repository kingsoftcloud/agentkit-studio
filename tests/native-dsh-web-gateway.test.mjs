import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { MemoryRunStore } from '@kingsoftcloud/agentkit-harness-core';
import { scope, fixture } from './fixtures/native-core.mjs';

async function setup(t, { environment = {}, names = ['web_fetch', 'web_search'], contracts = [], fetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-web-gateway-'));
  const workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  await mkdir(workspaceRoot);
  const registry = new Map(), pipeline = [];
  let denied = false, postFailed = false;
  const ctx = { effect: install => install(), tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    async execute(input) {
      pipeline.push({ phase: 'pre', name: input.name, callId: input.callId });
      if (denied) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
      const tool = registry.get(input.name);
      pipeline.push({ phase: 'around', name: input.name });
      const value = await tool.execute(input.arguments, input);
      pipeline.push({ phase: 'post', name: input.name });
      return { isError: postFailed, value, content: tool.output.render(input.arguments, value) };
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: names, toolContracts: contracts },
    workspaceRoot, stateDir, webEnvironment: environment, ...(fetch ? { webFetch: fetch } : {}) });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const agent = { session: { id: 'session' } }, authority = { scope, store: new MemoryRunStore() };
  const seeded = fixture();
  authority.store.create(seeded.config, seeded.snapshot);
  const port = gateway.forAgent(agent, authority).tools;
  let sequence = 0;
  function request(name, args, overrides = {}) {
    sequence++;
    return { scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null,
      taskChainId: 'chain', operationKey: `tool:${sequence}`, executionFence: 1,
      signal: new AbortController().signal,
      definition: gateway.definitions(agent, [...registry.values()]).find(item => item.name === name),
      call: { callId: `call-${sequence}`, name, arguments: args }, ...overrides };
  }
  return { gateway, agent, authority, port, request, stateDir, pipeline, registry,
    deny: () => { denied = true; }, postFail: () => { postFailed = true; } };
}

async function serve(t, respond) {
  const server = createServer(respond);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Native Web uses the registered pipeline and persists overflow in its actual scoped artifact store', async t => {
  let hits = 0;
  const url = await serve(t, (_request, response) => {
    hits++; response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<main>你好😀 <b>world</b></main><script>private()</script>');
  });
  const host = await setup(t, { environment: { KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' } });
  const result = await host.port.execute(host.request('web_fetch', { url, max_chars: 3 }));
  assert.equal(result.status, 'ok'); assert.equal(hits, 1);
  assert.equal(result.content.text, '你好😀'); assert.equal(result.content.truncated, true);
  assert.equal(result.content.ok, true);
  assert.deepEqual(host.pipeline.map(item => item.phase), ['pre', 'around', 'post']);
  assert.ok(result.content.persisted?.path, 'a full-output artifact was actually sealed');
  const artifacts = await createNativeArtifactStore({ directory: join(host.stateDir, 'web-artifacts'), scope });
  const matches = await artifacts.search({ scope, runId: 'run', sessionId: 'session', operationKey: 'inspect',
    query: 'world', limit: 5, signal: new AbortController().signal });
  assert.equal(matches.length, 1); assert.equal(matches[0].uri, result.content.persisted.path);
  const text = await artifacts.read({ scope, runId: 'run', sessionId: 'session', operationKey: 'inspect-read',
    ref: matches[0], offset: 0, limit: 100, signal: new AbortController().signal });
  assert.deepEqual(text, { content: '你好😀 world', nextOffset: null });
  assert.equal(JSON.stringify(result).includes('private()'), false);
});

test('Native Web pre-policy denial makes no request and a read post-policy failure remains a known error', async t => {
  let hits = 0;
  const fetch = async () => { hits++; return new Response('Public text'); };
  const host = await setup(t, { fetch, environment: { KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' } });
  host.postFail();
  const result = await host.port.execute(host.request('web_fetch', { url: 'https://example.com/page' }));
  assert.equal(result.status, 'error'); assert.equal(hits, 1);
  host.deny();
  const denied = await host.port.execute(host.request('web_fetch', { url: 'https://example.com/page' }));
  assert.equal(denied.status, 'error'); assert.equal(hits, 1);
});

test('Native Web binds configuration once and keeps sibling Session owners usable after release', async t => {
  const environment = { KSADK_WEB_SEARCH_PROVIDER: 'fake' };
  const host = await setup(t, { environment });
  const binding = structuredClone(host.gateway.webBinding);
  assert.ok(binding?.bindingDigest); assert.equal(binding.contract, 'agentkit.native-web-tools/v1');
  environment.KSADK_WEB_SEARCH_PROVIDER = 'unsupported-after-binding';
  const sibling = { session: { id: 'sibling' } };
  const other = host.gateway.forAgent(sibling, host.authority).tools;
  const first = await host.port.execute(host.request('web_search', { query: 'first' }));
  assert.equal(first.status, 'ok'); assert.equal(first.content.provider, 'fake');
  const siblingRequest = host.request('web_search', { query: 'second' }, { sessionId: 'sibling' });
  assert.equal((await other.execute(siblingRequest)).status, 'ok');
  await host.gateway.releaseSession({ scope, sessionId: 'session' });
  const again = await other.execute(host.request('web_search', { query: 'third' }, { sessionId: 'sibling' }));
  assert.equal(again.status, 'ok'); assert.equal(again.content.provider, 'fake');
  assert.deepEqual(host.gateway.webBinding, binding);
});

test('Native Web is absent unless selected and an MCP tool with the same name retains its executor', async t => {
  const empty = await setup(t, { names: [] });
  assert.equal(empty.gateway.webBinding, null); assert.equal(empty.registry.has('web_fetch'), false);
  // A declared MCP collision must not create a Node Web binding or replace the
  // MCP schema. Its real execution is covered by the existing gateway tests.
  const root = await mkdtemp(join(tmpdir(), 'native-web-mcp-')); await mkdir(join(root, 'workspace'));
  const registry = new Map();
  const gateway = createNativeDshTools({ ctx: { effect: install => install(), tools: {
    register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); }, execute() {},
  } }, config: { toolBindings: ['web_fetch'], toolContracts: [{ name: 'web_fetch', executor: 'mcp', resourceId: 'remote' }] },
  workspaceRoot: join(root, 'workspace'), stateDir: join(root, 'state'), executeMcpTool: async () => ({ content: [] }) });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(gateway.webBinding, null); assert.equal(gateway.definitions({ session: { id: 's' } },
    [{ name: 'web_fetch', parameters: { type: 'object' } }])[0].readOnly, false);
});
