import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';

const rawUsage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 12 } };
async function run({ usage = rawUsage, tool = false, internalLoop = false } = {}) {
  const traces = [], requests = [];
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: internalLoop ? { mcpServers: ['search-mcp'] } : {} } }) }),
    resourceAdapter: {
      listMcpTools: async () => [{ name: 'search', inputSchema: { type: 'object' } }],
      callMcpTool: async () => ({ content: [{ type: 'text', text: 'found' }] }),
    },
    modelService: { profile: async () => ({ baseUrl: 'http://model.test/v1', apiKey: 'fixture', modelName: 'fixture' }) },
    observability: { syncTrace: async value => traces.push(value) },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const callTool = tool || (internalLoop && requests.length === 1);
      const delta = callTool ? { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'search', arguments: '{}' } }] } : { content: 'answer' };
      const chunks = [
        { choices: [{ delta, finish_reason: callTool ? 'tool_calls' : 'stop' }], usage },
        // Some gateways repeat the final snapshot in their empty-choice trailer.
        { choices: [], usage },
      ];
      return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    },
  });
  const adapter = createDshRuntimeAdapter({ localHandler: async () => handler });
  const frames = [];
  for await (const frame of adapter.stream({ model: 'local:usage-agent', studioNativeTools: !internalLoop, sessionId: 'usage-session', messages: [{ role: 'user', content: 'hello' }] })) frames.push(frame);
  return { frames, traces, requests };
}

for (const tool of [false, true]) test(`gateway usage reaches native ${tool ? 'tool continuation' : 'answer'} once`, async () => {
  const { frames, traces, requests } = await run({ tool });
  assert.deepEqual(frames.filter(frame => frame.type === 'usage').map(frame => frame.usage), [{ inputTokens: 40, outputTokens: 30, totalTokens: 150, cacheReadTokens: 80, cacheWriteTokens: 0, reasoningTokens: 12 }]);
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
  if (!tool) {
    const usage = traces.flatMap(trace => trace.events).filter(event => event.event_type === 'model.usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].payload.usage.inputTokens, 120);
  }
});

test('an internal tool loop reports cumulative usage to the native model adapter', async () => {
  const { frames, traces } = await run({ internalLoop: true });
  const totals = frames.filter(frame => frame.type === 'usage').map(frame => frame.usage);
  assert.equal(totals.length, 2);
  assert.deepEqual(totals[1], { inputTokens: 80, outputTokens: 60, totalTokens: 300, cacheReadTokens: 160, cacheWriteTokens: 0, reasoningTokens: 24 });
  assert.equal(traces[0].events.filter(event => event.event_type === 'model.usage').length, 2);
});

test('missing or malformed upstream usage never creates a synthetic zero reading', async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: '12', completion_tokens: 3 }]) {
    const result = await run({ usage: usage ?? null });
    assert.equal(result.frames.some(frame => frame.type === 'usage'), false);
    assert.equal(result.traces.flatMap(trace => trace.events).some(event => event.event_type === 'model.usage'), false);
  }
});
