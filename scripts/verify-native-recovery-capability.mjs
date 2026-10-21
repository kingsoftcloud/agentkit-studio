/** Verify trusted recovery bindings with real DSH Agents and official dispatch. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source, 'Use --source <built maintained DSH>');
const source = resolve(values.source), repository = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'native-recovery-agents-'));
try {
  let installed = repository;
  if (values.archive) {
    const graph = join(directory, 'studio'); await mkdir(graph);
    execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
    installed = join(graph, 'package');
  }
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || ['@deepseek-ai', '@kingsoftcloud'].includes(name)) continue;
    await mkdir(join(directory, 'node_modules'), { recursive: true });
    await symlink(join(repository, 'node_modules', name), join(directory, 'node_modules', name));
  }
  const packages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  const dependencies = join(directory, 'node_modules/@deepseek-ai');
  await mkdir(dependencies, { recursive: true });
  for (const name of await readdir(packages)) await symlink(join(packages, name), join(dependencies, name));
  const studio = join(directory, 'node_modules/@kingsoftcloud');
  await mkdir(studio); await symlink(installed, join(studio, 'agentkit-studio'));
  const entry = join(directory, 'verify.mjs');
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { apply as applyPreset } from '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin';
import { mountRuntimeBridge } from ${JSON.stringify(pathToFileURL(join(installed, 'src/host/runtime-bridge.mjs')).href)};
const root = new Context(), foreign = new Context(), tools = new Map();
let executorCalls = 0, modelCalls = 0, serial = 0;
try {
  await mountAgentLoopTestDependencies(root);
  await root.plugin(AgentLoop, { agents: [] });
  root.llm.registerAdapter(['fixture'], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    resolveModel: (provider, id) => ({ provider, id, name: id }),
    prepareCall: () => { modelCalls++; throw Error('Binding lookup must not dispatch a model'); },
  });
  const bridge = mountRuntimeBridge(root);
  bridge.setNativeToolsFactory(({ config }) => tools.get(config.agentId));
  bridge.setNativeTurnExecutor(async () => { executorCalls++; throw Error('Binding lookup must not execute a turn'); });
  async function preset(config, nativeTools) {
    tools.set(config.agentId, nativeTools);
    return root.agents.create({ sessionId: SessionId('recovery-' + ++serial),
      agentOptions: { provider: 'fixture', model: 'pinned' },
      setup: ctx => { applyPreset(ctx, config); } });
  }
  const config = (agentId, extra = {}) => ({ agentId, agentRevision: 1, local: true,
    runtime: 'harness', nativeEngineContract: 'agentkit.native-dsh-turn/v1', ...extra });
  const query = (agent, ctx = root) => agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {});
  const alphaTools = { id: 'alpha-tools' }, betaTools = { id: 'beta-tools' };
  const alpha = await preset(config('alpha', { buildId: 'alpha-build' }), alphaTools);
  const beta = await preset(config('beta', { agentRevision: 2 }), betaTools);
  const original = await query(alpha.agent), second = await query(beta.agent);
  assert.deepEqual(original, { agentId: 'alpha', agentRevision: 1, buildId: 'alpha-build',
    runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1', nativeTools: alphaTools });
  assert.equal(second.agentId, 'beta'); assert.equal(second.agentRevision, 2);
  assert.equal(second.nativeTools, betaTools); assert.equal(second.buildId, undefined);
  assert.notEqual(original.nativeTools, second.nativeTools);
  assert.equal(await query(alpha.agent, foreign), undefined);
  const unavailable = await preset(config('unavailable', { resourcesUnavailable: true }), {});
  await assert.rejects(query(unavailable.agent), { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
  const native = await preset({ agentId: 'native', runtime: 'dsh-native', local: true }, {});
  assert.equal(await query(native.agent), undefined);
  await alpha.dispose();
  assert.equal(await query(alpha.agent), undefined, 'A retired Agent must return no binding');
  assert.equal((await query(beta.agent)).nativeTools, betaTools);
  const replacementTools = { id: 'new-alpha-tools' };
  const replacement = await preset(config('alpha', { agentRevision: 3 }), replacementTools);
  assert.equal((await query(replacement.agent)).nativeTools, replacementTools);
  assert.equal((await query(replacement.agent)).agentRevision, 3);
  assert.equal(await query(alpha.agent), undefined, 'Recomposition cannot reauthorize an old Agent');
  assert.equal(modelCalls, 0); assert.equal(executorCalls, 0);
  assert.equal(alpha.agent.session.snapshotEvents().some(event => event.type === 'turn/start'), false);
  console.log('PASS: real Agents, official agentEvents, real Studio bridge, preset and root isolation, retirement, recomposition, zero execution');
} finally { await root.fiber.dispose(); await foreign.fiber.dispose(); }
`);
  execFileSync(process.execPath, [entry], { cwd: directory, stdio: 'inherit', timeout: 30000 });
} finally {
  if (!values.keep) await rm(directory, { recursive: true, force: true });
}
