/** Actual NativeKernel + SQLite + production MCP adapter and local HTTP peer.
 * The model and ToolRegistry policy stage are controlled test doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';

for (const lossAt of ['none', 'registry', 'credentials', 'connection']) test(`parent MCP authority survives asynchronous admission (${lossAt})`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-parent-mcp-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite')); t.after(() => store.close());
  let effects = 0, models = 0, released = false, dispatch;
  const requests = [];
  const release = () => {
    if (released) return;
    const current = store.load(scope, 'run'); assert.equal(current.snapshot.phase, 'executing_tools');
    assert.ok(current.lease); store.release(scope, 'run', current.lease); released = true;
  };
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw); requests.push(message.method);
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === 'initialize') {
      if (lossAt === 'connection') release();
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-parent-authority', version: '1' } };
    }
    else if (message.method === 'tools/call') { effects++; result = { content: [{ type: 'text', text: 'Committed MCP business effect' }] }; }
    else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'parent-authority' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => {
    await Promise.resolve(); if (lossAt === 'credentials') release(); return { value: 'local-test-only' };
  } } }); t.after(() => adapters.close());
  const binding = { resourceId: 'bound-crm', server: { transport: 'streamable-http', endpointUrl: `http://127.0.0.1:${http.address().port}/mcp`,
    envRefs: { Authorization: 'env://LOCAL_TEST' } } };
  const registry = new Map(), agent = { session: { id: 'session' } };
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) }, tools: {
    register: tool => { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
    execute: async input => {
      await Promise.resolve(); if (lossAt === 'registry') release();
      const tool = registry.get(input.name);
      try { const value = await tool.execute(input.arguments, input); return { isError: false, content: tool.output.render(input.arguments, value) }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.code || error.message }] }; }
    },
  } };
  const gateway = createNativeDshTools({ ctx, config: { agentId: scope.agentId, toolBindings: ['save_crm'],
    toolContracts: [{ name: 'save_crm', executor: 'mcp', resourceId: 'bound-crm', parameters: { type: 'object', properties: {} } }] },
    workspaceRoot, stateDir: join(root, 'state'), executeMcpTool: async input => {
      dispatch = input;
      return adapters.callMcpTool(binding, input.name, input.arguments, { signal: input.signal, resultFormat: input.resultFormat, assertCurrent: input.assertCurrent });
    } }); t.after(() => gateway.close());
  const tools = gateway.definitions(agent, [...registry.values()]), data = fixture({ tools });
  data.snapshot.sessionId = 'session';
  const kernel = new NativeKernel({ store, owner: 'parent-worker', digest, ports: { ...gateway.forAgent(agent, { scope, store }),
    model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'save-crm', name: 'save_crm', arguments: {} }] }
      : { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] } } } });
  kernel.start(data.snapshot, data.config);
  if (lossAt === 'none') {
    assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(effects, 1); assert.equal(models, 2);
    assert.equal(typeof dispatch.assertCurrent, 'function'); assert.throws(dispatch.assertCurrent, /mcp_authority_stale/);
    await kernel.runUntilIdle(scope, 'run'); assert.equal(effects, 1);
    const record = store.load(scope, 'run'), intent = record.intents.find(item => item.kind === 'tool');
    assert.equal(intent.payload.calls[0].callId, 'save-crm');
    const receipt = record.receipts.find(item => item.operationKey === intent.operationKey);
    assert.equal(receipt.status, 'committed'); assert.equal(receipt.result.results[0].status, 'ok');
    assert.match(JSON.stringify(receipt.result.results[0].content), /Committed MCP business effect/);
  } else {
    await assert.rejects(kernel.runUntilIdle(scope, 'run'), { code: 'stale_fence' });
    assert.equal(released, true); assert.equal(effects, 0, 'Lost Native ownership must not reach tools/call');
    assert.equal(requests.includes('tools/call'), false);
    if (lossAt === 'registry') assert.equal(dispatch, undefined, 'Reject before entering the resource adapter');
    else {
      assert.equal(typeof dispatch.assertCurrent, 'function');
      assert.equal(requests.includes('initialize'), lossAt === 'connection', 'Lost credential-wait authority cannot start a new MCP connection');
    }
    const record = store.load(scope, 'run'), intent = record.intents.find(intent => intent.operationKey === record.snapshot.pendingIntent);
    assert.equal(intent.kind, 'tool'); assert.equal(intent.status, 'running');
    assert.equal(record.receipts.some(receipt => receipt.operationKey === intent.operationKey), false);
  }
});
