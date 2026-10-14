/** Live model/App Server checks; credentials stay in the Host process. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createLocalConversationHandler } from '../src/local-runtime.mjs';
import { mountRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { createDshRuntimeAdapter, routeDshRuntime } from '../src/providers/dsh-runtime.mjs';
import * as RuntimePreset from '../src/providers/dsh-runtime-plugin.mjs';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';
import { dshModelRoute } from '../src/agent-preset-admission.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set the isolated AGENTKIT_DSH_ROOT');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const require = createRequire(join(root, 'packages/llm/llm-retry/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load('cordis');
const { LlmAdapter, createUserMessage } = await load('dsh-llm');
const { SessionId } = await load('dsh-session');
const { defineContentToolFixture } = await load('dsh-tools');
const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async () => null } });
const profile = await models.profile('');
const provider = dshModelRoute(profile);
const workspace = await mkdtemp(join(tmpdir(), 'studio-live-lifecycle-'));
const report = { evidence: 'real-dsh-live-configured-model-and-codex-app-server', model: profile.modelName,
  api: profile.codexApi || 'chat-completions', cases: [] };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

async function setup(runtime) {
  const ctx = new Context();
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent']) await ctx.plugin((await load(`dsh-${name}`)).default);
  await ctx.plugin((await import(pathToFileURL(join(root, 'packages/skill/skill/lib/index.js')).href)).default);
  await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
  const bridge = mountRuntimeBridge(ctx);
  const opened = deferred();
  const children = new Set();
  let executions = 0;
  const value = 'DSH_LIFECYCLE_TOOL_OK';
  ctx.tools.register(defineContentToolFixture({ name: 'lifecycle_probe', description: 'Return the lifecycle verification value', parameters: {}, execute: async () => { executions++; return [{ type: 'text', text: value }]; } }));
  const handler = createLocalConversationHandler({ agentStore: async () => ({ get: async () => ({ spec: { bindings: { modelProfileId: profile.id } } }) }), modelService: models,
    fetchImpl: (...args) => { opened.resolve(); return fetch(...args); } });
  const codex = createCodexRuntime({ startupTimeoutMs: 30000, timeoutMs: 120000, spawnImpl: (...args) => {
    const child = spawn(...args); children.add(child); child.once('exit', () => children.delete(child)); opened.resolve(); return child;
  } });
  const adapter = createDshRuntimeAdapter({ bridge, AdapterBase: LlmAdapter, localHandler: async () => handler, codexRuntime: codex,
    resolveCodexModel: async () => ({ model: profile.modelName, modelProvider: { api: profile.codexApi || 'chat-completions', baseUrl: profile.baseUrl, apiKey: profile.apiKey } }),
    codexResourceContext: async () => ({ dynamicTools: [{ name: 'lifecycle_probe', description: 'Return the lifecycle verification value', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      toolHandler: async () => { executions++; return { content: [{ type: 'text', text: value }] }; } }),
  });
  ctx.effect(() => bridge.setAdapter(adapter), 'live verification: bridge adapter');
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter), 'live verification: DSH adapter');
  ctx.on('llm/stream', (options, next) => routeDshRuntime(options, next, bridge));
  const makeAgent = async id => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: workspace }, agentOptions: { provider, model: profile.modelName } });
    await handle.agent.ctx.plugin(RuntimePreset, { agentId: 'live-lifecycle', runtime, local: true });
    return handle;
  };
  return { ctx, bridge, opened, children, makeAgent, executions: () => executions };
}

async function turn(subject, input) {
  subject.followup(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }));
  await subject.whenIdle();
  const end = subject.session.snapshotEvents().findLast(event => event.type === 'turn/end');
  const detail = String(end?.data.reason.error?.message || '').split(profile.apiKey).join('[redacted]').slice(0, 400);
  assert.equal(end?.data.reason.kind, 'completed', `live turn failed: ${end?.data.reason.error?.code || end?.data.reason.kind} ${detail}`);
  return subject.session.deriveMessages().at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('') || '';
}

try {
  for (const runtime of (process.env.STUDIO_VERIFY_RUNTIMES || 'harness,dsh-native,codex').split(',')) {
    let host, handle, canceled, stage = 'setup';
    const checks = {};
    try {
      host = await setup(runtime);
      handle = await host.makeAgent(`live-${runtime}`);
      stage = 'first-turn';
      const first = await turn(handle.agent, 'Call lifecycle_probe exactly once. Then reply LIVE_CONTEXT_OK.');
      checks.firstIncludesToolValue = first.includes('DSH_LIFECYCLE_TOOL_OK');
      checks.firstToolExecutions = host.executions();
      assert.match(first, /LIVE_CONTEXT_OK/);
      stage = 'second-turn';
      const second = await turn(handle.agent, 'What value did lifecycle_probe return in the previous turn? Reply with that value only.');
      checks.secondIncludesToolValue = second.includes('DSH_LIFECYCLE_TOOL_OK');
      checks.totalToolExecutions = host.executions();
      assert.match(second, /DSH_LIFECYCLE_TOOL_OK/);
      stage = 'tool-count';
      assert.equal(host.executions(), 1);
      const before = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length;
      assert.equal(before, 2);
      await handle.dispose(); handle = null;
      // Fresh Host/Agent: cancel once the real transport/process starts.
      await host.ctx.fiber.dispose();
      host = await setup(runtime);
      stage = 'cancellation';
      canceled = await host.makeAgent(`cancel-${runtime}`);
      canceled.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with a short confirmation.' }], source: { kind: 'user' } }));
      await host.opened.promise;
      canceled.agent.cancel({ kind: 'user' });
      await canceled.agent.whenIdle();
      assert.equal(canceled.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1);
      assert.equal(canceled.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted');
      await canceled.dispose(); canceled = null;
      await host.ctx.fiber.dispose();
      const exited = [...host.children].map(child => new Promise(resolve => child.once('exit', resolve)));
      await Promise.all(exited);
      assert.equal(host.children.size, 0);
      assert.equal(host.bridge.diagnostics().requests, 0);
      report.cases.push({ runtime, path: runtime === 'dsh-native' ? 'resource-capable-Studio-native-bridge' : runtime, turns: 2, toolExecutions: 1, cancellation: 'aborted', childProcessesRemaining: 0, checks, passed: true });
    } catch (error) {
      report.cases.push({ runtime, stage, checks, passed: false, code: String(error.code || 'ASSERTION_FAILED'), message: String(error.message || '').split(profile.apiKey).join('[redacted]').slice(0, 500) });
      process.exitCode = 1;
    } finally { await handle?.dispose(); await canceled?.dispose(); await host?.ctx.fiber.dispose(); }
  }
} finally { await rm(workspace, { recursive: true, force: true }); }
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-1/dsh-live-runtime.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
