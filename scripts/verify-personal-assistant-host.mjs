/** Actual installed Host composition, frozen archive and DSH durable Session.
 * The loopback model and MCP provider are controlled; no cloud writes occur.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, readdir, writeFile, cp, access } from 'node:fs/promises';
import { writeFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.AGENTKIT_DSH_ROOT;
if (!source || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated DSH source and homes');
const target = resolve(process.argv[2] || '.artifacts/refactor/stage-4/assistant-real-host.json');
await mkdir(dirname(target), { recursive: true });
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const originalInstalled = await realpath(join(process.env.DSH_HOME, 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'studio-frozen-host-')));
const home = join(scratch, 'agentkit');
const isolatedProfile = join(scratch, 'dsh/profiles', profile);
await mkdir(isolatedProfile, { recursive: true });
await cp(join(process.env.DSH_HOME, 'profiles', profile), isolatedProfile, { recursive: true, dereference: false, mode: constants.COPYFILE_FICLONE });
process.env.DSH_HOME = join(scratch, 'dsh');
const installed = join(isolatedProfile, 'node_modules/@kingsoftcloud/agentkit-studio');
const loadStudio = path => import(pathToFileURL(join(installed, 'src', path)));
const { mountStudioHost } = await loadStudio('host/bootstrap.mjs');
const { resolveRuntimeBridge } = await loadStudio('host/runtime-bridge.mjs');
const { createStudioBuild } = await loadStudio('studio-build.mjs');
const { createRuntimeResponsesContract } = await loadStudio('runtime-responses-contract.mjs');
const { syncPortableModelProfiles } = await loadStudio('portable-model-bridge.mjs');
const { dshModelRoute } = await loadStudio('agent-preset-admission.mjs');
const require = createRequire(join(source, 'apps/cli/package.json'));
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')));
await mkdir(home);
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const report = { evidence: 'real-dsh-assistant-http-history-schedule-controlled-model', installed, checks: [], passed: false,
  limits: ['Real DSH Host roots restart in one Node process; the HTTP client is a separately terminated process.', 'Controlled model; real cloud, Desktop UI and memory extraction require separate acceptance.'] };
const check = (name, details = {}) => report.checks.push({ name, ...details, passed: true });
const deadline = async (promise, ms = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Verification timed out'), { code: 'VERIFY_TIMEOUT' })), ms); })]); }
  finally { clearTimeout(timer); }
};
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const requests = [];
let toolCalls = 0, pending;
const modelServer = createServer(async (request, response) => {
  try {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const lastUser = body.messages.findLast(item => item.role === 'user');
    const input = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map(part => part.text || '').join('');
    requests.push({ model: body.model, input, priorResponse: JSON.stringify(body.messages).includes('ASSISTANT_DONE'),
      identity: body.messages.filter(item => item.role === 'system').flatMap(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).split('\n')).find(line => line.startsWith('{"assistantName":')) || '' });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ choices: [{ delta: { content: 'ASSISTANT_' }, finish_reason: null }] }));
    await new Promise(resolve => setTimeout(resolve, 1500));
    response.write(frame({ choices: [{ delta: { content: "DONE\n\n## Markdown 验收\n\n- 原生列表\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 已渲染 |\n\n```js\nconsole.log(\"studio\");\n```\n\n[文档](https://example.com)\n\n[拒绝危险链接](javascript:alert(1))\n\n<img src=x onerror=\"globalThis.__studioMarkdownUnsafe=true\">" }, finish_reason: 'stop' }] }));
    response.end('data: [DONE]\n\n');
  } catch (error) {
    report.modelFailure = { name: error.name, code: error.code || 'MODEL_FIXTURE_ASSERTION' };
    response.writeHead(500); response.end('controlled fixture failed');
  }
});
modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
const fixtureId = randomUUID().slice(0, 8);
const profiles = ['a', 'b'].map(letter => ({ id: `frozen-${letter}-${fixtureId}`, modelName: `model-${letter}`, provider: 'openai-compatible', baseUrl, credentialName: 'STUDIO_FROZEN_FIXTURE_KEY', enabled: true, default: letter === 'a' }));
await writeFile(join(home, 'config.yaml'), JSON.stringify({
  modelProfiles: profiles,
  modelProfileKeys: { STUDIO_FROZEN_FIXTURE_KEY: 'synthetic-frozen-fixture' },
}), { mode: 0o600 });
const env = { AGENTKIT_HOME: home, DSH_HOME: process.env.DSH_HOME, CODEX_HOME: join(home, 'codex') };
const resourceAdapterFactory = async () => ({
  listMcpTools: async () => [{ name: 'refactor_probe', description: 'Controlled frozen Host probe', inputSchema: { type: 'object', properties: {} } }],
  callMcpTool: async () => { toolCalls++; return { value: 'FROZEN_TOOL_OK' }; },
  close: async () => {},
});
const stdout = process.stdout.write.bind(process.stdout);
let clientChild;
let launchUrl, output = '', running, fiber, cookie, origin, stage = 'startup', checksComplete = false, retired = false;
const recordIncompleteExit = code => {
  report.failure ??= { stage, code: 'VERIFY_PROCESS_EXITED_BEFORE_COMPLETION', processCode: code };
  report.passed = false;
  report.modelRequests = requests.map(({ input, ...summary }) => summary);
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = 1;
};
process.once('exit', recordIncompleteExit);
process.stdout.write = (chunk, ...args) => {
  output = (output + String(chunk)).slice(-5000);
  const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) launchUrl = match[1];
  args.find(value => typeof value === 'function')?.(); return true;
};
async function boot() {
  launchUrl = undefined; output = '';
  running = await runProfile({ profile, environment: loadLayeredEnv('dsh', source), patchFiles: [overlay], args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  assert.ok(launchUrl);
  origin = new URL(launchUrl).origin;
  const login = await fetch(launchUrl, { redirect: 'manual' }); assert.equal(login.status, 303);
  cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  // The product browser normally publishes these provider routes. Headless
  // fixtures use the existing public Settings bridge, outside plugin apply.
  await syncPortableModelProfiles({ settings: running.ctx.get('settings'), profiles });
  await running.ctx.root.loader.await();
}
async function mount(runtime = {}) {
  fiber = await running.ctx.plugin({ name: 'studio-frozen-host-proof', inject: ['connection', 'webServer', 'credentials'],
    apply: ctx => mountStudioHost(ctx, { env: { ...env, ...runtime }, configurationHome: home, resourceAdapterFactory }),
  });
  assert.equal(fiber.state, 2);
}
async function rpc(method, payload = {}) {
  const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  if (!result?.ok) throw Object.assign(new Error('Host RPC failed'), { code: result?.error?.code || 'RPC_FAILED' });
  return result.value;
}
async function sessionBytes() {
  const files = new Map();
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name)) files.set(path, await readFile(path));
    }
  }
  await visit(join(process.env.DSH_HOME, 'sessions'));
  assert.ok(files.size > 0, 'the real Host must persist a Session log');
  return files;
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  await boot(); await mount();
  stage = 'create-frozen-dsh-assistant';
  const agent = await rpc('agents/create-local', { name: 'Assistant fixture', runtimeType: 'dsh-native', spec: { instructions: { system: 'Help the user.' }, bindings: { modelProfileId: profiles[0].id } } });
  const agentId = agent.metadata.id;
  const operation = await rpc('builds/create', { agentId, revision: 1 });
  let buildId = operation.buildId;
  const until = Date.now() + 15000;
  while (!buildId && Date.now() < until) {
    const result = (await rpc('operations/list', { resourceId: agentId })).items.find(item => item.id === operation.operationId);
    assert.notEqual(result?.status, 'FAILED'); buildId = result?.result?.buildId;
    if (!buildId) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(buildId);
  await fiber.dispose(); fiber = undefined;
  const port = await freePort(), token = randomUUID() + randomUUID();
  const receiptHash = createHash('sha256').update('controlled-retirement-fixture').digest('hex');
  await writeFile(join(scratch, '.agentkit-runtime.json'), JSON.stringify({ format: 'agentkit.runtime-state/v1', bundleSha256: receiptHash }));
  const runtime = { AGENTKIT_BUNDLE_SHA256: receiptHash, AGENTKIT_RUNTIME_AGENT_ID: agentId, AGENTKIT_RUNTIME_BUILD_ID: buildId, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(port) };
  await mount(runtime);
  const base = `http://127.0.0.1:${port}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const api = async (op, payload = {}) => {
    const response = await fetch(base + '/v1/assistant/' + op, { method: 'POST', headers, body: JSON.stringify(payload) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const waitFor = async predicate => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const snapshot = await api('snapshot'); if (predicate(snapshot)) return snapshot; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Assistant result timed out');
  };
  stage = 'persist-assistant-identity';
  await api('identity-update', { assistantName: '小星', ownerName: '小夏' });
  assert.deepEqual((await api('snapshot')).identity, { assistantName: '小星', ownerName: '小夏' });
  stage = 'client-process-exit';
  // A disposable client process exits after durable acceptance while the actual
  // DSH Host is still calling the delayed model. This is transport evidence;
  // installed Desktop and pre-online acceptance are separate gates.
  const child = clientChild = spawn(process.execPath, ['--input-type=module', '-e', `
    process.on('message', async ({base,headers}) => {
      const r=await fetch(base+'/v1/assistant/submit',{method:'POST',headers,body:JSON.stringify({requestId:'first',text:'continue after client exit'})});
      process.send({status:r.status,value:await r.json()});
    });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const received = once(child, 'message'); child.send({ base, headers });
  const [receipt] = await deadline(received); assert.equal(receipt.status, 202, JSON.stringify(receipt.value)); assert.equal(receipt.value.accepted, true);
  assert.notEqual((await api('snapshot')).status, 'completed');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const completed = await waitFor(value => value.status === 'completed');
  assert.match(completed.messages.at(-1).text, /^ASSISTANT_DONE/);
  check('client-process-exits-before-real-dsh-finishes', { nativeMessages: completed.messages.length });
  const firstRequest = requests.find(row => row.input === 'continue after client exit');
  assert.match(firstRequest?.identity || '', /"assistantName":"小星"/);
  assert.match(firstRequest?.identity || '', /"ownerName":"小夏"/);
  check('saved-assistant-and-owner-names-reach-real-model-system-prompt');
  stage = 'same-root-runtime-reload';
  await fiber.dispose(); fiber = undefined;
  await mount(runtime);
  assert.equal((await api('snapshot')).status, 'completed');
  check('same-root-runtime-reload-releases-and-restores-native-identity');
  stage = 'idempotent-submit';
  const before = requests.filter(row => row.input === 'continue after client exit').length;
  await api('submit', { requestId: 'first', text: 'continue after client exit' });
  assert.equal(requests.filter(row => row.input === 'continue after client exit').length, before);
  check('retry-reuses-durable-native-request');
  stage = 'official-cloud-schedule';
  await api('identity-update', { assistantName: '小月', ownerName: '小夏' });
  assert.equal(completed.scheduleEnabled, true);
  await api('schedule-create', { spec: { title: 'offline reminder', prompt: 'timer while client is closed', after_seconds: 2 } });
  await waitFor(value => value.status === 'completed' && value.messages.length > completed.messages.length);
  const scheduled = (await api('schedule-list')).items;
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].status, 'inactive');
  const scheduledRequest = requests.findLast(row => row.input.includes('timer while client is closed'));
  assert.ok(scheduledRequest, 'the model must receive the scheduled task, not repeat the previous user input');
  assert.match(scheduledRequest.identity, /"assistantName":"小月"/, 'renames reach already live agents and scheduled work');
  check('official-schedule-delivers-without-client');
  stage = 'fresh-host-recovery';
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  await boot(); await mount(runtime);
  const recovered = await api('snapshot');
  assert.deepEqual(recovered.identity, { assistantName: '小月', ownerName: '小夏' });
  assert.equal(recovered.status, 'completed'); assert.match(recovered.messages.at(-1).text, /^ASSISTANT_DONE/);
  await api('submit', { requestId: 'second', text: 'continue conversation' });
  await waitFor(value => value.status === 'completed' && value.messages.some(item => item.requestId === 'second'));
  const continuedRequest = requests.findLast(row => row.input === 'continue conversation');
  assert.equal(continuedRequest?.priorResponse, true);
  assert.match(continuedRequest.identity, /"assistantName":"小月"/);
  assert.match(continuedRequest.identity, /"ownerName":"小夏"/);
  check('identity-survives-fresh-host-and-native-scheduled-work');
  check('fresh-dsh-host-restores-history-and-model-context');
  if (process.env.STUDIO_VERIFY_UI === '1') {
    const native = process.env.STUDIO_VERIFY_NATIVE === '1';
    stage = native ? 'macos-ui' : 'web-ui';
    const { verifyPersonalAssistantUi } = await import('./verify-personal-assistant-ui.mjs');
    report.ui = await verifyPersonalAssistantUi({ source, installed, api: (operation, input = {}) => api(operation, { ...input, conversation: 'ui-acceptance' }), profiles, screenshot: target.replace(/\.json$/, '.png'), port: await freePort() });
    report.limits[1] = 'Controlled model and ownership catalog; real cloud deployment and memory extraction require separate acceptance.';
    check(native ? 'real-electron-ui-reopens-after-local-host-exits' : 'real-web-ui-reopens-after-local-host-exits');
  }
  stage = 'delete-dedicated-assistant';
  // Listing cold sessions queues cache writes independently of Session.flush.
  // Keep that actual native path hot at the destructive shutdown boundary.
  await Promise.all(Array.from({ length: 12 }, () => api('snapshot', { conversation: 'ui-acceptance' })));
  const deletion = await api('close');
  assert.equal(deletion.deleted, true); assert.equal(deletion.historyDeleted, true); assert.equal(deletion.memoryDeleted, true);
  assert.equal(Boolean(running.ctx.get('storageDomain').get('session_projcache')), false, 'native cache must be closed, not left able to recreate erased files');
  await assert.rejects(access(join(scratch, 'dsh')), { code: 'ENOENT' });
  await assert.rejects(access(home), { code: 'ENOENT' });
  await access(join(originalInstalled, 'src/index.mjs'));
  retired = true;
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  await assert.rejects(access(join(scratch, 'dsh')), { code: 'ENOENT' });
  await assert.rejects(access(home), { code: 'ENOENT' });
  check('real-dsh-history-and-dedicated-runtime-deleted-original-installation-preserved');
  check('native-storage-closed-and-shutdown-cannot-recreate-deleted-data');
  assert.equal(report.modelFailure, undefined);
  checksComplete = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFY_FAILED', message: error.message, location: error.stack?.split('\n').find(line => line.includes('verify-personal-assistant-host.mjs'))?.trim() };
  process.exitCode = 1;
} finally {
  report.modelRequests = requests.map(({ input, ...summary }) => summary);
  clientChild?.kill('SIGKILL');
  stage = 'final-host-cleanup';
  await fiber?.dispose();
  if (running && !retired) {
    const settings = running.ctx.get('settings');
    const namespace = settings.describe({ redactSecrets: true }).find(item => item.ns === 'llm-pi-ai');
    const owned = profiles.map(profile => dshModelRoute(profile)).filter(route => Object.hasOwn(namespace?.value?.providers || {}, route));
    if (owned.length) await settings.mutate('llm-pi-ai', owned.map(route => ({ op: 'unset', path: ['providers', route] })), namespace.revision);
    await running.ctx.root.loader.await();
  }
  await running?.shutdown.shutdown(process.exitCode || 0);
  modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve));
  process.stdout.write = stdout;
}
report.passed = checksComplete && !report.failure;
await writeFile(target, JSON.stringify(report, null, 2) + '\n');
process.removeListener('exit', recordIncompleteExit);
console.log(JSON.stringify(report));
