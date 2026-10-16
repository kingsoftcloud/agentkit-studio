import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshRuntimeAdapter, bindDshAgentRoute, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';

for (const prior of [false, true]) {
  test(`official schedule reaches the model ${prior ? 'after a completed conversation' : 'without an earlier user turn'}`, async t => {
    const agentId = `scheduled-agent-${prior}`, sessionId = `scheduled-session-${prior}`;
    t.after(() => unbindDshAgentRoutes(agentId));
    bindDshAgentRoute(sessionId, { agentId, runtime: 'dsh-native', local: true, agentRevision: 1, nativeTools: true });
    const requests = [];
    const handler = createLocalConversationHandler({
      agentStore: async () => ({ getRevision: async () => ({ spec: { instructions: { system: 'Help the user.' }, bindings: {} } }) }),
      modelService: { profile: async () => ({ modelName: 'fixture', baseUrl: 'https://model.test/v1', apiKey: 'test' }) },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response('data: {"choices":[{"delta":{"content":"REMINDER_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      },
    });
    const adapter = createDshRuntimeAdapter({ localHandler: async () => handler });
    const reminder = '[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nreminder_prompt_json: "REMINDER_OK"';
    const messages = [
      ...(prior ? [{ role: 'user', source: { kind: 'user' }, content: 'previous question' }, { role: 'assistant', content: 'previous answer' }] : []),
      { role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text', text: reminder }] },
      { role: 'user', source: { kind: 'runtime-context' }, content: 'internal context is not a new user task' },
    ];
    for await (const _ of adapter.stream({ sessionId, messages })) {}
    assert.deepEqual(requests[0].messages.filter(item => item.role === 'user'), [
      ...(prior ? [{ role: 'user', content: 'previous question' }] : []),
      { role: 'user', content: reminder },
    ]);
    if (prior) assert.ok(requests[0].messages.some(item => item.role === 'assistant' && item.content === 'previous answer'));
  });
}
