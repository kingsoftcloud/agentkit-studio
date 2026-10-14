/** Exercise the shipping bridge and preset plugin in built, real DSH services. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mountRuntimeBridge, ownAsyncResource, resolveRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { createDshRuntimeAdapter, routeDshRuntime } from '../src/providers/dsh-runtime.mjs';
import * as RuntimePreset from '../src/providers/dsh-runtime-plugin.mjs';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { dshModelRoute } from '../src/agent-preset-admission.mjs';

const root = resolve(process.env.AGENTKIT_DSH_ROOT || '');
if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the isolated, built pinned checkout');
const require = createRequire(join(root, 'packages/llm/llm-retry/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const { LlmAdapter, createUserMessage } = await load('dsh-llm');
const { SessionId } = await load('dsh-session');
const profile = { id: 'lifecycle-proof', modelName: 'fixture', baseUrl: 'http://synthetic.invalid/v1', apiKey: 'test-only' };
const provider = dshModelRoute(profile);
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const report = { evidence: 'real-built-dsh-controlled-provider', fullStudioPlugin: false,
  dshCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), cases: [] };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

async function host() {
  const ctx = new Context();
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`dsh-${name}`)).default);
  await ctx.plugin((await import(pathToFileURL(join(root, 'packages/skill/skill/lib/index.js')).href)).default);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  return ctx;
}

async function mount(ctx, label, fetchImpl) {
  let bridge;
  const fiber = await ctx.plugin({ name: 'studio-lifecycle-runtime', inject: ['llm'], apply(child) {
    bridge = mountRuntimeBridge(child);
    const handler = createLocalConversationHandler({ agentStore: async () => ({ get: async () => ({ spec: { bindings: {} } }) }), modelService: { profile: async () => profile },
      fetchImpl: fetchImpl || (async () => new Response(frame({ choices: [{ delta: { content: label }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')) });
    const adapter = createDshRuntimeAdapter({ AdapterBase: LlmAdapter, bridge, localHandler: async () => handler });
    child.effect(() => bridge.setAdapter(adapter), 'proof: Studio adapter');
    child.effect(() => child.llm.registerAdapter([provider], adapter), 'proof: DSH adapter');
    child.on('llm/stream', (options, next) => routeDshRuntime(options, next, bridge));
    child.effect(() => () => bridge.close(), 'proof: stop requests before unregister');
  } });
  return { bridge, fiber };
}

async function agent(ctx, id) {
  const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider, model: profile.modelName } });
  const preset = await handle.agent.ctx.plugin(RuntimePreset, { agentId: 'same-agent', runtime: 'harness', local: true });
  assert.equal(preset.state, 2, 'real Agent child scope must load the injected bridge service');
  return { ...handle, preset };
}

async function turn(subject, text) {
  subject.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await subject.whenIdle();
  return subject.session.deriveMessages().at(-1)?.content?.find(item => item.type === 'text')?.text;
}

const ctx = await host();
try {
  for (let i = 0; i < 20; i++) {
    const mounted = await mount(ctx, `cycle-${i}`);
    const handle = await agent(ctx, `cycle-${i}`);
    assert.equal(await turn(handle.agent, 'first'), `cycle-${i}`);
    assert.equal(await turn(handle.agent, 'second'), `cycle-${i}`);
    const old = handle.preset;
    const fresh = await handle.agent.ctx.plugin(RuntimePreset, { agentId: 'same-agent', runtime: 'harness', local: true });
    assert.equal(await turn(handle.agent, 'replacement'), `cycle-${i}`);
    const route = mounted.bridge.getRoute(handle.agent.id);
    await old.dispose();
    assert.ok(mounted.bridge.getRoute(handle.agent.id) === route, 'old scope removed the current route');
    await fresh.dispose();
    assert.equal(mounted.bridge.getRoute(handle.agent.id), undefined);
    await handle.dispose();
    await mounted.fiber.dispose(); await mounted.fiber.dispose();
    assert.deepEqual(mounted.bridge.diagnostics(), { closed: true, adapters: 0, executors: 0, routes: 0, requests: 0 });
    assert.equal(ctx.llm.listProviders().some(row => row.id === provider), false);
  }
  report.cases.push({ name: 'load-unload-and-old-scope-retirement', cycles: 20, turnsPerCycle: 3, passed: true });

  const right = await host();
  let a, b, ah, bh;
  try {
    a = await mount(ctx, 'left'); b = await mount(right, 'right');
    ah = await agent(ctx, 'same-session'); bh = await agent(right, 'same-session');
    assert.deepEqual(await Promise.all([turn(ah.agent, 'first'), turn(bh.agent, 'first')]), ['left', 'right']);
    assert.throws(() => resolveRuntimeBridge(), { code: 'STUDIO_RUNTIME_BRIDGE_AMBIGUOUS' });
    await a.fiber.dispose();
    assert.equal(await turn(bh.agent, 'second'), 'right');
    report.cases.push({ name: 'two-hosts-same-session-id', passed: true });
  } finally { await ah?.dispose(); await bh?.dispose(); await a?.fiber.dispose(); await b?.fiber.dispose(); await right.fiber.dispose(); }

  const ready = deferred();
  let requestSignal;
  const mounted = await mount(ctx, 'cancellation', async (_url, options) => {
    requestSignal = options.signal; ready.resolve();
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const handle = await agent(ctx, 'cancel-owned-stream');
  try {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'wait' }], source: { kind: 'user' } }));
    await ready.promise;
    await mounted.fiber.dispose();
    await handle.agent.whenIdle();
    assert.equal(requestSignal.aborted, true);
    assert.equal(handle.agent.session.snapshotEvents().filter(row => row.type === 'turn/end').length, 1);
    assert.equal(mounted.bridge.diagnostics().requests, 0);
    report.cases.push({ name: 'unload-during-model-stream', passed: true });
  } finally { await handle.dispose(); await mounted.fiber.dispose(); }

  const late = deferred(); let promise, closes = 0;
  const pending = await ctx.plugin({ apply(child) { promise = ownAsyncResource(child, late.promise, 'late initialization'); } });
  const rejects = assert.rejects(promise, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
  await pending.dispose(); late.resolve({ close() { closes++; } }); await rejects;
  assert.equal(closes, 1);
  report.cases.push({ name: 'initialization-finishes-after-unload', passed: true });
} finally { await ctx.fiber.dispose(); }

const output = resolve(process.argv[2] || '.artifacts/refactor/stage-1/dsh-lifecycle.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
