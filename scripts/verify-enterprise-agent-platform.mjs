/** Honest LOCAL enterprise business + coding Agent vertical acceptance.

  Drives the SAME production NativeKernel and the actual packed Studio Host with
  a real maintained DSH CLI/SDK. A local OpenAI-compatible model HTTP endpoint
  supplies deterministic fixture responses (protocol/integration evidence, not
  model-quality or token-performance benchmarks) and a real local MCP HTTP
  server provides genuine CRM data outcomes; workspace tools read/write real
  files. Agents/Builds/presets use authenticated /agentkit RPC; Sessions/turns
  enter through the real SDK/controller. No direct store create/build/admission
  or replacement executor is used.

  Usage: node scripts/verify-enterprise-agent-platform.mjs \
          --source .artifacts/dsh-native-zcode --archive <Studio.tgz> [--keep] */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dshPresetId } from '../src/agent-preset-admission.mjs';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean', default: false },
} });
assert.ok(values.source && values.archive, 'Use --source <maintained built DSH> --archive <Studio.tgz>');
const repository = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(values.source), archive = resolve(values.archive);
const root = await mkdtemp(join(tmpdir(), 'studio-enterprise-agent-'));
console.log(`Studio enterprise agent platform evidence: ${root}`);

const failures = [];
const modelRequests = [];
const mcpCalls = [];
let passed = false;
const pause = () => new Promise(r => setTimeout(r, 50));
async function until(label, read, timeout = 30000) { const d = Date.now() + timeout; while (Date.now() < d) { const v = await read(); if (v) return v; await pause(); } throw Error(`Timed out waiting for ${label}`); }
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
async function jsonl(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }

// ---- Real local MCP HTTP server (genuine CRM scratch data) ----
// Speaks the MCP streamable-HTTP protocol the production adapter consumes
// (StreamableHTTPClientTransport). read_customer_record reads a scratch file;
// append_approval appends a receipt to a scratch ledger. Both are real data.
const crmFile = join(root, 'crm.json');
await writeFile(crmFile, JSON.stringify({ 'C-1024': { customer_id: 'C-1024', name: 'Acme Corp', current_credit_limit: 30000, status: 'active' } }));
const approvalsFile = join(root, 'approvals.jsonl');
const mcpTools = [
  { name: 'read_customer_record', description: 'Read a customer record from the local CRM', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
  { name: 'append_approval', description: 'Append an approval outcome with a receipt', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, decision: { type: 'string' }, credit_limit: { type: 'number' }, approver: { type: 'string' } }, required: ['customer_id', 'decision', 'credit_limit', 'approver'] } },
];
const mcpServer = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') { res.writeHead(405, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const outs = [];
    for (const r of reqs) {
      const { id, method } = r;
      if (method === 'initialize') {
        outs.push({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'enterprise-crm', version: '1.0.0' } } });
      } else if (method === 'notifications/initialized') {
        // notification (no id): no result, caller accepts 202
      } else if (method === 'tools/list') {
        outs.push({ jsonrpc: '2.0', id, result: { tools: mcpTools } });
      } else if (method === 'tools/call') {
        const { name, arguments: args = {} } = r.params || {};
        mcpCalls.push({ name, args, endpoint: req.url });
        let text;
        if (name === 'read_customer_record') {
          const crm = JSON.parse(await readFile(crmFile, 'utf8'));
          const record = crm[args.customer_id] || { customer_id: args.customer_id, name: 'Unknown', current_credit_limit: 0, status: 'unknown' };
          text = JSON.stringify(record);
        } else if (name === 'append_approval') {
          const receipt = { receipt_id: 'R' + Date.now(), customer_id: args.customer_id, decision: args.decision, credit_limit: args.credit_limit, approver: args.approver, timestamp: new Date().toISOString() };
          await writeFile(approvalsFile, (await readFile(approvalsFile, 'utf8').catch(() => '')).trim() + '\n' + JSON.stringify(receipt) + '\n');
          text = JSON.stringify({ receipt_id: receipt.receipt_id, status: 'recorded', customer_id: args.customer_id });
        } else { text = JSON.stringify({ error: 'unknown tool' }); }
        outs.push({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
      } else if (id !== undefined) {
        outs.push({ jsonrpc: '2.0', id, result: {} });
      }
    }
    if (req.method === 'POST' && reqs.some(r => r.method === 'notifications/initialized') && outs.length === 0) {
      res.writeHead(202); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'enterprise-crm-session' });
    res.end(JSON.stringify(Array.isArray(body) ? outs : outs[0] || {}));
  } catch (error) { failures.push(error); res.writeHead(500); res.end('MCP fixture failed'); }
});

