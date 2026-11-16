/** Packed Studio mounted on the accepted DSH Host, with two independent
 * HTTP Harness services. Model fixtures are local; no user settings are read. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, readdir, symlink, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
const archive = resolve(process.argv[2] || `.artifacts/kingsoftcloud-agentkit-studio-${version}.tgz`);
const dsh = process.env.AGENTKIT_DSH_ROOT;
assert.ok(dsh, 'Set AGENTKIT_DSH_ROOT to the accepted DSH checkout');
const require = createRequire(join(checkout, 'package.json'));
const { createEngineService } = await import(new URL('engine-service.mjs', pathToFileURL(require.resolve('@kingsoftcloud/agentkit-harness-node/native/engine-server'))));
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-cutover-mounted.')));
const graph = join(root, 'graph'), studio = join(graph, 'package');
await mkdir(join(graph, 'node_modules/@deepseek-ai'), { recursive: true });
await copyFile(new URL('../tests/fixtures/independent-workspace-host.mjs', import.meta.url), join(graph, 'fixture.mjs'));
execFileSync('tar', ['-xzf', archive, '-C', graph]);
for (const name of await readdir(join(checkout, 'node_modules'))) {
  if (!name.startsWith('.') && name !== '@deepseek-ai') await symlink(join(checkout, 'node_modules', name), join(graph, 'node_modules', name));
}
const dshDependencies = join(dsh, 'apps/cli/node_modules/@deepseek-ai');
for (const name of await readdir(dshDependencies)) await symlink(join(dshDependencies, name), join(graph, 'node_modules/@deepseek-ai', name));
const profileModules = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
await mkdir(profileModules, { recursive: true });
await symlink(studio, join(profileModules, 'agentkit-studio'));
const services = [], bindings = [], models = new Map();
function frames(delta, reason) {
  return [{ id: 'fixture', choices: [{ index: 0, delta }] }, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n';
}
let sdk;
try {
  for (const label of ['alpha', 'beta']) {
    const workspace = join(root, label), stateDir = join(root, 'engine-' + label), requests = [];
    await mkdir(workspace);
    models.set(label, requests);
    const service = createEngineService({ token: 'fixture-' + label + '-service-token', startup: { workspace, stateDir,
      scope: { tenantId: 'fixture', workspaceId: label, userId: 'owner', agentId: 'engine' },
      model: { name: label, baseUrl: 'https://example.test/v1', apiKeyEnv: 'TEST_MODEL_TOKEN' },
    }, env: { TEST_MODEL_TOKEN: 'fixture-model-credential' }, fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, label);
      requests.push(body);
      const next = requests.length === 1
        ? frames({ tool_calls: [{ index: 0, id: 'same-call', type: 'function', function: { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'proof.txt', content: label + '\n' }) } }] }, 'tool_calls')
        : frames({ content: label + (requests.length === 2 ? ' complete.' : ' resumed.') }, 'stop');
      return new Response(next, { headers: { 'content-type': 'text/event-stream' } });
    } });
    services.push(service);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    bindings.push({ workspace, endpoint: 'http://127.0.0.1:' + service.server.address().port, model: label, tokenEnv: 'TEST_' + label.toUpperCase() + '_TOKEN' });
  }
  const patch = join(root, 'proof.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', '    root: ' + JSON.stringify(join(root, 'sessions')), '    compression: none',
    '- insert:',
    '    - id: studio-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: studio-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: studio-proof-model-selection-settings', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: studio-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: studio-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: studio-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: proof-fixture', '      name: ' + JSON.stringify(pathToFileURL(join(graph, 'fixture.mjs')).href),
    '      config:', ...Object.entries({ root, studio, bindings }).map(([key, value]) => '        ' + key + ': ' + JSON.stringify(value)), '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(dsh, 'packages/sdk/client/lib/index.js')));
  sdk = new DeepSeekHarness({ dshBin: join(dsh, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(dsh, 'packages/bundle/web-app/presets/standard.patch.yml'), patch],
    dshHome: join(root, 'home'), cwd: bindings[0].workspace, processCwd: root, provider: 'wake-fixture', model: 'wake',
    initializeTimeoutMs: 30000, requestTimeoutMs: 45000, env: { PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } });
  assert.equal((await sdk.session('wake-cutover').run('Wake fixture.')).finalResponse, 'Fixture ready.');
  const proof = JSON.parse(await readFile(join(root, 'proof.json'), 'utf8'));
  assert.ok(!proof.error, proof.error);
  assert.equal(proof.unboundRejected, true);
  assert.deepEqual(proof.results.map(x => x.text), ['alpha complete.', 'beta complete.', 'alpha resumed.']);
  assert.equal(proof.results[0].sessionId, proof.results[2].sessionId);
  assert.notEqual(proof.results[0].sessionId, proof.results[1].sessionId);
  assert.equal(new Set(proof.results.map(x => x.presetId)).size, 1);
  for (const binding of bindings) assert.equal(await readFile(join(binding.workspace, 'proof.txt'), 'utf8'), binding.model + '\n');
  assert.equal(models.get('alpha').length, 3); assert.equal(models.get('beta').length, 2);
  assert.match(JSON.stringify(models.get('alpha')[2].messages), /alpha complete/);
  assert.doesNotMatch(JSON.stringify(models.get('alpha')[2].messages), /beta complete/);
  console.log(JSON.stringify({ passed: true, root, results: proof.results, modelRequests: { alpha: 3, beta: 2 }, unboundRejected: proof.unboundRejected }));
} finally {
  await sdk?.close();
  await Promise.all(services.map(service => service.close()));
}
