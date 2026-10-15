/** Installed Host composition in four isolated configurations; model responses
 * are controlled. This does not exercise real cloud/model provider availability.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.AGENTKIT_DSH_ROOT;
if (!source || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Isolated DSH source and homes are required');
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = await realpath(join(process.env.DSH_HOME, 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
const { mountStudioHost } = await import(pathToFileURL(join(installed, 'src/host/bootstrap.mjs')));
const { resolveRuntimeBridge } = await import(pathToFileURL(join(installed, 'src/host/runtime-bridge.mjs')));
const require = createRequire(join(source, 'apps/cli/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)));
const { loadLayeredEnv } = await load('dsh-app-boot');
const { LlmAdapter, createUserMessage } = await load('dsh-llm');
const { SessionId } = await load('dsh-session');
const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')));
const scratch = await mkdtemp(join(tmpdir(), 'studio-startup-states-'));
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const report = { evidence: 'real-built-dsh-installed-host-composition-controlled-provider', installed, states: [], passed: false };
const stdout = process.stdout.write.bind(process.stdout);
let output = '', launchUrl, running, fiber, stage = 'startup';
process.stdout.write = (chunk, ...args) => {
  output = (output + String(chunk)).slice(-5000);
  const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) launchUrl = match[1];
  args.find(value => typeof value === 'function')?.(); return true;
};
class NativeFixtureAdapter extends LlmAdapter {
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id }); }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'startup fixture' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'startup fixture' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
try {
  running = await runProfile({ profile, environment: loadLayeredEnv('dsh', source), patchFiles: [overlay], args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  assert.ok(launchUrl);
  const origin = new URL(launchUrl).origin;
  const login = await fetch(launchUrl, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = async (method, payload = {}) => {
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.ok, true, result.error?.code);
    return result.value;
  };
  const baseline = running.ctx.webServer.prefixes.size;
  for (const [name, model, cloud, resources] of [
    ['local-configured', true, true, true],
    ['model-only', true, false, true],
    ['cloud-unconfigured', false, false, true],
    ['resources-unavailable', true, false, false],
  ]) {
    stage = name;
    const home = join(scratch, name);
    await mkdir(home);
    const config = {
      ...(model ? {
        modelProfiles: [{ id: 'startup-fixture', modelName: 'fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', credentialName: 'STUDIO_STARTUP_FIXTURE_KEY', enabled: true, default: true }],
        modelProfileKeys: { STUDIO_STARTUP_FIXTURE_KEY: 'synthetic-startup-fixture' },
      } : {}),
      ...(cloud ? { cloudAccessKey: 'synthetic-startup-access', cloudSecretKey: 'synthetic-startup-secret' } : {}),
    };
    await writeFile(join(home, 'config.yaml'), JSON.stringify(config), { mode: 0o600 });
    const env = { AGENTKIT_HOME: home, CODEX_HOME: join(home, 'codex') };
    fiber = await running.ctx.plugin({ name: `studio-startup-state-${name}`, inject: ['connection', 'webServer', 'credentials'],
      apply: ctx => mountStudioHost(ctx, { env, configurationHome: home,
        ...(!resources ? { resourceAdapterFactory: async () => { throw Object.assign(new Error('controlled unavailable resource'), { code: 'FIXTURE_RESOURCE_DOWN' }); } } : {}),
      }),
    });
    assert.equal(fiber.state, 2, 'Host must activate in this configuration');
    stage = `${name}:settings`;
    const settings = await request('settings/get');
    assert.equal(settings.modelConfigured, model);
    assert.equal(settings.cloudAccountConfigured, cloud);
    stage = `${name}:local-agent`;
    const agent = await request('agents/create-local', { name: `startup-${name}`, runtimeType: 'dsh-native' });
    assert.equal((await request('agents/local-get', { agentId: agent.metadata.id })).metadata.id, agent.metadata.id);
    if (!resources) await assert.rejects(resolveRuntimeBridge(running.ctx).executeResourceTool({ resourceId: 'fixture', name: 'fixture' }), { code: 'RESOURCE_SERVICE_UNAVAILABLE' });
    stage = `${name}:native-turn`;
    const provider = 'studio-startup-native-fixture';
    const unregister = running.ctx.llm.registerAdapter([provider], new NativeFixtureAdapter());
    let handle;
    try {
      handle = await running.ctx.agents.create({ sessionId: SessionId(`studio-startup-${name}-${Date.now()}`), meta: { cwd: home }, agentOptions: { provider, model: 'fixture' } });
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'startup fixture' }], source: { kind: 'user' } }));
      await handle.agent.whenIdle();
      const reason = handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason;
      if (reason?.kind !== 'completed') {
        report.nativeFailure = { code: reason?.error?.code, message: String(reason?.error?.message || '').slice(0, 250) };
        throw Object.assign(new Error('Native fixture turn did not complete'), { code: String(reason?.error?.code || reason?.kind || 'TURN_END_MISSING') });
      }
      assert.equal(handle.agent.session.deriveMessages().at(-1)?.content?.find(part => part.type === 'text')?.text, 'startup fixture');
    } finally { await handle?.dispose(); unregister(); }
    stage = `${name}:dispose`;
    await fiber.dispose(); await fiber.dispose(); fiber = undefined;
    assert.equal(running.ctx.webServer.prefixes.size, baseline);
    report.states.push({ name, modelConfigured: model, cloudConfigured: cloud, nativeTurnPassed: true, independentLocalAgentCrudPassed: true, resourceFailureExplicit: !resources, registrationsReturnedToBaseline: true, passed: true });
  }
  report.passed = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFICATION_FAILED' };
  report.failure.location = error.stack?.split('\n').find(line => line.includes('verify-studio-startup-states.mjs'))?.trim();
  process.exitCode = 1;
} finally {
  await fiber?.dispose();
  await running?.shutdown.shutdown(process.exitCode || 0);
  process.stdout.write = stdout;
}
const target = resolve(process.argv[2] || '.artifacts/refactor/stage-4/startup-states.json');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
