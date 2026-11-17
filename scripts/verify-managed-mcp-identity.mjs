/** Real DSH Host verification for MCP business identity.
 *
 *  Launches the actual DSH Host (`@deepseek-ai/dsh` CLI) from a built
 *  installation with an isolated `DSH_HOME`, binds one MCP server, drives one
 *  `RunAgent` turn, and asserts the MCP server observed the business caller.
 *
 *  This is the release-gate proof that the Native integration test cannot make:
 *  the identity has to survive a real Host process boundary, not just an
 *  in-process kernel.
 *
 *  Usage: AGENTKIT_DSH_INSTALLATION=<built DSH source checkout at dsh-pin.json:commit>
 *         node scripts/verify-managed-mcp-identity.mjs [--report <path>]
 *
 *  Exits 1 with a recorded reason when the installation is absent, so a missing
 *  build can never be mistaken for a passing gate.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { prepareManagedRuntimeHost } from '../src/managed-runtime-host.mjs';
import { dshPin } from './dsh-pin.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { report: { type: 'string' } } });
const installation = resolve(process.env.AGENTKIT_DSH_INSTALLATION || join(repository, '.ci-dsh'));
const result = { gate: 'managed-mcp-business-identity', installation, passed: false };
const started = Date.now();
const execute = promisify(execFile);

const fail = (code, detail) => Object.assign(new Error(detail || code), { code });
const freePort = () => new Promise(done => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

const platformSessionId = 'platform-session-42';
const firstTurn = 'Call the bound CRM tool with the first note.';
const secondTurn = 'Call the bound CRM tool with the follow-up note.';

/** Request the MCP tool once per user turn, then complete the model response. */
function modelServer() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push(parsed);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const user = messages.findLastIndex(message => message.role === 'user');
      const useTool = user >= 0 && messages.findLastIndex(message => message.role === 'tool') < user;
      const callId = JSON.stringify(messages[user] ?? '').includes(secondTurn) ? 'call-2' : 'call-1';
      const frame = useTool
        ? { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: '',
          tool_calls: [{ index: 0, id: callId, type: 'function',
            function: { name: 'save_crm', arguments: '{"note":"business"}' } }] } }] }
        : { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'saved' } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ server, requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(closed => { server.closeAllConnections(); server.close(closed); }) })));
}

/** Minimal MCP peer: records the identity the Host actually puts on the wire. */
function mcpServer() {
  const observed = [];
  const received = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    received.push({ method: message.method, params: message.params });
    if (message.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    let payload;
    if (message.method === 'initialize') {
      payload = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'business-identity-peer', version: '1' } };
    } else if (message.method === 'tools/list') {
      payload = { tools: [{ name: 'save_crm', description: 'Save one CRM note',
        inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }] };
    } else if (message.method === 'tools/call') {
      observed.push({ method: message.method, params: message.params, meta: message.params?._meta, headers: req.headers });
      payload = { content: [{ type: 'text', text: 'Committed MCP business effect' }] };
    } else { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'business-identity' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: payload }));
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ observed, received,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(closed => { server.closeAllConnections(); server.close(closed); }) })));
}

/** Assemble the layout `inspectRuntimeInstallation` expects from a built
 *  monorepo checkout, so the gate runs against real published bytes. */
