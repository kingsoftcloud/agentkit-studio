/** Packed Studio mounted on the accepted DSH Host, with two independent
 * HTTP Harness services. Model fixtures are local; no user settings are read. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, readdir, symlink, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readNodeHostInstallation } from './node-host-packages.mjs';
import { createMountedInboundProof } from './verify-studio-native-a2a-inbound.mjs';
import { createStarHarnessReleases } from '../src/host/services/star-harness-release.mjs';
const checkout = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  source: { type: 'string' }, installation: { type: 'string' }, archive: { type: 'string' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/verify-independent-workspace-host.mjs [--source <built maintained DSH> | --installation <verified fresh Host>] [--archive] <Studio.tgz>');
  process.exit(0);
}
assert.ok(positionals.length <= 1 && !(values.archive && positionals.length) && !(values.installation && values.source),
  'Provide one Studio archive and one Host source or installation');
const archive = resolve(values.archive || positionals[0] || `.artifacts/kingsoftcloud-agentkit-studio-${version}.tgz`);
const fresh = values.installation ? await readNodeHostInstallation(resolve(values.installation), { archive }) : null;
const hostSource = values.source || process.env.AGENTKIT_DSH_ROOT;
assert.ok(fresh || hostSource, 'Set AGENTKIT_DSH_ROOT or provide the maintained Host explicitly');
const dsh = hostSource && resolve(hostSource);
const engineOverride = process.env.AGENTKIT_STUDIO_TEST_ENGINE_SERVER;
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-cutover-mounted.')));
let engineEntry = engineOverride;
let signedRelease;
if (!engineEntry) {
  const releases = createStarHarnessReleases({ directory: join(root, 'signed-releases') });
  const signal = AbortSignal.timeout(240000);
  signedRelease = await releases.latest(signal);
  assert.ok(signedRelease, 'An independently signed compatible Harness release is required');
  const installed = await releases.install(signedRelease, signal);
  engineEntry = join(installed, 'src/native/engine-server.mjs');
}
const engineUrl = pathToFileURL(engineEntry);
const enginePackage = JSON.parse(await readFile(new URL('../../package.json', engineUrl), 'utf8'));
assert.equal(enginePackage.name, '@kingsoftcloud/agentkit-harness-node');
assert.equal(typeof enginePackage.version, 'string');
if (signedRelease) assert.equal(enginePackage.version, signedRelease);
const { createEngineService } = await import(new URL('engine-service.mjs', engineUrl));
const graph = join(root, 'graph');
const studio = fresh ? join(fresh.dependencies, '@kingsoftcloud/agentkit-studio') : join(graph, 'package');
await mkdir(graph);
await copyFile(new URL('../tests/fixtures/independent-workspace-host.mjs', import.meta.url), join(graph, 'fixture.mjs'));
if (fresh) await symlink(fresh.dependencies, join(graph, 'node_modules'));
else {
  await mkdir(join(graph, 'node_modules/@deepseek-ai'), { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', graph]);
  for (const name of await readdir(join(checkout, 'node_modules'))) {
    if (name === '@kingsoftcloud') {
      const source = join(checkout, 'node_modules', name), destination = join(graph, 'node_modules', name);
      await mkdir(destination);
      for (const entry of await readdir(source)) if (!entry.startsWith('agentkit-harness-'))
        await symlink(join(source, entry), join(destination, entry));
      continue;
    }
    if (!name.startsWith('.') && name !== '@deepseek-ai') await symlink(join(checkout, 'node_modules', name), join(graph, 'node_modules', name));
  }
  const dshDependencies = join(dsh, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(dshDependencies)) await symlink(join(dshDependencies, name), join(graph, 'node_modules/@deepseek-ai', name));
}
const hostPackages = fresh?.dependencies;
const sdkPath = hostPackages ? join(hostPackages, '@deepseek-ai/dsh-sdk-client/lib/index.js') : join(dsh, 'packages/sdk/client/lib/index.js');
const dshBin = hostPackages ? join(hostPackages, '@deepseek-ai/dsh/lib/bin.js') : join(dsh, 'apps/cli/lib/bin.js');
const standardPatch = hostPackages ? join(hostPackages, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
  : join(dsh, 'packages/bundle/web-app/presets/standard.patch.yml');
const profileModules = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
await mkdir(profileModules, { recursive: true });
await symlink(studio, join(profileModules, 'agentkit-studio'));
const services = [], bindings = [], models = new Map();
const a2aRequests = [];
let discoveryRequests = 0;
const inboundProof = createMountedInboundProof(root);
const inboundProofPath = await inboundProof.prepare();
const inboundTokens = { 'a2a-registry': 'fixture-a2a-inbound-registry', 'a2a-task-sink': 'fixture-a2a-inbound-task-sink' };
const peer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, a2aOrigin);
    if (url.pathname === '/studio-proof-web') {
      response.setHeader('content-type', 'text/html');
      response.end('<title>hidden</title><p>😀证据</p>');
      return;
    }
    if (url.pathname === '/skills/ListSkillSpaces') {
      assert.equal(url.searchParams.get('PageNumber'), '1');
      assert.equal(request.headers.authorization, 'Bearer fixture-skill-directory-token');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Code: 0, Data: { SkillSpaces: [{ SkillSpaceId: 'proof-skills', SkillSpaceName: 'Fixture Skill Space' }] } }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (await inboundProof.handle(request, response, body, inboundTokens)) return;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/agentengine/api/v1/ListAToASpaceAgents') {
      assert.equal(body.A2ASpaceId, 'proof-space');
      discoveryRequests++;
      response.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'proof-peer', VersionId: 'proof-version',
        AgentCard: { name: 'peer', supportedInterfaces: [{ url: a2aOrigin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] } }] } }));
    } else {
      assert.equal(request.url, '/rpc');
      assert.equal(body.method, 'SendMessage');
      assert.equal(body.params.message.parts[0].text, 'Confirm the alpha workspace only.');
      a2aRequests.push(body.params.message.messageId);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: {
        id: 'proof-task', contextId: 'proof-context', status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'receipt', parts: [{ text: 'alpha peer verified' }] }],
      } } }));
    }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
let a2aOrigin;
function frames(delta, reason) {
  return [{ id: 'fixture', choices: [{ index: 0, delta }] }, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n';
}
let sdk;
try {
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  a2aOrigin = 'http://127.0.0.1:' + peer.address().port;
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
      const toolCall = (id, name, args) => frames({ tool_calls: [{ index: 0, id, type: 'function', function: {
        name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
      let next;
      if (requests.length === 1) next = toolCall('same-call', 'write_workspace_file', { path: 'proof.txt', content: label + '\n' });
      else if (label === 'alpha' && requests.length === 2)
        next = toolCall('alpha-peer', 'call_a2a_agent', { agent: 'peer', message: 'Confirm the alpha workspace only.' });
      else next = frames({ content: label + (requests.length === (label === 'alpha' ? 3 : 2) ? ' complete.' : ' resumed.') }, 'stop');
      return new Response(next, { headers: { 'content-type': 'text/event-stream' } });
    } });
    services.push(service);
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    bindings.push({ workspace, endpoint: 'http://127.0.0.1:' + service.server.address().port, model: label, tokenEnv: 'TEST_' + label.toUpperCase() + '_TOKEN' });
  }
  async function proofPatch(phase) {
    const patch = join(root, 'proof-' + phase + '.patch.yml');
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
      '      config:', ...Object.entries({ root, studio, bindings, a2aOrigin, phase, inboundProofPath, inboundTokens })
        .map(([key, value]) => '        ' + key + ': ' + JSON.stringify(value)), '',
    ].join('\n'));
    return patch;
  }
  const { DeepSeekHarness } = await import(pathToFileURL(sdkPath));
  const boot = async phase => new DeepSeekHarness({ dshBin, profile: 'sdk', patches: [standardPatch, await proofPatch(phase)],
    dshHome: join(root, 'home'), cwd: bindings[0].workspace, processCwd: root, provider: 'wake-fixture', model: 'wake',
    initializeTimeoutMs: 30000, requestTimeoutMs: 45000, env: { PATH: process.env.PATH, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } });
  sdk = await boot('initial');
  assert.equal((await sdk.session('wake-cutover-initial').run('Wake fixture.')).finalResponse, 'Fixture ready.');
  const proof = JSON.parse(await readFile(join(root, 'proof.json'), 'utf8'));
  assert.ok(!proof.error, proof.error);
  await inboundProof.probe('before');
  assert.equal(a2aRequests.length, 1);
  assert.equal(models.get('alpha').length, 3);
  const discoveredBeforeRestart = discoveryRequests;
  await sdk.close();
  sdk = null;
  sdk = await boot('restart');
  assert.equal((await sdk.session('wake-cutover-restart').run('Wake replacement fixture.')).finalResponse, 'Fixture ready.');
  const replacement = JSON.parse(await readFile(join(root, 'proof-restart.json'), 'utf8'));
  assert.ok(!replacement.error, replacement.error);
  assert.notEqual(replacement.pid, proof.pid);
  await inboundProof.probe('after');
  const inbound = JSON.parse(await readFile(join(root, 'mounted-inbound-evidence.json'), 'utf8'));
  assert.deepEqual([inbound.originalPid, inbound.coldPid], [proof.pid, replacement.pid]);
  assert.equal(replacement.reopened.runId, proof.results[0].runId);
  assert.equal(replacement.reopened.engineEventSha256, proof.results[0].engineEventSha256);
  assert.equal(models.get('alpha').length, 3);
  assert.equal(models.get('beta').length, 2);
  assert.equal(a2aRequests.length, 1);
  assert.equal(discoveryRequests, discoveredBeforeRestart);
  assert.equal((await sdk.session('wake-cutover-resume').run('Continue the original Studio session.')).finalResponse, 'Fixture ready.');
  const continuation = JSON.parse(await readFile(join(root, 'proof-resume.json'), 'utf8'));
  assert.ok(!continuation.error, continuation.error);
  assert.equal(continuation.pid, replacement.pid);
  const results = [...proof.results, continuation.resumed];
  assert.equal(proof.unboundRejected, true);
  assert.equal(proof.skillDirectoryRead, true);
  assert.equal(proof.dshWebRead, true);
  assert.equal(proof.dshE2BStatus, true);
  assert.equal(proof.dshE2BSkillMounted, true);
  assert.equal(proof.dshWorkspaceTools, true);
  assert.equal(proof.localCommandPolicy, true);
  assert.deepEqual(results.map(x => x.text), ['alpha complete.', 'beta complete.', 'alpha resumed.']);
  assert.equal(results[0].sessionId, results[2].sessionId);
  assert.notEqual(results[0].sessionId, results[1].sessionId);
  assert.equal(new Set(results.map(x => x.presetId)).size, 1);
  for (const binding of bindings) assert.equal(await readFile(join(binding.workspace, 'proof.txt'), 'utf8'), binding.model + '\n');
  assert.equal(models.get('alpha').length, 4); assert.equal(models.get('beta').length, 2);
  assert.equal(a2aRequests.length, 1);
  assert.match(JSON.stringify(models.get('alpha')[2].messages), /alpha peer verified/);
  assert.match(JSON.stringify(models.get('alpha')[3].messages), /alpha complete/);
  assert.doesNotMatch(JSON.stringify(models.get('alpha')[3].messages), /beta complete/);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  console.log(JSON.stringify({ passed: true, root, archiveSha256: hash.digest('hex'), engineVersion: enginePackage.version,
    signedRelease: signedRelease ?? null, hostDependencyGraph: fresh?.evidence ?? { kind: 'maintained-source', source: dsh },
    results, hostPids: [proof.pid, replacement.pid], modelRequests: { alpha: 4, beta: 2 },
    unboundRejected: proof.unboundRejected, skillDirectoryRead: proof.skillDirectoryRead,
    dshWebRead: proof.dshWebRead, dshE2BStatus: proof.dshE2BStatus, dshE2BSkillMounted: proof.dshE2BSkillMounted,
    dshWorkspaceTools: proof.dshWorkspaceTools, localCommandPolicy: proof.localCommandPolicy,
    originalRunReopened: replacement.reopened, coldReopenAdditionalRequests: { model: 0, discovery: 0, a2a: 0 },
    a2aRemoteSends: a2aRequests.length, a2aInbound: inbound, withoutEmbeddedEngine: true }));
} finally {
  await sdk?.close();
  await Promise.all(services.map(service => service.close()));
  peer.closeAllConnections();
  await new Promise(resolve => peer.close(resolve));
}
