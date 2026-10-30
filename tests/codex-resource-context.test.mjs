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
