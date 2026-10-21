/** Actual installed Host composition, frozen archive and DSH durable Session.
 * The loopback model and MCP provider are controlled; no cloud writes occur.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, readdir, writeFile, cp, access, rm } from 'node:fs/promises';
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
const { installAssistantStartupGuard } = await loadStudio('assistant-permission-model.mjs');
const require = createRequire(join(source, 'apps/cli/package.json'));
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')));
await mkdir(home);
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const report = { evidence: 'real-dsh-assistant-http-history-schedule-controlled-model', installed, checks: [], passed: false,
  limits: ['The installed package is mounted through its Host bootstrap and startup guard; the profile overlay disables automatic Studio index.apply loading, which requires separate acceptance.', 'Real DSH Host roots restart in one Node process; the HTTP client is a separately terminated process.', 'Controlled model; real cloud, Desktop UI and memory extraction require separate acceptance.', 'File downloads are verified only for native content-addressed attachments; path-only deliverables remain metadata-only.'] };
const check = (name, details = {}) => report.checks.push({ name, ...details, passed: true });
const deadline = async (promise, ms = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Verification timed out'), { code: 'VERIFY_TIMEOUT' })), ms); })]); }
  finally { clearTimeout(timer); }
};
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const fileBytes = Buffer.from('Controlled cloud attachment fixture.\n');
const attachmentId = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const receiptPart = receipt => receipt.kind === 'image'
  ? { type: 'image', receiptId: receipt.receiptId, mediaType: receipt.mediaType, name: receipt.attachment.name }
  : { type: 'file', receiptId: receipt.receiptId };
const userEvent = (snapshot, requestId) => snapshot.events.find(event => event.type === 'user/message' && event.data.source.rpcId === requestId);
const requests = [];
const managedToolPlans = new Map([
  ['managed workspace operations', [
    ['write', { file_path: 'permission-proof.txt', content: 'alpha' }],
    ['write', { file_path: 'keep.txt', content: 'keep after refusal' }],
    ['read', { file_path: 'permission-proof.txt' }],
    ['edit', { file_path: 'permission-proof.txt', old_string: 'alpha', new_string: 'beta' }],
    ['glob', { pattern: '*.txt' }], ['grep', { pattern: 'beta' }],
  ]],
  ['managed delete approved', [['assistant_delete_workspace_file', { file_path: 'permission-proof.txt' }]]],
  ['managed delete disconnected', [['assistant_delete_workspace_file', { file_path: 'keep.txt' }]]],
  ['managed delete offline', [['assistant_delete_workspace_file', { file_path: 'keep.txt' }]]],
  ['managed guarded shell', [['bash', { command: 'printf controlled > forbidden-shell.txt' }]]],
  ['managed restored write', [['write', { file_path: 'restored.txt', content: 'restored managed workspace' }]]],
  ['managed resumed schedule', [['write', { file_path: 'scheduled.txt', content: 'restored schedule workspace' }]]],
  ['browser task survives Studio Host exit', [
    ['glob', { path: '.assistant-inputs', pattern: '**/browser-native.txt' }],
    ['read', { file_path: `.assistant-inputs/${createHash('sha256').update(fileBytes).digest('hex')}/browser-native.txt` }],
  ]],
]);
const managedToolProgress = new Map();
let toolCalls = 0, pending;
const modelServer = createServer(async (request, response) => {
  try {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const lastUser = body.messages.findLast(item => item.role === 'user');
    const input = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map(part => part.text || '').join('');
    const images = (Array.isArray(lastUser.content) ? lastUser.content : []).filter(part => part.type === 'image_url').map(part => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(part.image_url?.url || '');
      assert.ok(match, 'native image input must arrive as actual provider image bytes');
      const bytes = Buffer.from(match[2], 'base64'); assert.ok(bytes.length > 0);
      return { mediaType: match[1], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    requests.push({ model: body.model, input, priorResponse: JSON.stringify(body.messages).includes('ASSISTANT_DONE'),
      images,
      identity: body.messages.filter(item => item.role === 'system').flatMap(item => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).split('\n')).find(line => line.startsWith('{"assistantName":')) || '' });
    // The real native session list enables DSH's independent title provider.
    // Its framed user text contains the task too, but it is not a tool turn.
    if (body.messages.some(item => item.role === 'system' && typeof item.content === 'string'
      && item.content.startsWith('Create a concise title for an AI coding-assistant session from the supplied human messages.'))) {
      const prefix = 'Generate the session title from this JSON array of human messages:\n';
      assert.ok(input.startsWith(prefix), 'official title provider must frame its source messages');
      const messages = JSON.parse(input.slice(prefix.length));
      assert.ok(Array.isArray(messages) && messages.length > 0 && messages.every(item => Number.isSafeInteger(item.seq) && typeof item.text === 'string'));
      assert.equal(body.tools?.length || 0, 0, 'title generation must not receive task tools');
      requests.at(-1).purpose = 'session-title';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ choices: [{ delta: { content: 'Browser attachment verification' }, finish_reason: 'stop' }] }));
      response.end('data: [DONE]\n\n'); return;
    }
    const planKey = [...managedToolPlans.keys()].find(key => input.includes(key));
    const plan = managedToolPlans.get(planKey), step = managedToolProgress.get(planKey) || 0;
    if (plan && step < plan.length) {
      const [name, args] = plan[step];
      assert.ok(body.tools?.some(tool => tool.function?.name === name), `real model schema must offer ${name}`);
      managedToolProgress.set(planKey, step + 1);
      requests.at(-1).requestedTool = name;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `managed-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }));
      response.end('data: [DONE]\n\n'); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ choices: [{ delta: { content: 'ASSISTANT_' }, finish_reason: null }] }));
    // Keep the cancellation fixture open until the real DSH controller aborts
    // its request. A fixed delay would make the target-identity check racy.
    if (input === 'cancel this exact task') return;
    await new Promise(resolve => setTimeout(resolve, 1500));
    response.write(frame({ choices: [{ delta: { content: "DONE\n\n## Markdown 验收\n\n- 原生列表\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 已渲染 |\n\n```js\nconsole.log(\"studio\");\n```\n\n[文档](https://example.com)\n\n[拒绝危险链接](javascript:alert(1))\n\n<img src=x onerror=\"globalThis.__studioMarkdownUnsafe=true\">" }, finish_reason: 'stop' }] }));
    response.end('data: [DONE]\n\n');
  } catch (error) {
    report.modelFailure = { name: error.name, code: error.code || 'MODEL_FIXTURE_ASSERTION', location: error.stack?.split('\n').filter(line => line.includes('verify-personal-assistant-host.mjs')).map(line => line.trim()).slice(0, 3) };
    if (!response.headersSent) response.writeHead(500);
    response.end('controlled fixture failed');
  }
});
modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
const fixtureId = randomUUID().slice(0, 8);
const profiles = ['a', 'b'].map(letter => ({ id: `frozen-${letter}-${fixtureId}`, modelName: `model-${letter}`, provider: 'openai-compatible', baseUrl, input: ['text', 'image'], credentialName: 'STUDIO_FROZEN_FIXTURE_KEY', enabled: true, default: letter === 'a' }));
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
    apply: ctx => {
      installAssistantStartupGuard(ctx, { ...env, ...runtime });
      return mountStudioHost(ctx, { env: { ...env, ...runtime }, configurationHome: home, resourceAdapterFactory });
    },
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
async function verifyControlIngress({ agentId, base, token, capabilities, waitFor }) {
  const { registerControlPlaneRoutes } = await loadStudio('host/routes/http.mjs');
  const { createAssistantRoutes } = await loadStudio('host/routes/assistant.mjs');
  const { createProductClient } = await loadStudio('remote/control-client.mjs');
  const { ASSISTANT_UPLOAD_CHANNEL, ASSISTANT_UPLOAD_RPC_PATH } = await loadStudio('contracts/assistant-attachments.mjs');
  const { Context } = require('@deepseek-ai/cordis');
  const { installConnection } = await import(pathToFileURL(join(source, 'packages/client/connection/lib/client.node.js')));
  // Only the deployment catalog is controlled. Production adapters perform the
  // real browser-envelope admission, cloud forwarding, upload and file reads.
  const releases = [], trace = [];
  const assistantRoutes = createAssistantRoutes({ assistantStoreDir: join(home, 'ingress-deletions'), deployments: async () => ({ agents: {
    connect: async id => { assert.equal(id, agentId); return { agent: { spec: { runtime: { type: 'dsh-native' } } }, endpoint: base, token, capabilities }; },
  } }) });
  const web = {
    connection: running.ctx.get('connection'),
    // Exact fixture routes share the real DSH listener and cookie audience. The
    // production registration still supplies both handlers and their admission.
    webServer: { register: route => ['/agentkit', ASSISTANT_UPLOAD_CHANNEL].includes(route.path)
      ? running.ctx.get('webServer').register({ ...route, kind: 'exact', path: `${route.path}/assistant/execute` }) : () => {} },
    effect: setup => { const release = setup(); if (typeof release === 'function') releases.push(release); },
  };
  await registerControlPlaneRoutes({ inject: (_services, apply) => apply(web) }, { models: {},
    dispatch: (endpoint, payload, signal) => assistantRoutes(endpoint, payload, signal), serverClientPromise: Promise.resolve({}) });
  const clientContext = new Context();
  try {
    const ingress = origin;
    const doFetch = (path, init) => {
      const url = new URL(path, ingress + '/');
      trace.push({ path: url.pathname, bytes: Buffer.byteLength(init.body), tokenExposed: init.body.includes(token) });
      return fetch(url, { ...init, headers: { ...init.headers, cookie, origin: ingress } });
    };
    // Public installConnection constructs the pinned native createWebConnectionRpc.
    // No fake rpc.call means channel grammar and rpcId envelopes are exercised.
    installConnection(clientContext, { transport: { fetch: doFetch } });
    const product = createProductClient(clientContext.get('connection'), { window: { location: new URL(ingress) } });
    const bytes = Buffer.alloc(800 * 1024, 97);
    const input = { kind: 'file', name: 'large-ingress.txt', data: bytes.toString('base64') };
    const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rejected-probe', method: 'assistant/execute', payload: { agentId, operation: 'attachment-upload', input } });
    assert.ok(Buffer.byteLength(envelope) > 1024 * 1024);
    const send = (path, body, headers = {}) => fetch(ingress + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await send(ASSISTANT_UPLOAD_RPC_PATH, '{}')).status, 401, 'the upload channel must retain real DSH authentication');
    assert.equal((await send(ASSISTANT_UPLOAD_RPC_PATH, '{}', { cookie, origin: 'http://other.invalid' })).status, 403, 'the upload channel must retain real DSH Origin admission');
    assert.equal((await send('/agentkit/assistant/execute', envelope, { cookie, origin: ingress })).status, 413, 'ordinary control RPC must retain its one-MiB bound');
    const uploaded = await product.assistantExecute(agentId, 'attachment-upload', input);
    assert.deepEqual(uploaded.attachment, { attachmentId: attachmentId(bytes), name: input.name, bytes: bytes.length });
    assert.equal(trace[0].path, ASSISTANT_UPLOAD_RPC_PATH); assert.ok(trace[0].bytes > 1024 * 1024);
    assert.equal(trace.some(row => row.tokenExposed), false, 'the browser RPC must never receive the cloud runtime token');
    assert.equal((await product.assistantExecute(agentId, 'submit', { requestId: 'large-ingress', content: [{ type: 'text', text: 'Read the large ingress attachment' }, receiptPart(uploaded)] })).accepted, true);
    await waitFor(value => value.status === 'completed' && userEvent(value, 'large-ingress'));
    const downloaded = await product.assistantExecute(agentId, 'file-read', { attachmentId: uploaded.attachment.attachmentId });
    assert.deepEqual(Buffer.from(downloaded.data, 'base64'), bytes); assert.deepEqual(downloaded.attachment, uploaded.attachment);
    assert.deepEqual(trace.slice(1).map(row => row.path), ['/agentkit/assistant/execute', '/agentkit/assistant/execute']);
    return { uploadEnvelopeBytes: trace[0].bytes, nativeRpc: 'installConnection/client.node', attachmentBytes: bytes.length };
  } finally {
    await clientContext.fiber.dispose();
    releases.reverse().forEach(release => release());
  }
}
try {
  await boot(); await mount();
  stage = 'create-frozen-dsh-assistant';
  const agent = await rpc('agents/create-local', { name: 'Assistant fixture', runtimeType: 'dsh-native', spec: { instructions: { system: 'Help the user.' }, bindings: { modelProfileId: profiles[0].id }, security: { assistantPermissions: { profile: 'workspace-managed/v1' } } } });
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
    const value = await response.json(); assert.equal(response.ok, true, `${op}: ${JSON.stringify(value)}`); return value;
  };
  const rejectedApi = async (op, payload, status, code) => {
    const response = await fetch(base + '/v1/assistant/' + op, { method: 'POST', headers, body: JSON.stringify(payload) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); assert.equal(value.error?.code, code);
  };
  const disconnectAfterSubmit = async payload => {
    const child = clientChild = spawn(process.execPath, ['--input-type=module', '-e', `
      process.on('message', async ({base,headers,payload}) => {
        const r=await fetch(base+'/v1/assistant/submit',{method:'POST',headers,body:JSON.stringify(payload)});
        process.send({status:r.status,value:await r.json()});
      });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const received = once(child, 'message'); child.send({ base, headers, payload });
    const [receipt] = await deadline(received); assert.equal(receipt.status, 202, JSON.stringify(receipt.value)); assert.equal(receipt.value.accepted, true);
    assert.notEqual((await api('snapshot')).status, 'completed');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; clientChild = undefined;
    return receipt.value;
  };
  const waitFor = async predicate => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const snapshot = await api('snapshot'); if (predicate(snapshot)) return snapshot; report.lastWait = { status: snapshot.status, asOfSeq: snapshot.asOfSeq, pendingCount: snapshot.pendingInteractions?.length, approval: snapshot.capabilities?.approval }; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Assistant result timed out');
  };
  const chatTool = async ({ requestId, text, name, args }) => {
    const before = (await api('snapshot')).asOfSeq;
    managedToolPlans.set(text, [[name, args]]);
    const receipt = await api('submit', { requestId, text });
    const snapshot = await waitFor(value => value.status === 'completed' && userEvent(value, requestId));
    const calls = snapshot.events.filter(event => event.seq > before && event.type === 'tool/call');
    const results = snapshot.events.filter(event => event.seq > before && event.type === 'tool/result');
    assert.deepEqual(calls.map(event => event.data.name), [name], 'natural chat must dispatch the actual native Schedule tool');
    assert.equal(results.length, 1); assert.equal(results[0].data.message.isError, false);
    return { receipt, snapshot, result: results[0].data.message };
  };
  stage = 'persist-assistant-identity';
  await api('identity-update', { assistantName: '小星', ownerName: '小夏' });
  assert.deepEqual((await api('snapshot')).identity, { assistantName: '小星', ownerName: '小夏' });
  stage = 'client-process-exit';
  // A disposable client process exits after durable acceptance while the actual
  // DSH Host is still calling the delayed model. This is transport evidence;
  // installed Desktop and pre-online acceptance are separate gates.
  await disconnectAfterSubmit({ requestId: 'first', text: 'continue after client exit' });
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
  stage = 'native-schedule-natural-chat-crud';
  await api('identity-update', { assistantName: '小月', ownerName: '小夏' });
  assert.equal(completed.scheduleEnabled, true);
  const schedule = running.ctx.get('schedule');
  assert.ok(schedule, 'the actual Host Schedule service must be enabled');
  const createdChat = await chatTool({ requestId: 'schedule-chat-create', text: '请在一小时后提醒我检查发布报告。', name: 'schedule_create',
    args: { title: '检查发布报告', prompt: '检查发布报告', after_seconds: 3600 } });
  const scheduleSessionId = createdChat.receipt.sessionId;
  assert.deepEqual(createdChat.snapshot.capabilities.execution.sessionTools, ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']);
  const createdTasks = await schedule.list({ sessionId: scheduleSessionId });
  assert.equal(createdTasks.length, 1); const chatTask = createdTasks[0];
  assert.equal(chatTask.title, '检查发布报告');
  const listedChat = await chatTool({ requestId: 'schedule-chat-list', text: '请列出我在这个会话里设置的提醒。', name: 'schedule_list', args: {} });
  assert.ok(JSON.stringify(listedChat.result).includes(chatTask.id));
  await chatTool({ requestId: 'schedule-chat-update', text: '把检查发布报告的提醒改成检查修订报告，两小时后提醒我。', name: 'schedule_update',
    args: { id: chatTask.id, title: '检查修订报告', prompt: '检查修订报告', at: new Date(Date.now() + 7_200_000).toISOString() } });
  const revisedTask = (await schedule.list({ sessionId: scheduleSessionId }))[0];
  assert.equal(revisedTask.id, chatTask.id); assert.equal(revisedTask.title, '检查修订报告'); assert.equal(revisedTask.prompt, '检查修订报告');
  assert.equal(revisedTask.kind, 'at');
  const foreignSessionId = 'controlled-other-schedule-session';
  const foreignTask = await schedule.create(foreignSessionId, { title: 'Other Session task', prompt: 'Keep other Session task', after_seconds: 3600 });
  const refusedChat = await chatTool({ requestId: 'schedule-chat-foreign', text: `删除另一个会话中的提醒 ${foreignTask.id}。`, name: 'schedule_delete', args: { id: foreignTask.id } });
  assert.ok(JSON.stringify(refusedChat.result).includes('schedule_not_found'));
  assert.deepEqual(await schedule.list({ sessionId: foreignSessionId }), [foreignTask]);
  await schedule.delete({ sessionId: foreignSessionId, id: foreignTask.id });
  await chatTool({ requestId: 'schedule-chat-delete', text: '取消刚才检查修订报告的提醒。', name: 'schedule_delete', args: { id: chatTask.id } });
  assert.deepEqual(await schedule.list({ sessionId: scheduleSessionId }), []);
  check('natural-chat-native-schedule-create-list-update-delete-and-session-isolation');
  stage = 'native-schedule-offline-delivery-history';
  const deliveryChat = await chatTool({ requestId: 'schedule-chat-due', text: '请在五秒后提醒我检查关闭客户端后的任务。', name: 'schedule_create',
    args: { title: '检查离线任务', prompt: 'timer while client is closed', after_seconds: 5 } });
  const offlineTask = (await schedule.list({ sessionId: scheduleSessionId }))[0];
  assert.ok(offlineTask);
  const scheduledSnapshot = await waitFor(value => value.status === 'completed' && value.lastTurnEndSeq > deliveryChat.snapshot.lastTurnEndSeq
    && value.events.some(event => event.seq > deliveryChat.snapshot.asOfSeq && event.type === 'user/message' && event.data.source.kind === 'schedule'));
  assert.equal(scheduledSnapshot.cloudSessionId, scheduleSessionId);
  const scheduled = (await schedule.catalog()).filter(item => item.sessionId === scheduleSessionId);
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].status, 'inactive');
  const deliveredHistory = await schedule.history({ sessionId: scheduleSessionId, id: offlineTask.id, limit: 100 });
  assert.equal(deliveredHistory.records.length, 1); assert.equal(deliveredHistory.records[0].prompt, 'timer while client is closed');
  assert.equal(deliveredHistory.records[0].messageId, scheduled[0].lastDelivery.messageId);
  const scheduledRequest = requests.findLast(row => row.input.includes('timer while client is closed'));
  assert.ok(scheduledRequest, 'the model must receive the scheduled task, not repeat the previous user input');
  assert.match(scheduledRequest.identity, /"assistantName":"小月"/, 'renames reach already live agents and scheduled work');
  check('native-chat-schedule-delivers-without-client-and-records-inbox-history', { acknowledgment: 'inbox-delivery', sessionId: scheduleSessionId });
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
  stage = 'native-scoped-turn-cancellation';
  await api('submit', { requestId: 'cancel-exact', text: 'cancel this exact task' });
  const active = await waitFor(value => value.status === 'running' && value.messages.some(item => item.requestId === 'cancel-exact'));
  assert.equal(active.capabilities.execution.scopedCancel, true);
  assert.ok(Number.isSafeInteger(active.currentTurn) && active.currentTurn > 0);
  assert.ok(Number.isSafeInteger(active.turnStartSeq) && active.turnStartSeq >= 0);
  assert.deepEqual(await api('cancel-turn', { turn: active.currentTurn, turnStartSeq: active.turnStartSeq + 1 }), { accepted: false, reason: 'turn-changed' });
  assert.equal((await api('snapshot')).status, 'running', 'a stale stop target must not cancel the live task');
  assert.equal((await api('cancel-turn', { turn: active.currentTurn, turnStartSeq: active.turnStartSeq })).accepted, true);
  const cancelled = await waitFor(value => value.status === 'cancelled');
  assert.ok(cancelled.events.some(event => event.type === 'turn/end' && event.data.turn === active.currentTurn && event.data.reason.kind === 'aborted'));
  assert.deepEqual(await api('cancel-turn', { turn: active.currentTurn, turnStartSeq: active.turnStartSeq }), { accepted: false, reason: 'turn-changed' });
  check('native-scoped-stop-rejects-stale-target-and-confirms-aborted-turn');
  stage = 'native-cloud-attachment-upload';
  const capabilities = (await api('snapshot')).capabilities;
  assert.equal(capabilities.input.files, true); assert.equal(capabilities.input.images, true);
  assert.equal(capabilities.display.files, true); assert.equal(capabilities.display.deliverables, 'metadata-only');
  const runtimeIdentity = await fetch(base + '/v1/agentkit/runtime', { headers }).then(response => response.json());
  for (const capability of ['personal-assistant-attachments/v1', 'personal-assistant-content/v1', 'personal-assistant-file-read/v1']) assert.ok(runtimeIdentity.capabilities.includes(capability));
  const upload = async kind => {
    const bytes = kind === 'image' ? png : fileBytes, name = kind === 'image' ? 'pixel.png' : 'notes.txt';
    const receipt = await api('attachment-upload', { kind, name, ...(kind === 'image' ? { mediaType: 'image/png' } : {}), data: bytes.toString('base64') });
    assert.match(receipt.receiptId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(receipt.attachment, { attachmentId: attachmentId(bytes), name, bytes: bytes.length });
    assert.equal(receipt.kind, kind); assert.equal(Object.hasOwn(receipt, 'data'), false);
    return receipt;
  };
  const callsBeforeUpload = requests.length;
  const picture = await upload('image'), document = await upload('file');
  const beforeAbandoned = new Set(running.ctx.get('agents').list().map(agent => agent.session.id));
  await api('attachment-upload', { conversation: 'abandoned-upload', kind: 'file', name: 'abandoned.txt', data: fileBytes.toString('base64') });
  const abandonedSessionId = running.ctx.get('agents').list().find(agent => !beforeAbandoned.has(agent.session.id))?.session.id;
  assert.ok(abandonedSessionId, 'an abandoned upload owns a durable native Session');
  assert.equal(requests.length, callsBeforeUpload, 'uploads alone must not run a prompt');
  assert.equal((await api('snapshot')).lastTurnEndSeq, cancelled.lastTurnEndSeq);
  check('native-cloud-upload-receipts-verify-original-bytes-without-prompt');
  stage = 'foreign-session-attachment-rejection';
  await rejectedApi('submit', { conversation: 'foreign-attachment', requestId: 'foreign-receipt', content: [receiptPart(document)] }, 409, 'ASSISTANT_ATTACHMENT_EXPIRED');
  await rejectedApi('file-read', { attachmentId: document.attachment.attachmentId }, 404, 'ASSISTANT_FILE_NOT_FOUND');
  assert.equal((await api('snapshot', { conversation: 'foreign-attachment' })).messages.length, 0);
  check('foreign-session-receipts-and-unsubmitted-file-downloads-are-rejected');
  stage = 'image-only-client-disconnect';
  const imageOnly = { requestId: 'image-only', content: [receiptPart(picture)] };
  const imageCallsBefore = requests.filter(row => row.images.length > 0).length;
  await disconnectAfterSubmit(imageOnly);
  const imageCompleted = await waitFor(value => value.status === 'completed' && userEvent(value, imageOnly.requestId));
  const nativeImage = userEvent(imageCompleted, imageOnly.requestId).data.content;
  assert.deepEqual(nativeImage.map(part => part.type), ['image']);
  assert.equal(nativeImage[0].attachment.width, 1); assert.equal(nativeImage[0].attachment.height, 1);
  assert.equal(requests.filter(row => row.images.length > 0).length, imageCallsBefore + 1);
  check('image-only-native-model-input-finishes-after-client-process-exit');
  stage = 'consumed-image-receipt-replay';
  await rejectedApi('submit', { ...imageOnly, requestId: 'spent-image-receipt' }, 409, 'ASSISTANT_ATTACHMENT_EXPIRED');
  assert.equal((await api('submit', imageOnly)).accepted, true);
  assert.equal((await api('snapshot')).lastTurnEndSeq, imageCompleted.lastTurnEndSeq);
  assert.equal(requests.filter(row => row.images.length > 0).length, imageCallsBefore + 1);
  check('consumed-image-receipt-replays-only-the-original-durable-request');
  stage = 'mixed-native-attachment-submit';
  const mixed = { requestId: 'mixed-attachments', content: [receiptPart(await upload('image')), { type: 'text', text: 'Read the mixed cloud attachments' }, receiptPart(document)] };
  assert.equal((await api('submit', mixed)).accepted, true);
  const mixedCompleted = await waitFor(value => value.status === 'completed' && userEvent(value, mixed.requestId));
  const nativeMixed = userEvent(mixedCompleted, mixed.requestId).data.content;
  assert.deepEqual(nativeMixed.map(part => part.type), ['image', 'text', 'file']);
  assert.deepEqual(nativeMixed[2].attachment, document.attachment);
  const mixedRequests = () => requests.filter(row => row.input.includes('Read the mixed cloud attachments'));
  assert.equal(mixedRequests().length, 1); assert.equal(mixedRequests()[0].images.length, 1);
  check('mixed-image-text-file-content-preserves-native-image-model-semantics');
  stage = 'native-file-download-integrity';
  const verifyDownload = async () => {
    const downloaded = await api('file-read', { attachmentId: document.attachment.attachmentId });
    assert.deepEqual(downloaded.attachment, document.attachment);
    const bytes = Buffer.from(downloaded.data, 'base64'); assert.deepEqual(bytes, fileBytes);
    assert.equal(attachmentId(bytes), downloaded.attachment.attachmentId); assert.equal(bytes.length, downloaded.attachment.bytes);
  };
  await verifyDownload();
  await rejectedApi('file-read', { conversation: 'foreign-attachment', attachmentId: document.attachment.attachmentId }, 409, 'ASSISTANT_FILE_UNAVAILABLE');
  check('native-file-download-sha-and-length-verified-with-session-isolation');
  stage = 'mixed-content-duplicate-and-conflict';
  await rejectedApi('submit', { requestId: 'spent-file-receipt', content: [receiptPart(document)] }, 409, 'ASSISTANT_ATTACHMENT_EXPIRED');
  await Promise.all([api('submit', mixed), api('submit', mixed)]);
  await rejectedApi('submit', { ...mixed, content: mixed.content.toReversed() }, 409, 'ASSISTANT_REQUEST_CONFLICT');
  assert.equal((await api('snapshot')).lastTurnEndSeq, mixedCompleted.lastTurnEndSeq); assert.equal(mixedRequests().length, 1);
  check('consumed-mixed-receipts-deduplicate-concurrent-replay-and-reject-changed-content');
  stage = 'attachment-fresh-host-replay';
  const imagesBeforeRestart = requests.filter(row => row.images.length > 0).length;
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  await boot(); await mount(runtime);
  assert.equal((await api('submit', imageOnly)).accepted, true); assert.equal((await api('submit', mixed)).accepted, true);
  assert.equal((await api('snapshot')).lastTurnEndSeq, mixedCompleted.lastTurnEndSeq); assert.equal(mixedRequests().length, 1);
  assert.equal((await api('snapshot')).status, 'completed'); assert.equal(requests.filter(row => row.images.length > 0).length, imagesBeforeRestart);
  await verifyDownload();
  check('fresh-host-replays-consumed-attachment-requests-without-model-rerun-and-restores-download');
  stage = 'native-browser-control-ingress-large-upload';
  check('native-browser-rpc-large-upload-authenticated-ingress-and-runtime-download', await verifyControlIngress({ agentId, base, token, capabilities: runtimeIdentity.capabilities, waitFor }));
  stage = 'managed-workspace-native-tools';
  const managedBefore = await api('snapshot'), managedFromSeq = managedBefore.asOfSeq;
  const managedReceipt = await api('submit', { requestId: 'managed-tools', text: 'managed workspace operations' });
  const managed = await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-tools'));
  assert.equal(managed.capabilities.execution.profile, 'workspace-managed/v1');
  assert.equal(managed.capabilities.execution.managed, true);
  assert.equal(managed.capabilities.execution.permission, 'workspace-write');
  assert.equal(managed.capabilities.execution.approval, 'ask');
  assert.equal(managed.capabilities.execution.arbitraryShell, false);
  assert.equal(managed.capabilities.execution.network, false);
  const managedAgent = running.ctx.get('agents').get(managedReceipt.sessionId);
  assert.ok(managedAgent);
  const managedCwd = managedAgent.session.header.cwd;
  assert.match(managedCwd.slice(scratch.length), /^\/assistant-workspaces\/[a-f0-9]{64}\/files$/);
  assert.equal(await readFile(join(managedCwd, 'permission-proof.txt'), 'utf8'), 'beta');
  assert.deepEqual(managed.events.filter(event => event.seq > managedFromSeq && event.type === 'tool/call').map(event => event.data.name), ['write', 'write', 'read', 'edit', 'glob', 'grep']);
  const routineResults = managed.events.filter(event => event.seq > managedFromSeq && event.type === 'tool/result');
  assert.equal(routineResults.length, 6); assert.ok(routineResults.every(event => event.data.message.isError === false));
  check('managed-new-session-real-workspace-write-read-edit-glob-grep');
  const guardedFromSeq = managed.asOfSeq;
  await api('submit', { requestId: 'managed-shell', text: 'managed guarded shell' });
  const guarded = await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-shell'));
  assert.ok(guarded.events.some(event => event.seq > guardedFromSeq && event.type === 'tool/result' && event.data.message.isError === true));
  await assert.rejects(access(join(managedCwd, 'forbidden-shell.txt')), { code: 'ENOENT' });
  check('managed-session-denies-general-shell-through-native-tool-pipeline');
  const openLiveCarrier = async () => {
    const carrier = await api('native-open');
    assert.equal(carrier.capabilities.owner, false); assert.equal(carrier.sessionId, managedReceipt.sessionId);
    await api('native-stream-open', { carrierId: carrier.carrierId, streamId: 'presence', endpoint: '$events', payload: { args: {} } });
    const first = await api('native-stream-poll', { carrierId: carrier.carrierId, streamId: 'presence' });
    assert.ok(first.items.some(item => item.type === 'ready')); assert.equal(first.ended, false);
    assert.equal((await api('snapshot')).capabilities.approval.interactive, true);
    // Match a live Client: renew presence through the real $events long poll,
    // never through ordinary snapshot traffic or a synthetic online flag.
    let closing = false, pollFailure;
    const polling = (async () => {
      try {
        while (!closing) {
          const value = await api('native-stream-poll', { carrierId: carrier.carrierId, streamId: 'presence' });
          if (!closing) assert.equal(value.ended, false, 'native presence stream ended unexpectedly');
        }
      } catch (error) { if (!closing) pollFailure = error; }
    })();
    carrier.close = async () => {
      closing = true; await api('native-close', { carrierId: carrier.carrierId }); await polling;
      if (pollFailure) throw pollFailure;
    };
    return carrier;
  };
  stage = 'native-carrier-real-source-graph';
  const carrier = await openLiveCarrier();
  const carrierCall = (op, data) => api(op, { carrierId: carrier.carrierId, ...data });
  const address = { kind: 'session', sessionId: carrier.sessionId };
  const catalog = await carrierCall('native-call', { channel: '/api', endpoint: 'session/list', payload: { args: { _request: {} } } });
  assert.equal(catalog.ok, true, JSON.stringify(catalog)); assert.deepEqual(catalog.value.items.map(item => item.sessionId), [carrier.sessionId]);
  const page = await carrierCall('native-call', { channel: '/api', endpoint: 'session/page', payload: { args: { request: { address, throughSeq: managedAgent.session.seq - 1, maxMessages: 16 } } } });
  assert.equal(page.ok, true, JSON.stringify(page)); assert.ok(page.value.records.length > 0);
  await carrierCall('native-stream-open', { streamId: 'follow', endpoint: 'session/follow', payload: { args: { request: { address, maxMessages: 16 } } } });
  const follow = await carrierCall('native-stream-poll', { streamId: 'follow' });
  const baseline = follow.items.find(item => item.type === 'snapshot');
  assert.ok(baseline); assert.equal(baseline.header.id, carrier.sessionId); assert.equal(Object.hasOwn(baseline.header, 'cwd'), false);
  await carrierCall('native-stream-cancel', { streamId: 'follow' });
  await carrierCall('native-stream-open', { streamId: 'control', endpoint: 'session/control', payload: { args: {} } });
  const control = await carrierCall('native-stream-poll', { streamId: 'control' });
  const controlBaseline = control.items.find(item => item.type === 'baseline');
  assert.ok(controlBaseline); assert.deepEqual(Object.keys(controlBaseline.value.projections), [carrier.sessionId]);
  await carrierCall('native-stream-cancel', { streamId: 'control' });
  check('real-non-owner-native-carrier-events-list-page-follow-control');
  stage = 'native-carrier-durable-prompt';
  const carrierPrompt = { sessionId: carrier.sessionId, requestId: 'native-carrier-durable', mode: 'queue', content: [{ type: 'text', text: 'native carrier durable queue' }] };
  const carrierAccepted = await carrierCall('native-call', { channel: '/api', endpoint: 'session/prompt', payload: { args: { request: carrierPrompt } } });
  assert.deepEqual(carrierAccepted, { ok: true, value: { accepted: true } });
  assert.equal((await api('snapshot')).status, 'running');
  await carrier.close();
  const carrierCompleted = await waitFor(value => value.status === 'completed' && userEvent(value, carrierPrompt.requestId));
  assert.equal(carrierCompleted.events.filter(event => event.type === 'user/message' && event.data.source.rpcId === carrierPrompt.requestId).length, 1);
  assert.equal(requests.filter(row => row.input === 'native carrier durable queue').length, 1);
  const approvalCarrier = await openLiveCarrier();
  const carrierReplay = await api('native-call', { carrierId: approvalCarrier.carrierId, channel: '/api', endpoint: 'session/prompt', payload: { args: { request: carrierPrompt } } });
  assert.deepEqual(carrierReplay, { ok: true, value: { accepted: true } });
  const carrierReplayed = await api('snapshot');
  assert.equal(carrierReplayed.status, 'completed');
  assert.equal(carrierReplayed.lastTurnEndSeq, carrierCompleted.lastTurnEndSeq);
  assert.equal(requests.filter(row => row.input === 'native carrier durable queue').length, 1);
  check('real-native-carrier-prompt-is-durable-after-close-and-replay-deduplicates');
  stage = 'managed-native-online-approval';
  const auditEvents = () => Array.from({ length: managedAgent.session.seq }, (_, seq) => managedAgent.session.eventAt(seq));
  const auditStart = managedAgent.session.seq;
  await api('submit', { requestId: 'managed-delete-approve', text: 'managed delete approved' });
  stage = 'managed-native-online-approval-pending';
  const asking = await waitFor(value => value.pendingInteractions.length === 1);
  const question = asking.pendingInteractions[0];
  assert.equal(question.toolName, 'assistant_delete_workspace_file');
  assert.match(question.presentation, /permission-proof\.txt/); assert.match(question.presentation, /SHA256 [a-f0-9]{64}/);
  assert.equal(question.canAllow, true);
  assert.equal((await api('approval-decide', { ...question, decision: 'allowed-once' })).accepted, true);
  stage = 'managed-native-approved-delete-completion';
  await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-delete-approve'));
  await assert.rejects(access(join(managedCwd, 'permission-proof.txt')), { code: 'ENOENT' });
  assert.ok(auditEvents().some(event => event.seq >= auditStart && event.type === 'approval/decided' && event.data.outcome === 'allowed-once'));
  assert.equal((await api('approval-decide', { ...question, decision: 'allowed-once' })).accepted, false);
  await approvalCarrier.close();
  check('managed-production-delete-requires-real-online-one-shot-native-approval');
  stage = 'managed-native-disconnect-refusal';
  const disconnectCarrier = await openLiveCarrier();
  await api('submit', { requestId: 'managed-delete-disconnect', text: 'managed delete disconnected' });
  const waiting = await waitFor(value => value.pendingInteractions.length === 1), stale = waiting.pendingInteractions[0];
  await disconnectCarrier.close();
  await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-delete-disconnect'));
  assert.equal(await readFile(join(managedCwd, 'keep.txt'), 'utf8'), 'keep after refusal');
  assert.equal((await api('approval-decide', { ...stale, decision: 'allowed-once' })).accepted, false);
  assert.equal((await api('snapshot')).capabilities.approval.interactive, false);
  check('closing-native-carrier-refuses-pending-delete-and-stale-answer');
  const offlineSeq = managedAgent.session.seq;
  await api('submit', { requestId: 'managed-delete-offline', text: 'managed delete offline' });
  const offline = await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-delete-offline'));
  assert.deepEqual(offline.pendingInteractions, []);
  assert.ok(auditEvents().some(event => event.seq >= offlineSeq && event.type === 'approval/decided' && event.data.outcome === 'unavailable'));
  assert.equal(await readFile(join(managedCwd, 'keep.txt'), 'utf8'), 'keep after refusal');
  check('unattended-sensitive-tool-finishes-refused-without-waiting-or-grant');
  stage = 'managed-runtime-disposal-guard';
  const restartChat = await chatTool({ requestId: 'schedule-chat-restart', text: '请在十秒后提醒我检查重新启动后的工作区。', name: 'schedule_create',
    args: { title: '检查重启工作区', prompt: 'managed resumed schedule', after_seconds: 10 } });
  const restartSchedule = (await running.ctx.get('schedule').list({ sessionId: managedReceipt.sessionId })).find(item => item.prompt === 'managed resumed schedule');
  assert.ok(restartSchedule); assert.equal(restartChat.receipt.sessionId, managedReceipt.sessionId);

  await fiber.dispose(); fiber = undefined;
  assert.equal(running.ctx.get('agents').get(managedReceipt.sessionId), managedAgent, 'this guard proof requires the same still-live native Agent');
  const closedCall = await running.ctx.get('tools').execute({ agent: managedAgent, name: 'write', arguments: { file_path: 'closed.txt', content: 'must not write' }, callId: 'closed-runtime-proof', signal: new AbortController().signal });
  assert.equal(closedCall.isError, true);
  await assert.rejects(access(join(managedCwd, 'closed.txt')), { code: 'ENOENT' });
  check('disposed-runtime-keeps-last-managed-agent-deny-guard');
  await running.shutdown.shutdown(0); running = undefined;
  stage = 'managed-fresh-host-workspace-recovery';
  await boot(); await mount(runtime);
  const coldPermissions = (await api('snapshot')).capabilities.execution;
  assert.equal(coldPermissions.permission, 'unknown'); assert.equal(coldPermissions.managed, false);
  const resumedSchedule = await waitFor(value => value.status === 'completed' && value.lastTurnEndSeq > restartChat.snapshot.lastTurnEndSeq
    && value.events.some(event => event.seq > restartChat.snapshot.asOfSeq && event.type === 'user/message' && event.data.source.kind === 'schedule'));
  assert.equal(resumedSchedule.cloudSessionId, managedReceipt.sessionId);
  const restartHistory = await running.ctx.get('schedule').history({ sessionId: managedReceipt.sessionId, id: restartSchedule.id, limit: 100 });
  assert.equal(restartHistory.records.length, 1); assert.equal(restartHistory.records[0].prompt, 'managed resumed schedule');
  assert.equal(await readFile(join(managedCwd, 'scheduled.txt'), 'utf8'), 'restored schedule workspace');
  check('chat-created-native-schedule-survives-host-restart-and-delivers-to-original-session', { acknowledgment: 'inbox-delivery', sessionId: managedReceipt.sessionId });
  await api('submit', { requestId: 'managed-restart', text: 'managed restored write' });
  const restoredManaged = await waitFor(value => value.status === 'completed' && userEvent(value, 'managed-restart'));
  assert.equal(restoredManaged.capabilities.execution.permission, 'workspace-write');
  assert.equal(restoredManaged.capabilities.execution.approval, 'ask');
  assert.equal(running.ctx.get('agents').get(managedReceipt.sessionId).session.header.cwd, managedCwd);
  assert.equal(await readFile(join(managedCwd, 'restored.txt'), 'utf8'), 'restored managed workspace');
  assert.equal(await readFile(join(managedCwd, 'keep.txt'), 'utf8'), 'keep after refusal');
  assert.equal(restoredManaged.capabilities.approval.interactive, false);
  check('fresh-host-validates-restored-managed-workspace-before-normal-work');
  if (process.env.STUDIO_VERIFY_UI === '1') {
    const native = process.env.STUDIO_VERIFY_NATIVE === '1';
    stage = native ? 'macos-ui' : 'web-ui';
    const { verifyPersonalAssistantUi } = await import('./verify-personal-assistant-ui.mjs');
    const { createAssistantRoutes } = await loadStudio('host/routes/assistant.mjs');
    const uiAgent = { metadata: { id: 'cloud-fixture', name: '云端助理验收' },
      deployment: { id: 'fixture-deployment', buildId, versionId: 'fixture-version' }, spec: { runtime: { type: 'dsh-native' } } };
    // Control ownership only. The production Host route adds receipt-bound
    // journalScope and performs native/attachment admission over real HTTP.
    const uiRoutes = createAssistantRoutes({ assistantStoreDir: join(scratch, 'ui-lifecycle'), deployments: async () => ({ agents: {
      list: async () => ({ items: [uiAgent] }),
      connect: async id => { assert.equal(id, uiAgent.metadata.id); return { agent: uiAgent, endpoint: base, token, capabilities: runtimeIdentity.capabilities }; },
    } }) });
    report.ui = await verifyPersonalAssistantUi({ source, installed,
      api: (operation, input = {}) => api(operation, { ...input, conversation: 'ui-acceptance' }),
      relay: (method, payload) => uiRoutes(method, method === 'assistant/execute' ? { ...payload, input: { ...payload.input, conversation: 'ui-acceptance' } } : payload),
      attachmentFixture: { name: 'browser-native.txt', bytes: fileBytes }, profiles, screenshot: target.replace(/\.json$/, '.png'), port: await freePort() });
    const browserWork = requests.filter(row => row.input.includes('browser task survives Studio Host exit'));
    assert.deepEqual(browserWork.filter(row => row.requestedTool).map(row => row.requestedTool), ['glob', 'read']);
    report.limits[2] = 'Controlled model and ownership catalog; real cloud deployment and memory extraction require separate acceptance.';
    check(native ? 'real-electron-ui-reopens-after-local-host-exits' : 'real-web-ui-reopens-after-local-host-exits');
  }
  stage = 'delete-dedicated-assistant';
  assert.ok((await running.ctx.get('sessionController').list({}, new AbortController().signal)).items.some(item => item.sessionId === abandonedSessionId));
  assert.equal(running.ctx.get('agents').get(abandonedSessionId), undefined, 'retirement must handle a persisted but cold abandoned upload');
  // Listing cold sessions queues cache writes independently of Session.flush.
  // Keep that actual native path hot at the destructive shutdown boundary.
  await Promise.all(Array.from({ length: 12 }, () => api('snapshot', { conversation: 'ui-acceptance' })));
  const deletion = await api('close');
  assert.equal(deletion.deleted, true); assert.equal(deletion.historyDeleted, true); assert.equal(deletion.memoryDeleted, true); assert.equal(deletion.workspaceDeleted, true);
  await assert.rejects(access(join(scratch, 'assistant-workspaces')), { code: 'ENOENT' });
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
  await assert.rejects(access(join(scratch, 'assistant-workspaces')), { code: 'ENOENT' });
  check('retirement-erases-managed-workspace-only-after-native-writers-stop');
  assert.equal(report.modelFailure, undefined);
  checksComplete = true;
} catch (error) {
  report.nativeAudit = running?.ctx.get('agents').list().filter(agent => agent.session.id.startsWith('assistant-')).map(agent => ({ status: agent.status, events: Array.from({ length: agent.session.seq }, (_, seq) => agent.session.eventAt(seq)).filter(event => ['approval/asked', 'approval/decided', 'tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)).slice(-20).map(event => ({ type: event.type, seq: event.seq, outcome: event.data.outcome, toolName: event.data.toolName || event.data.name, isError: event.data.message?.isError })) }));
  report.failure = { stage, name: error.name, code: error.code || 'VERIFY_FAILED', message: error.message, location: error.stack?.split('\n').filter(line => line.includes('verify-personal-assistant-host.mjs')).map(line => line.trim()).slice(0, 3) };
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
if (report.passed) delete report.lastWait;
await writeFile(target, JSON.stringify(report, null, 2) + '\n');
// This directory is this invocation's disposable profile copy, never the caller's
// installation. Keep failed fixtures only when explicitly requested for diagnosis.
if (process.env.STUDIO_VERIFY_KEEP_RUNTIME !== '1') await rm(scratch, { recursive: true, force: true });
process.removeListener('exit', recordIncompleteExit);
console.log(JSON.stringify(report));
