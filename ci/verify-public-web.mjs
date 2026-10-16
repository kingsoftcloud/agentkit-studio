/** Exercise existing public UI assertions with synthetic loopback model data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
assert.ok(process.env.AGENTKIT_DSH_ROOT && process.env.DSH_HOME && process.env.AGENTKIT_HOME);
const output = join(root, '.artifacts/public-web');
await mkdir(output, { recursive: true });
await mkdir(process.env.AGENTKIT_HOME, { recursive: true });
let requests = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: ['fixture-alpha', 'fixture-beta'].map(id => ({ id, object: 'model' })) }));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests++;
    const message = { role: 'assistant', content: 'SIDEBAR_SEED_OK' };
    if (!body.stream) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'public-web-fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: 'stop' }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = delta => `data: ${JSON.stringify(delta)}\n\n`;
    response.write(frame({ id: 'public-web-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: message, finish_reason: null }] }));
    response.write(frame({ id: 'public-web-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    response.end('data: [DONE]\n\n');
  } catch {
    response.writeHead(500); response.end('controlled fixture failed');
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const modelProfiles = ['alpha', 'beta'].map((name, index) => ({ id: `public-${name}`, modelName: `fixture-${name}`, provider: 'openai-compatible', baseUrl, credentialName: 'STUDIO_PUBLIC_FIXTURE_KEY', enabled: true, default: index === 0 }));
await writeFile(join(process.env.AGENTKIT_HOME, 'config.yaml'), JSON.stringify({ modelProfiles, modelProfileKeys: { STUDIO_PUBLIC_FIXTURE_KEY: 'synthetic-public-fixture' } }), { mode: 0o600 });
const run = (script, args = [], extraEnv = {}) => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, env: { ...process.env, ...extraEnv }, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`Public verification failed: ${script}; exit=${code}`)));
});
try {
  // The shared assertions name Chinese controls; pin the actual Host preference
  // instead of relying on the clean runner browser's English default.
  const hostRequire = createRequire(join(process.env.AGENTKIT_DSH_ROOT, 'apps/cli/package.json'));
  const { loadLayeredEnv } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')));
  const { runProfile } = await import(pathToFileURL(join(process.env.AGENTKIT_DSH_ROOT, 'apps/cli/lib/profile-boot.js')));
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = (_chunk, ...args) => { args.find(value => typeof value === 'function')?.(); return true; };
  let running;
  try {
    running = await runProfile({ profile: 'studio-refactor', environment: loadLayeredEnv('dsh', process.env.AGENTKIT_DSH_ROOT), patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] });
    const locale = running.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'locale');
    assert.ok(locale);
    await running.ctx.settings.mutate('locale', [{ op: 'set', path: ['preference'], value: 'zh' }], locale.revision);
    const actual = running.ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'locale');
    assert.equal(actual.value.preference, 'zh');
    // Persisted runtime-test Sessions intentionally make automatic first-use
    // Workspace creation ineligible. Create this UI fixture explicitly.
    const workspacePath = join(process.env.AGENTKIT_HOME, 'test-workspaces', 'default-workspace');
    await mkdir(workspacePath, { recursive: true });
    const workspace = await running.ctx.workspaceController.create({ path: workspacePath });
    assert.equal(workspace.workspace.title, 'default-workspace');
    await writeFile(join(output, 'locale-fixture.json'), JSON.stringify({ preference: 'zh', hostSettingsPersisted: true, isolatedWorkspaceCreated: true }) + '\n');
  } finally {
    await running?.shutdown.shutdown(0);
    process.stdout.write = stdout;
  }
  await run('seed-studio-sidebar-sessions.mjs');
  await run('seed-studio-sidebar-sessions.mjs', [], { STUDIO_VERIFY_DELETED_HISTORY: '1' });
  await run('verify-studio-native-sidebar-web.mjs', [join(output, 'real-web-ui.json')], {
    STUDIO_VERIFY_CLIENT_STATE: '1', STUDIO_VERIFY_CLIENT_PAGES: '1', STUDIO_VERIFY_ROUTE_FAILURES: '1',
  });
  const ui = JSON.parse(await readFile(join(output, 'real-web-ui.json'), 'utf8'));
  assert.equal(ui.passed, true); assert.equal(ui.rendererErrors, 0);
  const checks = ['checks', 'stateChecks', 'pageChecks', 'routeFailureChecks'].flatMap(key => ui[key] || []);
  assert.equal(checks.length, 28); assert.ok(checks.every(check => check.passed));
  assert.ok(requests >= 3);
  const report = { evidence: 'real-installed-dsh-web-controlled-loopback-model', passed: true, checks: checks.length, rendererErrors: 0, modelRequests: requests, externalProviderUsed: false, cloudMutations: false };
  await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await new Promise(resolve => server.close(resolve));
}