async function assembleInstallation(root) {
  let actualCommit;
  try {
    actualCommit = (await execute('git', ['-C', installation, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
  } catch (error) {
    throw fail('DSH_INSTALLATION_NOT_CHECKOUT', `DSH installation must be a Git checkout: ${error.message}`);
  }
  if (actualCommit !== dshPin.commit) throw fail('DSH_INSTALLATION_PIN_MISMATCH',
    `DSH checkout ${actualCommit} does not match pinned commit ${dshPin.commit}`);
  const modules = join(root, 'installation', 'node_modules');
  await mkdir(join(modules, '@deepseek-ai'), { recursive: true });
  await mkdir(join(modules, '@kingsoftcloud'), { recursive: true });
  const cli = join(installation, 'apps/cli');
  const entry = join(cli, 'lib/bin.js');
  try { await readFile(entry); }
  catch { throw fail('DSH_INSTALLATION_INCOMPLETE', `Installation has no built CLI at ${entry}`); }
  await symlink(cli, join(modules, '@deepseek-ai/dsh'), 'dir').catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  // The Host installation follows the checked-out Studio package to calculate
  // its digest; the temporary package layout keeps DSH and Studio independent.
  await symlink(repository, join(modules, '@kingsoftcloud/agentkit-studio'), 'dir').catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  return join(root, 'installation');
}

let host, model, mcp;
try {
  const root = await mkdtemp(join(tmpdir(), 'mcp-identity-host-'));
  result.workspace = root;
  const state = join(root, 'state'), home = join(root, 'home'), cwd = join(root, 'cwd');
  await mkdir(state, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const installRoot = await assembleInstallation(root);
  mcp = await mcpServer();
  model = await modelServer();
  const token = 'managed-mcp-identity-runtime-token'.padEnd(48, 'x');
  const manifest = join(root, 'agentengine.yaml');
  const raw = stringify({
    name: 'identity-gate', framework: 'dsh-native', artifact_type: 'ManagedRuntime',
    runtime: { name: 'dsh-native', version: 'studio-identity.1' },
    model: 'fixture-model', prompt: 'Call the bound CRM tool with a short note.',
    resources: { mcp_servers: [{ id: 'crm', endpoint: mcp.url, transport: 'http',
      env_refs: { Authorization: 'MCP_CRM_TOKEN' } }] },
  });
  await writeFile(manifest, raw);
  const port = await freePort();
  const plan = await prepareManagedRuntimeHost({ manifest, state, installation: installRoot,
    env: { PATH: process.env.PATH, HOME: home, AGENTKIT_USER_HOME: home, AGENTKIT_WORKSPACE_ROOT: cwd,
      OPENAI_BASE_URL: model.url, AGENTKIT_MODEL_API_KEY: 'fixture-key', AGENTKIT_MANAGED_CODEX_API: 'chat-completions',
      AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(port), AGENTKIT_STRICT_RESOURCES: 'true',
      AGENTENGINE_AGENT_ID: 'ar-identity-gate', AGENTENGINE_AGENT_VERSION_ID: 'v1',
      AGENTENGINE_MANAGED_RUNTIME_NAME: 'dsh-native', AGENTENGINE_MANAGED_RUNTIME_VERSION: 'studio-identity.1',
      AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: plan_sha(raw),
      MCP_CRM_TOKEN: 'Bearer fixture-mcp-token' } });
  result.installedDshVersion = plan.identity.dshVersion;

  host = spawn(plan.entry, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  host.stdout.on('data', chunk => logs.push(String(chunk)));
  host.stderr.on('data', chunk => logs.push(String(chunk)));
  const exited = new Promise(done => host.once('exit', (code, signal) => done({ code, signal })));
  result.hostPid = host.pid;

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    const early = await Promise.race([exited.then(value => ({ exited: value })), Promise.resolve(null)]);
    if (early) throw fail('DSH_HOST_EXITED_EARLY', `Host exited before readiness: ${JSON.stringify(early.exited)}`);
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) { ready = true; break; }
    } catch { /* not listening yet */ }
    await new Promise(done => setTimeout(done, 500));
  }
  if (!ready) throw fail('DSH_HOST_NOT_READY', `Host did not answer /health within 90s: ${logs.join('').slice(-2000)}`);

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-agentengine-target-version-id': plan.identity.versionId,
    'x-agentengine-manifest-sha256': plan.identity.manifestSha256,
    'x-agentengine-identity-namespace': 'business', 'x-agentengine-business-tenant-id': 'tenant',
    'x-agentengine-subject-type': 'user', 'x-agentengine-subject-id': 'alice' };
  const run = async (InvocationId, ResponsesInput, attribution) => {
    const response = await fetch(`${base}/agentengine/api/v1/RunAgent`, {
      method: 'POST', headers,
      body: JSON.stringify({ AgentId: 'ar-identity-gate', SessionId: platformSessionId,
        InvocationId, ResponsesInput, Stream: true, ApiFormat: 'responses', ...attribution }),
    });
    const body = await response.text();
    if (!response.ok) throw fail('RUN_AGENT_FAILED', `RunAgent returned ${response.status}: ${logs.join('').slice(-2000)}`);
    const completed = body.split('\n').find(line => line.startsWith('data: ') && line.includes('"type":"response.completed"'));
    const reply = completed && JSON.parse(completed.slice(6)).response;
    if (reply?.session_id !== platformSessionId || !reply.conversation?.id)
      throw fail('RUN_AGENT_SESSION_MISSING', body.slice(-2000));
    return reply;
  };
  const first = await run('request-1001', firstTurn, { UserId: 'customer@example.com', BusinessSessionId: 'order-session-42' });
  const second = await run('request-1002', secondTurn);
  if (first.conversation.id !== second.conversation.id || first.id === second.id) throw fail('RUN_AGENT_SESSION_CHANGED');
  if (!model.requests.some(item => {
    const turns = JSON.stringify(item?.messages?.filter(message => message.role === 'user') ?? []);
    return turns.includes(firstTurn) && turns.includes(secondTurn);
  })) throw fail('PREVIOUS_TURN_NOT_IN_MODEL_CONTEXT');
  result.platformSessionId = platformSessionId;
  result.responseIds = [first.id, second.id];

  result.hostLogs = logs.join('').slice(-4000);
  result.modelRequestCount = model.requests.length;
  result.mcpMethods = mcp.received.map(item => item.method);
  if (!model.requests.length) throw fail('MODEL_NOT_CALLED', 'The model fixture was never called');
  if (!mcp.observed.length) throw fail('MCP_NOT_CALLED', 'The MCP server was never called');
  // Distinguish "the Host executed the tool without the identity channel" from
  // "the identity reached the server but was wrong" — they need different fixes.
  const call = mcp.observed.find(item => item.meta);
  if (!call) throw fail('MCP_IDENTITY_NOT_FORWARDED',
    `The Host executed tools/call without _meta or x-agentkit-* headers: ${JSON.stringify(mcp.observed[0]?.params)}`);
  const meta = call.meta['io.agentkit.studio/invocation'];
  result.observed = { meta, headers: Object.fromEntries(Object.entries(call.headers)
    .filter(([name]) => name.startsWith('x-agentkit-') || name === 'authorization')) };
  if (meta.source !== 'run-agent') throw fail('MCP_SOURCE_MISSING', JSON.stringify(meta));
  if (!meta.sessionId || !meta.nativeSessionId || meta.nativeSessionId !== meta.sessionId)
    throw fail('MCP_SESSION_ID_MISSING', JSON.stringify(meta));
  if (meta.invocationId !== 'request-1001' || meta.businessInvocationId !== 'request-1001')
    throw fail('MCP_INVOCATION_ID_MISSING', JSON.stringify(meta));
  if (meta.businessUserId !== 'customer@example.com') throw fail('BUSINESS_USER_MISSING', JSON.stringify(meta));
  if (meta.businessSessionId !== 'order-session-42') throw fail('BUSINESS_SESSION_MISSING', JSON.stringify(meta));
  if (call.headers['x-agentkit-invocation-source'] !== 'run-agent') throw fail('SOURCE_HEADER_MISSING');
  if (call.headers['x-agentkit-session-id'] !== meta.sessionId) throw fail('SESSION_HEADER_MISSING');
  if (call.headers['x-agentkit-business-user-id'] !== 'customer@example.com') throw fail('BUSINESS_USER_HEADER_MISSING');
  if (call.headers['x-agentkit-business-session-id'] !== 'order-session-42') throw fail('BUSINESS_SESSION_HEADER_MISSING');
  if (call.headers['x-agentkit-invocation-id'] !== 'request-1001'
    || call.headers['x-agentkit-business-invocation-id'] !== 'request-1001') throw fail('INVOCATION_HEADER_MISSING');
  if (call.headers.authorization !== 'Bearer fixture-mcp-token') throw fail('MCP_AUTHORIZATION_MUTATED');
  const nextCall = mcp.observed.find(item => item.headers['x-agentkit-invocation-id'] === 'request-1002');
  const nextMeta = nextCall?.meta?.['io.agentkit.studio/invocation'];
  if (nextMeta?.sessionId !== meta.sessionId || nextMeta.businessUserId !== meta.businessUserId
    || nextMeta.businessSessionId !== meta.businessSessionId
    || nextCall.headers['x-agentkit-business-user-id'] !== meta.businessUserId
    || nextCall.headers['x-agentkit-business-session-id'] !== meta.businessSessionId)
    throw fail('CONTINUED_MCP_IDENTITY_MISSING');
  result.passed = true;
} catch (error) {
  result.failure = { code: error.code || 'MANAGED_MCP_IDENTITY_VERIFICATION_FAILED', message: error.message };
  process.exitCode = 1;
} finally {
  result.elapsedMs = Date.now() - started;
  try { host?.kill('SIGTERM'); } catch { /* best effort */ }
  await model?.close().catch(() => {});
  await mcp?.close().catch(() => {});
  if (result.workspace) await rm(result.workspace, { recursive: true, force: true }).catch(() => {});
  if (values.report) {
    const reportPath = resolve(values.report);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result));
}

function plan_sha(value) {
  return createHash('sha256').update(value).digest('hex');
}
