import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexResourceContext } from '../src/providers/codex-resource-context.mjs';

test('a Codex Agent without resource bindings receives scoped official presentation and no unrelated tools', async () => {
  const record = { metadata: { name: 'Codex' }, spec: { instructions: { system: 'persona' } } };
  const calls = [], owner = { id: 'session' };
  const context = createCodexResourceContext({ agentStore: { get: async () => record }, builds: {}, resources: {} });
  const result = await context({ agentId: 'agent', agent: owner, toolAdapter: {
    listPresentationTools: () => [{ name: 'present', description: 'official', parameters: { type: 'object', properties: { files: { type: 'array' } } } }],
    callPresentationTool: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'Presented result.svg' }] }; },
  } });
  assert.deepEqual(result.dynamicTools.map(tool => tool.name), ['dsh_present']);
  assert.match(result.systemPrompt, /dsh_present/);
  const files = [{ path: 'result.svg' }];
  await result.toolHandler({ name: 'dsh_present', arguments: { files }, callId: 'native-call' });
  assert.deepEqual(calls[0].slice(0, 2), ['present', { files }]);
  assert.equal(calls[0][2].agent, owner);
  await assert.rejects(result.toolHandler({ name: 'bash', arguments: {} }), { code: 'BOUND_TOOL_NOT_FOUND' });
});

test('Codex bound MCP cancellation aborts the pending resource call', async () => {
  const controller = new AbortController();
  const context = createCodexResourceContext({ agentStore: { get: async () => ({ spec: { bindings: { mcpServers: ['bound-mcp'] } } }) }, builds: {},
    resources: {
      listMcpTools: async () => [{ name: 'pending_tool', inputSchema: { type: 'object' } }],
      callMcpTool: async (_binding, _name, _args, options) => {
        assert.ok(options?.signal instanceof AbortSignal);
        controller.abort();
        options.signal.throwIfAborted();
      },
    },
  });
  const prepared = await context({ agentId: 'agent' });
  await assert.rejects(prepared.toolHandler({ name: prepared.dynamicTools[0].name, signal: controller.signal }), { name: 'AbortError' });
});

test('bound Native A2A tools use the existing authorized port and keep uncertain results', async () => {
  const owner = { session: { id: 'a2a-session' } };
  const send = { name: 'call_a2a_agent', readOnly: false, timeoutMs: 90000, parameters: { type: 'object' } };
  const discover = { name: 'list_a2a_agents', readOnly: true, timeoutMs: 30000, parameters: { type: 'object' } };
  const record = { spec: { bindings: { a2a: [{ id: 'binding' }] } } };
  const context = createCodexResourceContext({ agentStore: { get: async () => record }, builds: {}, resources: {} });
  const calls = [];
  const toolAdapter = {
    listNativeA2aTools: () => [send, discover],
    async callNativeA2aTool(...args) {
      calls.push(args);
      return { status: 'uncertain', content: { code: 'remote_reply_unknown' } };
    },
  };
  const prepared = await context({ agentId: 'agent', runtime: 'native-engine', nativeService: true, agent: owner, toolAdapter });
  const [write, read] = prepared.dynamicTools;
  assert.equal(write.effectProtocol, 'agentkit.engine-host-tool-effect/v1');
  assert.equal(read.readOnly, true);
  assert.equal(read.effectProtocol, undefined);
  const signal = new AbortController().signal;
  const call = { name: write.name, runId: 'run1', callId: 'model-call', arguments: { agent: 'research', message: 'test' }, signal };
  assert.equal((await prepared.nativeHostToolHandler(call)).content.code, 'A2A_EFFECT_UNBOUND');
  assert.equal(calls.length, 0);
  const effect = { contract: write.effectProtocol, operationKey: 'tool-1' };
  assert.equal((await prepared.nativeHostToolHandler({ ...call, effect })).status, 'uncertain');
  await prepared.nativeHostToolHandler({ ...call, effect });
  await prepared.nativeHostToolHandler({ ...call, effect, runId: 'run2' });
  assert.deepEqual(calls[0].slice(0, 2), [write.name, call.arguments]);
  assert.equal(calls[0][2].agent, owner);
  assert.equal(calls[0][2].signal, signal);
  assert.equal(calls[0][2].callId, calls[1][2].callId);
  assert.notEqual(calls[0][2].callId, calls[2][2].callId);
  assert.deepEqual((await context({ agentId: 'agent', runtime: 'codex', agent: owner, toolAdapter })).dynamicTools, []);
});
