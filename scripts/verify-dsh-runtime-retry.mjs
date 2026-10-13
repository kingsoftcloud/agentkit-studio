/** Synthetic gateway failures exercised through the shipping DSH retry loop. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { bindDshAgentRoute, createDshRuntimeAdapter, routeDshRuntime, setDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { apply as applyRuntimePreset } from '../src/providers/dsh-runtime-plugin.mjs';

const root = resolve(process.env.AGENTKIT_DSH_ROOT || fileURLToPath(new URL('../../../deepseek-harness', import.meta.url)));
const require = createRequire(join(root, 'packages/llm/llm-retry/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter, createUserMessage, resolveRetryPolicy } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { defineContentToolFixture } = await load('@deepseek-ai/dsh-tools');
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const answer = () => new Response(frame({ choices: [{ delta: { content: 'RECOVERED' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
const failed = (status, code, headers) => Response.json({ error: { code } }, { status, headers });

async function proof({ name, fetch, attempts: expectedAttempts, retries: expectedRetries, recovered = true, cancel = false, nativeTools = true, toolCalls = 0, policy }) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  for (const name of ['session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default);
  await ctx.plugin(await load('@deepseek-ai/dsh-llm-retry'));
  await ctx.plugin((await load('@deepseek-ai/dsh-agent-loop')).default, { agents: [] });
  let attempts = 0, executions = 0;
  ctx.tools.register(defineContentToolFixture({ name: 'count', description: 'Count one tool execution', parameters: {}, execute: async () => { executions++; return [{ type: 'text', text: 'counted' }]; } }));
  const handler = createLocalConversationHandler({
    agentStore: async () => ({ get: async () => ({ spec: { bindings: {} } }) }),
    modelService: { profile: async () => ({ baseUrl: 'http://synthetic.invalid/v1', apiKey: 'test-only', modelName: 'fixture' }) },
    fetchImpl: async (_url, init) => fetch(++attempts, JSON.parse(init.body)),
  });
  const adapter = createDshRuntimeAdapter({ AdapterBase: LlmAdapter, localHandler: async () => handler });
  if (policy) adapter.providerRetryPolicy = () => resolveRetryPolicy(policy, 'verification policy');
  const disposeAdapter = ctx.llm.registerAdapter(['fixture'], adapter);
  const disposeBridge = setDshRuntimeAdapter(adapter);
  // Exercise the actual preset request hook, including an Agent with no tools.
  if (nativeTools) applyRuntimePreset(ctx, { agentId: 'retry-proof', runtime: 'harness', local: true });
  const disposeRoute = nativeTools ? () => {} : bindDshAgentRoute(name, { agentId: 'retry-proof', runtime: 'harness', local: true, nativeTools: false });
  ctx.on('llm/stream', routeDshRuntime);
  try {
    const agent = await ctx.agentLoop.create(SessionId(name), { provider: 'fixture', model: 'fixture' });
    if (cancel) ctx.on('session/event', (session, event) => { if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' }); });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    const retries = events.filter(event => event.type === 'llm/retry');
    const final = events.findLast(event => event.type === 'turn/end');
    console.log(JSON.stringify({ name, attempts, retries: retries.length, toolExecutions: executions, end: final?.data.reason.kind }));
    assert.equal(attempts, expectedAttempts, name);
    assert.equal(retries.length, expectedRetries, name);
    assert.equal(executions, toolCalls, name);
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1, 'retry stays in the same user turn');
    if (recovered) assert.equal(agent.session.deriveMessages().at(-1).content[0].text, 'RECOVERED');
    else assert.equal(final?.data.reason.kind, cancel ? 'aborted' : 'error');
  } finally { disposeRoute(); disposeBridge(); disposeAdapter(); await ctx.fiber.dispose(); }
}

await proof({ name: 'http-503-recovery', fetch: n => n === 1 ? failed(503, 'server_error') : answer(), attempts: 2, retries: 1 });
await proof({ name: 'http-401-terminal', fetch: () => failed(401, 'invalid_api_key'), attempts: 1, retries: 0, recovered: false });
await proof({ name: 'http-429-quota-terminal', fetch: () => failed(429, 'insufficient_quota'), attempts: 1, retries: 0, recovered: false });
await proof({ name: 'cancel-backoff', fetch: () => failed(503, 'server_error', { 'retry-after': '5' }), attempts: 1, retries: 1, recovered: false, cancel: true });
await proof({ name: 'standalone-no-replay', fetch: () => failed(503, 'server_error'), attempts: 1, retries: 0, recovered: false, nativeTools: false });
await proof({ name: 'bounded-retries', fetch: () => failed(503, 'server_error'), attempts: 3, retries: 2, recovered: false, policy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } });
await proof({ name: 'tool-continuation-recovery', attempts: 3, retries: 1, toolCalls: 1, fetch: (n, body) => {
  if (n === 1) return new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'one-call', function: { name: 'count', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
  return n === 2 ? failed(503, 'server_error') : answer();
} });
await proof({ name: 'partial-output-isolation', attempts: 2, retries: 1, fetch: (n, body) => {
  if (n === 1) return new Response(frame({ choices: [{ delta: { content: 'discarded-partial' } }] }) + frame({ error: { code: 'server_error' } }));
  assert.equal(JSON.stringify(body.messages).includes('discarded-partial'), false);
  return answer();
} });
