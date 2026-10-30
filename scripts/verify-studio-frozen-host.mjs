/** Actual installed Host composition, frozen archive and DSH durable Session.
 * The loopback model and MCP provider are controlled; no cloud writes occur.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, readdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.AGENTKIT_DSH_ROOT;
if (!source || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated DSH source and homes');
const target = resolve(process.argv[2] || '.artifacts/refactor/stage-4/frozen-real-host.json');
await mkdir(dirname(target), { recursive: true });
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = await realpath(join(process.env.DSH_HOME, 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
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
const scratch = await mkdtemp(join(tmpdir(), 'studio-frozen-host-'));
const home = join(scratch, 'agentkit');
await mkdir(home);
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const report = { evidence: 'real-built-dsh-installed-host-frozen-build-controlled-model-and-mcp', installed, checks: [], passed: false,
  limits: ['Host roots are restarted in one Node process with real disk Session logs.', 'Model and MCP upstreams are controlled; OS installation and process upgrade are separate acceptance.'] };
const check = (name, details = {}) => report.checks.push({ name, ...details, passed: true });
const deadline = async (promise, ms = 15000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Verification timed out'), { code: 'VERIFY_TIMEOUT' })), ms); })]); }
  finally { clearTimeout(timer); }
};
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const requests = [];
const businessInputs = new Set(['hosted-first', 'hosted-second', 'tool-and-freeze', 'continue-context', 'alternate-model', 'check-model-after-replay', 'cancel-me', 'unload-me']);
let auxiliaryModelCalls = 0;
let toolCalls = 0, pending;
const modelServer = createServer(async (request, response) => {
  try {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const lastUser = body.messages.findLast(item => item.role === 'user');
    const input = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map(part => part.text || '').join('');
    // Native automatic titles also call this model. They have their own prompt,
    // no tool history, and must not enter business-turn/replay call accounting.
    if (!businessInputs.has(input)) {
      auxiliaryModelCalls++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frame({ choices: [{ delta: { content: 'Frozen runtime verification' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      return;
    }
    if (input === 'hosted-first' || input === 'hosted-second') {
      if (input === 'hosted-second') assert.ok(JSON.stringify(body.messages).includes('HOSTED_FIRST_OK'), 'Hosted follow-up must restore the prior native conversation');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frame({ choices: [{ delta: { content: input === 'hosted-first' ? 'HOSTED_FIRST_OK' : 'HOSTED_SECOND_OK' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      return;
    }
    const withTool = body.messages.some(item => item.role === 'tool' && JSON.stringify(item.content).includes('FROZEN_TOOL_OK'));
    requests.push({ model: body.model, frozenPrompt: JSON.stringify(body.messages[0]).includes('FROZEN_SYSTEM_A'), latestPrompt: JSON.stringify(body.messages[0]).includes('LATEST_SYSTEM_B'), withTool, input });
    assert.equal(body.model, ['alternate-model', 'check-model-after-replay'].includes(input) ? 'model-b' : 'model-a', 'the selected frozen model must match the admitted request');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (input === 'cancel-me' || input === 'unload-me') {
      const current = pending;
      response.on('close', () => current.closed.resolve());
      response.write(frame({ choices: [{ delta: { content: 'pending' }, finish_reason: null }] }));
      current.started.resolve(); return;
    }
    if (input === 'tool-and-freeze' && !withTool) {
      assert.ok(body.tools.some(item => item.function?.name === 'refactor_probe'));
      response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-frozen-probe', type: 'function', function: { name: 'refactor_probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    } else {
      assert.ok(withTool, 'tool result must survive continuation and durable history');
      response.write(frame({ choices: [{ delta: { content: input === 'tool-and-freeze' ? 'FIRST_FROZEN_OK' : ['alternate-model', 'check-model-after-replay'].includes(input) ? 'ALTERNATE_FROZEN_OK' : 'SECOND_FROZEN_OK' }, finish_reason: 'stop' }] }));
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    report.modelFailure = { name: error.name, code: error.code || 'MODEL_FIXTURE_ASSERTION' };
    if (!response.headersSent) { response.writeHead(500); response.end('controlled fixture failed'); }
    else response.destroy();
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
const env = { AGENTKIT_HOME: home, CODEX_HOME: join(home, 'codex') };
const resourceAdapterFactory = async () => ({
  listMcpTools: async () => [{ name: 'refactor_probe', description: 'Controlled frozen Host probe', inputSchema: { type: 'object', properties: {} } }],
  callMcpTool: async () => { toolCalls++; return { value: 'FROZEN_TOOL_OK' }; },
  close: async () => {},
});
const stdout = process.stdout.write.bind(process.stdout);
let launchUrl, output = '', running, fiber, cookie, origin, stage = 'startup', checksComplete = false;
const recordIncompleteExit = code => {
  report.failure ??= { stage, code: 'VERIFY_PROCESS_EXITED_BEFORE_COMPLETION', processCode: code };
  report.passed = false;
  report.modelRequests = requests.map(({ input, ...summary }) => summary);
  report.auxiliaryModelCalls = auxiliaryModelCalls;
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
  stage = 'host-compatibility';
  const compatibility = await rpc('host/compatibility');
  assert.deepEqual(compatibility.baseline, { required: '0.2.1-rc.2', actual: '0.2.1-rc.2', compatible: true });
  assert.deepEqual(compatibility.contract, { required: 1, actual: 1, compatible: true });
  assert.ok(Object.values(compatibility.features).every(feature => feature.available));
  check('running-dsh-baseline-and-live-capabilities', { compatibility });
  stage = 'freeze-and-update-agent';
  const agent = await rpc('agents/create-local', { name: 'Frozen Host fixture', runtimeType: 'harness', spec: { instructions: { system: 'FROZEN_SYSTEM_A' }, bindings: { modelProfileId: profiles[0].id, modelProfileIds: profiles.map(item => item.id), mcpServers: [{ resourceId: 'mcp-frozen-fixture' }], nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} } } } });
  const agentId = agent.metadata.id;
  const operation = await rpc('builds/create', { agentId, revision: 1 });
  let buildId = operation.buildId;
  const until = Date.now() + 10000;
  while (!buildId && Date.now() < until) {
    const result = (await rpc('operations/list', { resourceId: agentId })).items.find(item => item.id === operation.operationId);
    if (result?.status === 'FAILED') throw Object.assign(new Error('Build failed'), { code: result.error?.code || 'BUILD_FAILED' });
    buildId = result?.result?.buildId;
    if (!buildId) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.match(buildId, /^build_[0-9a-f]{20}$/);
  const changed = await rpc('agents/update-local', { agentId, spec: { ...agent.spec, instructions: { system: 'LATEST_SYSTEM_B' }, bindings: { ...agent.spec.bindings, modelProfileId: profiles[1].id } } });
  assert.equal(changed.metadata.revision, 2);
  const frozen = await createStudioBuild({ storeDir: join(home, 'studio') }).resolve(agentId, buildId);
  assert.equal(frozen.metadata.revision, 1); assert.equal(frozen.spec.bindings.modelProfileId, profiles[0].id);
  check('actual-archive-remains-revision-1-after-agent-revision-2', { agentId, buildId });
  await fiber.dispose(); fiber = undefined;
  const port = await freePort(), token = randomUUID() + randomUUID();
  const runtime = { AGENTKIT_RUNTIME_AGENT_ID: agentId, AGENTKIT_RUNTIME_BUILD_ID: buildId, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(port) };
  stage = 'missing-host-capability';
  const controllerForCompatibility = running.ctx.get('sessionController');
  const fingerprintDescriptor = Object.getOwnPropertyDescriptor(controllerForCompatibility, 'promptFingerprintVersion');
  assert.ok(fingerprintDescriptor);
  try {
    Object.defineProperty(controllerForCompatibility, 'promptFingerprintVersion', { ...fingerprintDescriptor, value: undefined });
    await mount({ ...runtime, AGENTKIT_STUDIO_DSH_VERSION: 'display-only-version' });
    const missing = await rpc('host/compatibility');
    assert.equal(missing.baseline.actual, '0.2.1-rc.2', 'display metadata must not establish Host identity');
    assert.equal(missing.features['frozen-runtime'].available, false);
    assert.equal(missing.features['agent-presets'].available, true);
    assert.deepEqual(missing.features['frozen-runtime'].missingCapabilities, ['request-fingerprint']);
    await rpc('settings/get');
    assert.equal((await rpc('agents/local-get', { agentId })).metadata.id, agentId);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/agentkit/runtime`, { signal: AbortSignal.timeout(2000) }));
    check('missing-fingerprint-disables-runtime-with-management-available', { faultInjection: 'remove capability from the isolated real Session Controller', studioScopeActive: fiber.state === 2 });
    await fiber.dispose(); fiber = undefined;
  } finally {
    Object.defineProperty(controllerForCompatibility, 'promptFingerprintVersion', fingerprintDescriptor);
  }
  await mount(runtime);
  assert.equal((await rpc('host/compatibility')).features['frozen-runtime'].available, true);
  const runtimeOrigin = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = body => fetch(runtimeOrigin + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const identity = await (await fetch(runtimeOrigin + '/v1/agentkit/runtime', { headers })).json();
  assert.equal(identity.buildId, buildId); assert.deepEqual(identity.models, ['model-a', 'model-b']);
  stage = 'first-frozen-tool-turn';
  const firstRequest = { input: 'tool-and-freeze', session_id: 'frozen-conversation', request_id: 'first', model: 'model-a' };
  const firstResponse = await post(firstRequest), first = await firstResponse.json();
  if (firstResponse.status !== 200) {
    const request = createRuntimeResponsesContract({ agentId, buildId, token, model: 'model-a', models: ['model-a'] }).parse(firstRequest, {});
    const native = await running.ctx.sessionController.resolveAgent(request.sessionId);
    const reason = native.agent?.session.snapshotEvents().findLast(item => item.type === 'turn/end')?.data.reason;
    report.runtimeFailure = { status: firstResponse.status, code: first.error?.code, nativeCode: reason?.error?.code, nativeMessage: reason?.error?.message?.slice(0, 250) };
  }
  assert.equal(firstResponse.status, 200, first.error?.code);
  assert.equal(first.output_text, 'FIRST_FROZEN_OK'); assert.equal(toolCalls, 1);
  assert.equal(first.metadata.agentkit.buildId, buildId);
  assert.ok(requests.every(item => item.model === 'model-a' && item.frozenPrompt && !item.latestPrompt));
  check('frozen-model-and-mcp-tool-continuation', { modelCalls: requests.length, toolCalls });
  const sessionId = createRuntimeResponsesContract({ agentId, buildId, token, model: 'model-a', models: ['model-a'] }).parse(firstRequest, {}).sessionId;
  const route = resolveRuntimeBridge(running.ctx).getRoute(sessionId);
  assert.equal(route.buildId, buildId); assert.equal(route.agentRevision, 1); assert.equal(route.agentId, agentId);
  stage = 'host-restart-and-replay';
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  await boot(); await mount(runtime);
  const beforeReplay = requests.length;
  const replayResponse = await post(firstRequest), replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200, replay.error?.code);
  assert.equal(replay.id, first.id); assert.equal(replay.output_text, first.output_text); assert.equal(requests.length, beforeReplay);
  check('new-host-restores-build-preset-and-replays-without-model-call');
  stage = 'second-turn-after-restart';
  const secondResponse = await post({ input: 'continue-context', previous_response_id: first.id, request_id: 'second', model: 'model-a' });
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200, second.error?.code);
  assert.equal(second.output_text, 'SECOND_FROZEN_OK'); assert.equal(second.session_id, first.session_id); assert.equal(toolCalls, 1);
  const historySignal = AbortSignal.timeout(10000);
  const projection = await running.ctx.sessionController.projections({ sessionId }, historySignal);
  const history = await running.ctx.sessionController.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 200 }, historySignal);
  const events = history.records.filter(item => item.type === 'event').map(item => item.event);
  assert.equal(events.filter(item => item.type === 'turn/end' && item.data.reason.kind === 'completed').length, 2);
  assert.equal(events.filter(item => item.type === 'tool/call').length, 1);
  assert.equal(events.filter(item => item.type === 'tool/result').length, 1);
  assert.equal(events.filter(item => item.type === 'studio/runtime-model').length, 0);
  assert.ok(events.filter(item => item.type === 'user/message' && item.data.source?.rpcId).every(item => /^[a-f0-9]{64}$/.test(item.data.source.requestFingerprint)));
  check('durable-session-tool-result-and-run-identities', { completedTurns: 2, toolCalls: 1, model: 'model-a' });
  stage = 'generic-hosted-native-history';
  const hostedHeaders = { ...headers, 'x-agentengine-identity-namespace': 'kscloud-iam',
    'x-agentengine-business-tenant-id': 'fixture-tenant', 'x-agentengine-subject-type': 'user', 'x-agentengine-subject-id': 'fixture-owner' };
  const hostedAction = (action, payload = {}, extraHeaders = {}) => fetch(`${runtimeOrigin}/agentengine/api/v1/${action}`, {
    method: 'POST', headers: { ...hostedHeaders, ...extraHeaders }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  const hostedSession = 'sess-hosted-real-dsh';
  const create = await hostedAction('CreateSession', { SessionId: hostedSession });
  assert.equal(create.status, 200, await create.clone().text());
  const invoke = async (input, invocation) => {
    const response = await hostedAction('RunAgent', { SessionId: hostedSession, InvocationId: invocation, ResponsesInput: input, Stream: true, Model: 'model-a' });
    const stream = await response.text();
    assert.equal(response.status, 200, stream); assert.ok(stream.includes('response.completed'), stream);
    assert.ok(stream.includes(input === 'hosted-first' ? 'HOSTED_FIRST_OK' : 'HOSTED_SECOND_OK'), stream);
    return stream;
  };
  await invoke('hosted-first', 'hosted-one');
  const firstPage = await (await hostedAction('ListSessionMessages', { SessionId: hostedSession })).json();
  assert.deepEqual(firstPage.Data.Messages.map(message => message.Content.text), ['hosted-first', 'HOSTED_FIRST_OK']);
  await fiber.dispose(); fiber = undefined; await running.shutdown.shutdown(0); running = undefined;
  await boot(); await mount(runtime);
  const coldPage = await (await hostedAction('ListSessionMessages', { SessionId: hostedSession })).json();
  assert.deepEqual(coldPage.Data, firstPage.Data, 'A cold Host restores exact native messages and epoch');
  await invoke('hosted-second', 'hosted-two');
  const nextPage = await (await hostedAction('ListSessionMessages', { SessionId: hostedSession })).json();
  assert.deepEqual(nextPage.Data.Messages.map(message => message.Content.text), ['hosted-first', 'HOSTED_FIRST_OK', 'hosted-second', 'HOSTED_SECOND_OK']);
  assert.equal(nextPage.Data.Messages.at(-1).InvocationId, 'hosted-two');
  const allEvents = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, Limit: 1000 })).json()).Data;
  let eventPage = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, Limit: 3 })).json()).Data;
  let pagedEvents = eventPage.Events;
  for (let page = 0; eventPage.HasMore && page < 20; page++) {
    assert.ok(eventPage.NextCursor);
    eventPage = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, Limit: 3,
      BeforeSeqId: eventPage.NextCursor, HistoryEpoch: eventPage.HistoryEpoch, SnapshotSeqId: eventPage.SnapshotSeqId })).json()).Data;
    pagedEvents = [...eventPage.Events, ...pagedEvents];
  }
  assert.deepEqual(pagedEvents.map(event => event.SeqId), allEvents.Events.map(event => event.SeqId), 'Small reverse event pages preserve every native run boundary');
  let offset = 0, offsetEvents = [];
  do {
    const page = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, Offset: offset, Limit: 3,
      HistoryEpoch: allEvents.HistoryEpoch, SnapshotSeqId: allEvents.SnapshotSeqId })).json()).Data;
    assert.equal(page.Total, allEvents.Events.length);
    offsetEvents = [...page.Events, ...offsetEvents]; offset += page.Events.length;
    if (!page.HasMore) break;
    assert.ok(page.Events.length);
  } while (offset <= allEvents.Events.length);
  assert.deepEqual(offsetEvents, allEvents.Events, 'Hosted UI offset pages must restore all native events once');
  let after = 0, forwardEvents = [], forwardPage;
  do {
    forwardPage = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, EventOrder: 'session_seq', AfterSeqId: after, Limit: 3,
      HistoryEpoch: allEvents.HistoryEpoch, SnapshotSeqId: allEvents.SnapshotSeqId })).json()).Data;
    assert.equal(forwardPage.EventOrder, 'session_seq'); assert.ok(Number.isSafeInteger(forwardPage.NextCursor));
    forwardEvents.push(...forwardPage.Events);
    assert.ok(!forwardPage.HasMore || forwardPage.NextCursor > after); after = forwardPage.NextCursor;
  } while (forwardPage.HasMore);
  assert.deepEqual(forwardEvents, allEvents.Events, 'session_seq pages acknowledge each native event once');
  const upper = allEvents.Events[Math.floor(allEvents.Events.length / 2)].SeqId;
  for (const lower of [undefined, allEvents.Events[0].SeqId]) {
    const bounded = (await (await hostedAction('ListSessionEvents', { SessionId: hostedSession, EventOrder: 'session_seq', BeforeSeqId: upper,
      ...(lower === undefined ? {} : { AfterSeqId: lower }), Limit: 1000, HistoryEpoch: allEvents.HistoryEpoch, SnapshotSeqId: allEvents.SnapshotSeqId })).json()).Data;
    assert.deepEqual(bounded.Events, allEvents.Events.filter(event => event.SeqId < upper && event.SeqId > (lower ?? 0)));
    assert.equal(bounded.HasMore, false); assert.equal(bounded.SnapshotSeqId, allEvents.SnapshotSeqId);
  }
  assert.equal((await hostedAction('ListSessionMessages', { SessionId: hostedSession }, { 'x-agentengine-subject-id': 'foreign' })).status, 404);
  check('generic-hosted-responses-and-native-history-after-cold-host-restart', { turns: 2, messages: 4, principalIsolation: true, epoch: nextPage.Data.HistoryEpoch });
  const unbound = await post({ input: 'unbound', request_id: 'unbound', model: 'model-outside-build' });
  assert.equal(unbound.status, 400); assert.equal((await unbound.json()).error.code, 'RESPONSES_FROZEN_MODEL_MISMATCH');
  check('unbound-model-cannot-enter-old-build');

  stage = 'model-switch-restart-and-old-request-replay';
  const alternateResponse = await post({ input: 'alternate-model', previous_response_id: first.id, request_id: 'alternate', model: 'model-b' });
  assert.equal(alternateResponse.status, 200);
  assert.equal((await alternateResponse.json()).output_text, 'ALTERNATE_FROZEN_OK');
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  const durableBefore = await sessionBytes();
  await boot(); await mount(runtime);
  const callsBefore = requests.length;
  const oldReplayResponse = await post(firstRequest), oldReplay = await oldReplayResponse.json();
  assert.equal(oldReplayResponse.status, 200, oldReplay.error?.code);
  assert.equal(oldReplay.id, first.id); assert.equal(oldReplay.output_text, first.output_text);
  const conflict = await post({ ...firstRequest, model: 'model-b' });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'RUNTIME_REQUEST_CONFLICT');
  assert.equal(requests.length, callsBefore); assert.equal(toolCalls, 1);
  assert.deepEqual(await sessionBytes(), durableBefore, 'replay and rejection must preserve existing JSONL bytes');
  check('native-fingerprint-survives-restart-and-rejects-model-conflict-without-writing', { modelCallsDuringReplay: 0, toolCallsDuringReplay: 0 });
  const legacyRequest = { input: 'check-model-after-replay', session_id: first.session_id, request_id: 'legacy-source', model: 'model-b' };
  const legacyIdentity = createRuntimeResponsesContract({ agentId, buildId, token, model: 'model-a', models: ['model-a', 'model-b'] }).parse(legacyRequest, {});
  const restored = await running.ctx.sessionController.resolveAgent(sessionId);
  assert.equal(restored.error, undefined);
  // Independently admit one legacy-shaped request into this synthetic Session.
  // Its deliberately stale display event must not override native request headers.
  restored.agent.session.append('studio/runtime-model', { requestId: legacyIdentity.runId, model: 'model-a' }, { ignorable: true });
  await running.ctx.sessionController.prompt({ sessionId, requestId: legacyIdentity.runId, mode: 'queue', content: [{ type: 'text', text: legacyRequest.input }] }, AbortSignal.timeout(30000));
  await deadline(restored.agent.whenIdle(), 30000);
  assert.equal(requests.at(-1).model, 'model-b');
  assert.equal(restored.agent.session.snapshotEvents().findLast(item => item.type === 'turn/end').data.reason.kind, 'completed');
  check('replay-does-not-change-restored-current-model', { model: 'model-b' });
  assert.equal(restored.agent.session.snapshotEvents().findLast(item => item.type === 'user/message' && item.data.source?.rpcId === legacyIdentity.runId).data.source.requestFingerprint, undefined);
  await fiber.dispose(); fiber = undefined;
  await running.shutdown.shutdown(0); running = undefined;
  const legacyBytes = await sessionBytes();
  await boot(); await mount(runtime);
  const beforeLegacy = requests.length;
  const legacyReplay = await post(legacyRequest);
  assert.equal(legacyReplay.status, 200); assert.equal((await legacyReplay.json()).output_text, 'ALTERNATE_FROZEN_OK');
  const legacyConflict = await post({ ...legacyRequest, model: 'model-a' });
  assert.equal(legacyConflict.status, 409); assert.equal((await legacyConflict.json()).error.code, 'RUNTIME_REQUEST_CONFLICT');
  assert.equal(requests.length, beforeLegacy);
  assert.deepEqual(await sessionBytes(), legacyBytes, 'legacy replay must neither rewrite nor append to old logs');
  check('legacy-native-header-replay-ignores-stale-optional-model-event', { model: 'model-b', modelCallsDuringReplay: 0 });


  for (const outcome of ['claimed', 'canceled']) {
    stage = `native-prompt-${outcome}-identity`;
    const controller = running.ctx.sessionController;
    const resolved = await controller.resolveAgent(sessionId);
    assert.equal(resolved.error, undefined);
    const agent = resolved.agent, held = Promise.withResolvers(), release = Promise.withResolvers();
    let firstGate = true;
    const unobserve = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (!firstGate) return next();
      firstGate = false; held.resolve(); await release.promise; return next();
    });
    const request = { sessionId, requestId: `identity-${outcome}-${randomUUID()}`, requestFingerprint: 'fingerprint-a',
      mode: 'queue', content: [{ type: 'text', text: 'check-model-after-replay' }] };
    const signal = AbortSignal.timeout(30000);
    const before = requests.length;
    try {
      if (outcome === 'canceled') {
        await controller.prompt({ ...request, requestId: `blocking-${request.requestId}` }, signal);
        await deadline(held.promise);
      }
      await controller.prompt(request, signal);
      if (outcome === 'claimed') await deadline(held.promise);
      else { agent.cancel({ kind: 'user' }); release.resolve(); await deadline(agent.whenIdle()); }
      const acceptedEvents = agent.session.snapshotEvents();
      assert.ok(acceptedEvents.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source?.rpcId === request.requestId)));
      assert.ok(!acceptedEvents.some(event => event.type === 'user/message' && event.data.source?.rpcId === request.requestId));
      assert.equal(agent.inbox.nextTurn.length, 0);
      assert.deepEqual(await controller.prompt(request, signal), { accepted: true });
      await assert.rejects(controller.prompt({ ...request, requestFingerprint: 'fingerprint-b' }, signal), { code: 'session/request-conflict' });
      assert.deepEqual(agent.session.snapshotEvents(), acceptedEvents);
      assert.equal(agent.inbox.nextTurn.length, 0); assert.equal(requests.length, before);
      check(`native-${outcome}-request-retains-accepted-fingerprint`, { modelCallsDuringRetry: 0 });
    } finally {
      agent.cancel({ kind: 'user' }); release.resolve(); unobserve(); await deadline(agent.whenIdle());
    }
  }
  for (const kind of ['cancel-me', 'unload-me']) {
    stage = kind;
    pending = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
    const response = await fetch(runtimeOrigin + '/runs', { method: 'POST', headers, body: JSON.stringify({ input: kind, sessionId: kind, requestId: kind, stream: true }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let initial = '';
    while (!initial.includes('\n\n')) initial += new TextDecoder().decode((await deadline(reader.read())).value);
    const started = JSON.parse(initial.split('\n').find(line => line.startsWith('data: ')).slice(6));
    const { runId, sessionId: pendingSessionId } = started;
    assert.match(runId, /^run_[a-f0-9]{32}$/);
    await deadline(pending.started.promise);
    const bridge = resolveRuntimeBridge(running.ctx);
    if (kind === 'cancel-me') {
      const cancelled = await fetch(runtimeOrigin + `/runs/${runId}/cancel`, { method: 'POST', headers });
      assert.equal(cancelled.status, 202); await cancelled.json();
    } else { await fiber.dispose(); fiber = undefined; }
    await deadline(pending.closed.promise);
    let remainder = '';
    try { while (true) { const part = await deadline(reader.read()); if (part.done) break; remainder += new TextDecoder().decode(part.value); } } catch (error) { if (kind !== 'unload-me') throw error; }
    if (kind === 'cancel-me') assert.match(remainder, /RUNTIME_CANCELLED/);
    else { assert.equal(bridge.diagnostics().closed, true); assert.equal(bridge.diagnostics().requests, 0); }
    const resolved = await running.ctx.sessionController.resolveAgent(pendingSessionId);
    assert.equal(resolved.error, undefined);
    await deadline(resolved.agent.whenIdle());
    const ends = resolved.agent.session.snapshotEvents().filter(item => item.type === 'turn/end');
    assert.equal(ends.length, 1); assert.equal(ends[0].data.reason.kind, 'aborted');
    check(kind === 'cancel-me' ? 'live-frozen-stream-cancel-reaches-model-socket' : 'host-scope-unload-cancels-frozen-stream-and-releases-bridge', { terminalCount: 1, terminalKind: 'aborted' });
  }
  assert.equal(report.modelFailure, undefined);
  checksComplete = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFY_FAILED', location: error.stack?.split('\n').find(line => line.includes('verify-studio-frozen-host.mjs'))?.trim() };
  process.exitCode = 1;
} finally {
  report.modelRequests = requests.map(({ input, ...summary }) => summary);
  report.auxiliaryModelCalls = auxiliaryModelCalls;
  stage = 'final-host-cleanup';
  await fiber?.dispose();
  if (running) {
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