// ---- Local OpenAI-compatible model (deterministic fixture responses) ----
// Responses are protocol/integration evidence, NOT model-quality or token
// benchmarks. Routing is by the real model codec's assembled tools/system/tools.
const BUSINESS_ORIGINAL_SYSTEM = 'BUSINESS_ORIGINAL_SYSTEM';
const BUSINESS_EDITED_SYSTEM = 'BUSINESS_EDITED_SYSTEM';
const CODING_SYSTEM = 'CODING_AGENT_SYSTEM';
const modelServer = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); modelRequests.push(body);
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(modelRequests, null, 2));
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(body.model, 'pinned');
    const tools = (body.tools || []).map(t => t.function?.name || t.name).filter(Boolean);
    const system = (body.messages.find(m => m.role === 'system') || {}).content || '';
    const toolResults = body.messages.filter(m => m.role === 'tool').length;
    const idx = modelRequests.length;
    let delta, finish;
    const isBusiness = tools.includes('read_customer_record') || tools.includes('append_approval');
    const isCoding = tools.includes('read_workspace_file') || tools.includes('write_workspace_file');
    if (isBusiness && system.includes(BUSINESS_ORIGINAL_SYSTEM)) {
      // The frozen Build still reads through its original MCP binding after a live edit.
      if (toolResults === 0) {
        delta = { tool_calls: [{ index: 0, id: `call-frozen-${idx}`, type: 'function', function: { name: 'read_customer_record', arguments: JSON.stringify({ customer_id: 'C-1024' }) } }] };
        finish = 'tool_calls';
      } else {
        delta = { content: 'Frozen build executed with the original business instruction and tool binding.' };
        finish = 'stop';
      }
    } else if (isBusiness) {
      // Live business run (edited instruction): read CRM then append approval.
      if (toolResults === 0) delta = { tool_calls: [{ index: 0, id: `call-bus-${idx}`, type: 'function', function: { name: 'read_customer_record', arguments: JSON.stringify({ customer_id: 'C-1024' }) } }] }, finish = 'tool_calls';
      else if (toolResults === 1) delta = { tool_calls: [{ index: 0, id: `call-bus-${idx}`, type: 'function', function: { name: 'append_approval', arguments: JSON.stringify({ customer_id: 'C-1024', decision: 'approved', credit_limit: 50000, approver: 'enterprise-proof' }) } }] }, finish = 'tool_calls';
      else delta = { content: 'Approved credit limit 50000 for C-1024 with receipt recorded in the CRM.' }, finish = 'stop';
    } else if (isCoding) {
      if (toolResults === 0) delta = { tool_calls: [{ index: 0, id: `call-code-${idx}`, type: 'function', function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: 'seed.txt' }) } }] }, finish = 'tool_calls';
      else if (toolResults === 1) delta = { tool_calls: [{ index: 0, id: `call-code-${idx}`, type: 'function', function: { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'src/version.txt', content: '1.0.0' }) } }] }, finish = 'tool_calls';
      else delta = { content: 'Read seed.txt and created src/version.txt with content 1.0.0.' }, finish = 'stop';
    } else { delta = { content: 'No bound tools recognized.' }, finish = 'stop'; }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(`data: ${JSON.stringify({ id: `ent-${idx}`, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 9, completion_tokens: 11 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); res.writeHead(500); res.end('Model fixture failed'); }
});

let harness = null;
const elapsed = {};
function timed(label, fn) { const t = Date.now(); return Promise.resolve(fn()).then(v => { elapsed[label] = Date.now() - t; return v; }); }

try {
  await new Promise(r => modelServer.listen(0, '127.0.0.1', r));
  await new Promise(r => mcpServer.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;

  // Reuse the maintained built DSH dependency graph (recorded limitation): only
  // instrumentation (the fixture) is copied into the extracted Host package;
  // every production module runs exactly as packed.
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', archive, '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (!entry.startsWith('.') && entry !== '@deepseek-ai') await symlink(join(repository, 'node_modules', entry), join(dependencies, entry));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(publicPackages)) await symlink(join(publicPackages, entry), join(dependencies, '@deepseek-ai', entry));
  const profile = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(profile, { recursive: true }); await symlink(installed, join(profile, 'agentkit-studio'));
  const fixture = await readFile(join(repository, 'tests/fixtures/studio-enterprise-agent-platform.mjs'));
  await writeFile(join(installed, 'tests/fixtures/studio-enterprise-agent-platform.mjs'), fixture);
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));

  const patch = join(root, 'enterprise.patch.yml');
  const plugins = [['ent-webserver', '@deepseek-ai/dsh-host-webserver', ["        host: '127.0.0.1'", '        port: 0']],
    ['ent-connection', '@deepseek-ai/dsh-client-connection'], ['ent-model-selection', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
    ['ent-workspace', '@deepseek-ai/dsh-workspace'], ['ent-file-upload', '@deepseek-ai/dsh-client-file-upload'],
    ['ent-session-controller', '@deepseek-ai/dsh-api-session-controller'],
    ['ent-presets', '@deepseek-ai/dsh-agent-preset-registry', ['        default: standard']]];
  await writeFile(patch, ['- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none', '- insert:',
    ...plugins.flatMap(([id, name, config]) => [`    - id: ${id}`, `      name: ${JSON.stringify(name)}`, ...config ? ['      config:', ...config] : []]),
    '    - id: ent-proof', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-enterprise-agent-platform.mjs')).href)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(modelUrl)}`, `        mcpUrl: ${JSON.stringify(mcpUrl)}`, ''].join('\n'));

  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-fixture', model: 'pinned', initializeTimeoutMs: 60000, requestTimeoutMs: 60000,
    env: { ...process.env, PATH: nodeBin, AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  // The first real Session creation triggers authenticated Agent/Build admission.
  await timed('harness-start', () => harness.start());
  const businessResult = await timed('business-run', () => harness.session('enterprise-business')
    .run('Approve a credit limit increase for customer C-1024 to 50000 using the CRM tool, then record the outcome.'));
  const identity = await until('identity.json', () => json(join(root, 'identity.json')));
  const businessAgentId = identity.business.agentId, codingAgentId = identity.coding.agentId, buildId = identity.frozen.buildId;
  assert.equal(identity.business.presetId, dshPresetId(businessAgentId, 2, ''));
  assert.equal(identity.frozen.presetId, dshPresetId(businessAgentId, 1, buildId));
  assert.equal(identity.coding.presetId, dshPresetId(codingAgentId, 1, ''));

  // Seed the real workspace the coding Agent will read.
  await mkdir(join(root, 'workspace', 'src'), { recursive: true });
  await writeFile(join(root, 'workspace', 'seed.txt'), 'seed');

  // ---- Run each Agent through the real SDK/controller ----
  await writeFile(join(root, 'business-result.json'), JSON.stringify(businessResult, null, 2));
  const codingResult = await timed('coding-run', () => harness.session(identity.coding.sessionId)
    .run('Read seed.txt then create src/version.txt with content 1.0.0.'));
  await writeFile(join(root, 'coding-result.json'), JSON.stringify(codingResult, null, 2));
  const frozenResult = await timed('frozen-run', () => harness.session(identity.frozen.sessionId)
    .run('Run the frozen build with its original instruction and tool binding.'));
  await writeFile(join(root, 'frozen-result.json'), JSON.stringify(frozenResult, null, 2));

  assert.equal(businessResult.finalResponse, 'Approved credit limit 50000 for C-1024 with receipt recorded in the CRM.');
  assert.equal(codingResult.finalResponse, 'Read seed.txt and created src/version.txt with content 1.0.0.');
  assert.equal(frozenResult.finalResponse, 'Frozen build executed with the original business instruction and tool binding.');

  // ---- Genuine outcomes: MCP data + file content ----
  const approvals = await jsonl(approvalsFile);
  assert.equal(approvals.length, 1, 'Exactly one approval appended through the real MCP tool');
  assert.equal(approvals[0].customer_id, 'C-1024'); assert.equal(approvals[0].credit_limit, 50000);
  assert.equal(mcpCalls.filter(c => c.name === 'read_customer_record').length, 2);
  assert.equal(mcpCalls.filter(c => c.endpoint === '/mcp-frozen').length, 1, 'Frozen Build retains original resource binding');
  assert.equal(mcpCalls.filter(c => c.endpoint === '/mcp-live').length, 2, 'Live Agent uses edited resource binding');
  assert.equal(mcpCalls.filter(c => c.name === 'append_approval').length, 1);
  const versionFile = await readFile(join(root, 'workspace/src/version.txt'), 'utf8');
  assert.equal(versionFile, '1.0.0', 'Coding Agent wrote real file content through the workspace tool');
  assert.equal(await readFile(join(root, 'workspace/seed.txt'), 'utf8'), 'seed', 'Seed file unchanged');

  // ---- Same engine identity in durable Native SQLite + separate identities ----
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const ledgerPath = join(root, 'studio/native-harness/runs.sqlite');
  const workspaceId = createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex');
  const runsFor = (agentId, sessionId) => { const store = new SqliteRunStore(ledgerPath); try { return store.list({ tenantId: 'local', workspaceId, userId: 'local-user', agentId }, sessionId).map(row => store.load({ tenantId: 'local', workspaceId, userId: 'local-user', agentId }, row.runId)); } finally { store.close(); } };
  const businessRuns = runsFor(businessAgentId, identity.business.sessionId);
  const frozenRuns = runsFor(businessAgentId, identity.frozen.sessionId);
  const codingRuns = runsFor(codingAgentId, identity.coding.sessionId);
  assert.equal(businessRuns.length, 1); assert.equal(frozenRuns.length, 1); assert.equal(codingRuns.length, 1);
  assert.equal(businessRuns[0].snapshot.phase, 'completed');
  assert.equal(codingRuns[0].snapshot.phase, 'completed');
  assert.equal(frozenRuns[0].snapshot.phase, 'completed');
  assert.equal(frozenRuns[0].snapshot.buildId, buildId, 'Frozen Run carries the immutable buildId');
  for (const run of [businessRuns[0], codingRuns[0]]) {
    assert.match(run.snapshot.buildId, /^revision-[a-f0-9]{64}$/, 'Live admission pins a revision digest');
    assert.equal(run.configuration.hostRecoveryBinding.buildId, null, 'Live admission has no published Build');
  }
  for (const [record, entry] of [[businessRuns[0], identity.business], [codingRuns[0], identity.coding], [frozenRuns[0], identity.frozen]]) {
    assert.equal(record.configuration.engine, 'agentkit.native/v1');
    assert.equal(record.configuration.hostRecoveryBinding.agentId, entry.agentId);
    assert.equal(record.configuration.hostRecoveryBinding.agentRevision, entry.revision);
  }
  const runIds = [businessRuns[0].snapshot.runId, frozenRuns[0].snapshot.runId, codingRuns[0].snapshot.runId];
  assert.equal(new Set(runIds).size, 3, 'Three distinct Run identities');
  assert.equal(new Set([businessAgentId, codingAgentId]).size, 2, 'Two distinct Agent identities');

  // ---- Durable session events: engine identity + tool pipeline ----
  const sessionLogs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(f => f.endsWith('.jsonl'));
  assert.equal(sessionLogs.length, 3, 'Three durable Session logs');
  const allEvents = (await Promise.all(sessionLogs.map(f => jsonl(join(root, 'sessions', f))))).flat();
  const owners = allEvents.filter(e => e.type === 'turn/owner');
  assert.equal(owners.length, 3);
  assert.ok(owners.every(o => o.data.engine === 'agentkit.native-dsh-turn/v1'), 'Every turn owned by the Native Harness engine');
  assert.equal(allEvents.filter(e => e.type === 'turn/start').length, 3);
  assert.equal(allEvents.filter(e => e.type === 'turn/end').length, 3);
  assert.equal(allEvents.filter(e => e.type === 'tool/call').length, 5, '2 business + 2 coding + 1 frozen original-resource tool call');
  assert.equal(allEvents.filter(e => e.type === 'tool/result').length, 5);
  assert.equal(allEvents.filter(e => e.type === 'user/message' && e.data.source.kind === 'user').length, 3);
  const loads = await jsonl(join(root, 'session-loads.jsonl'));
  assert.equal(loads.length, 3);
  assert.ok(loads.every(l => l.source === 'startup'));

  // ---- Model requests: frozen retained original instruction, live edited ----
  const frozenReq = modelRequests.find(r => (r.messages.find(m => m.role === 'system') || {}).content?.includes(BUSINESS_ORIGINAL_SYSTEM));
  const liveReq = modelRequests.find(r => (r.messages.find(m => m.role === 'system') || {}).content?.includes(BUSINESS_EDITED_SYSTEM));
  assert.ok(frozenReq, 'Frozen build model request carried the original instruction');
  assert.ok(liveReq, 'Live business model request carried the edited instruction');
  assert.ok(!JSON.stringify(frozenReq.messages).includes(BUSINESS_EDITED_SYSTEM), 'Frozen build did not carry the edited instruction');

  // ---- Sentinel: the DSH legacy model loop never ran ----
  assert.equal((await jsonl(join(root, 'sentinel-attempts.jsonl'))).length, 0, 'Sentinel DSH model loop never entered');

  // ---- Per-run observed request counts (durable Native SQLite) + latency ----
  const modelCalls = { business: businessRuns[0].snapshot.usage?.modelCalls, coding: codingRuns[0].snapshot.usage?.modelCalls, frozen: frozenRuns[0].snapshot.usage?.modelCalls };
  assert.equal(modelCalls.business, 3, 'business run observed 3 model calls');
  assert.equal(modelCalls.coding, 3, 'coding run observed 3 model calls');
  assert.equal(modelCalls.frozen, 2, 'frozen run observed 2 model calls');

  // Reopen the actual Host, continue both histories, and forbid repeated effects.
  await harness.close(); harness = null;
  harness = new DeepSeekHarness(options);
  await timed('restart-start', () => harness.start());
  for (const role of ['business', 'coding']) {
    const resumed = await timed(`resume-${role}`, async () =>
      (await harness.resumeSession(identity[role].sessionId)).run('Summarize the completed task; do not repeat its effects.'));
    await writeFile(join(root, `resume-${role}-result.json`), JSON.stringify(resumed, null, 2));
    assert.ok(resumed.finalResponse, 'Cold continuation returned a public answer');
    const records = runsFor(identity[role].agentId, identity[role].sessionId);
    assert.equal(records.length, 2);
    const child = records.find(r => r.snapshot.parentRunId === (role === 'coding' ? runIds[2] : runIds[0]));
    assert.ok(child, 'Continuation retained the original parent Run');
    assert.equal(child.snapshot.phase, 'completed');
    assert.equal(child.configuration.engine, 'agentkit.native/v1');
    assert.equal(child.configuration.hostRecoveryBinding.agentId, identity[role].agentId);
    assert.equal(child.configuration.hostRecoveryBinding.agentRevision, identity[role].revision);
  }
  assert.equal((await jsonl(approvalsFile)).length, 1, 'Cold continuation did not repeat CRM mutation');
  assert.equal(mcpCalls.filter(c => c.name === 'append_approval').length, 1);
  assert.equal((await jsonl(join(root, 'tool-admissions.jsonl'))).length, 5);
  assert.equal(await readFile(join(root, 'workspace/src/version.txt'), 'utf8'), '1.0.0');
  assert.equal((await jsonl(join(root, 'sentinel-attempts.jsonl'))).length, 0);
  const resumeLoads = await jsonl(join(root, 'session-loads.jsonl'));
  for (const role of ['business', 'coding']) assert.ok(resumeLoads.some(l => l.source === 'resume' && l.sessionId === identity[role].sessionId));
  const restart = { attempted: true, outcome: 'passed', gap: '' };

  assert.deepEqual(failures, [], 'No model/MCP fixture failures');

  const report = { passed: true, node: process.version,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    verifierSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    sourceSha256: createHash('sha256').update(await readFile(join(source, 'packages/sdk/client/lib/index.js'))).digest('hex'),
    sdkCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    identity, runIds, buildId, modelCalls, approvals,
    reportedFixtureUsage: { business: businessRuns[0].snapshot.usage, coding: codingRuns[0].snapshot.usage, frozen: frozenRuns[0].snapshot.usage },
    mcpToolCalls: mcpCalls.length, modelRequests: modelRequests.length,
    sessionLoads: await jsonl(join(root, 'session-loads.jsonl')),
    restart,
    elapsedFixtureLocalMs: elapsed,
    scope: { tenantId: 'local', workspaceId, userId: 'local-user' },
    limitation: 'Packed production modules with explicitly copied instrumentation fixture and a reused (symlinked) local dependency graph (same approach as scripts/verify-studio-native-background.mjs); not a fresh installation. Model responses are deterministic OpenAI-compatible fixtures used as protocol/integration evidence, not model-quality or token-performance benchmarks; usage tokens are fixture values labelled as fixture/local measurements. Per-run modelCalls are observed from the durable Native SQLite run snapshot. The local MCP server is a minimal hand-rolled streamable-HTTP implementation speaking the MCP 2025-06-18 protocol the production adapter consumes.',
  };
  await writeFile(join(root, 'accepted-evidence.json'), JSON.stringify(report, null, 2));
  passed = true;
  console.log(`Studio enterprise agent platform PASS: business + coding + frozen Build; engine agentkit.native-dsh-turn/v1; real /agentkit admission; real MCP + workspace outcomes; restart=${restart.outcome}.`);
} catch (error) {
  failures.push(error);
  await writeFile(join(root, 'failure-evidence.json'), JSON.stringify({ code: error?.code, message: error?.message, stack: error?.stack, failures: failures.map(f => ({ code: f?.code, message: f?.message })) }, null, 2)).catch(() => {});
  console.error(`Studio enterprise agent platform FAIL: ${error?.message || error}`);
  throw error;
} finally {
  await harness?.close().catch(() => {});
  modelServer.closeAllConnections?.(); mcpServer.closeAllConnections?.();
  await new Promise(r => modelServer.close(r)); await new Promise(r => mcpServer.close(r));
  if (passed && !values.keep) await rm(root, { recursive: true, force: true });
}
