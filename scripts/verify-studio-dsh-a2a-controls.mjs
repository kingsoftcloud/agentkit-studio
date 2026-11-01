/** Packed production Host, original DSH/Codex registry calls + authenticated
 * human controls and real ApprovalService. No model/CLI/Electron claim. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' }, 'crash-approval': { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz> [--keep]');
const source = resolve(values.source), archive = resolve(values.archive), repository = fileURLToPath(new URL('..', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-dsh-a2a-'))), sha = value => createHash('sha256').update(value).digest('hex');
console.log(`DSH A2A proof root: ${root}`);
const counts = { discovery: 0, send: 0, get: 0, continue: 0, cancel: 0, approval: 0 }, tasks = new Map(), streams = new Map(), requests = [], failures = [];
let harness;
const server = createServer((req, res) => void (async () => {
  let raw = ''; for await (const bytes of req) raw += bytes; const body = JSON.parse(raw); requests.push({ path: req.url, raw });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/approval') {
    assert.ok(['a2a_continue_task', 'a2a_cancel_task'].includes(body.toolName));
    assert.match(body.callId, /^dsh-a2a-control:/); const reason = JSON.parse(body.reason);
    assert.ok(reason.remoteTaskId); assert.ok(reason.commandId); counts.approval++;
    if (reason.action === 'continue') assert.match(body.reason, /9007199254740993/);
    if (values['crash-approval'] && counts.approval === 1) {
      assert.ok(Number.isSafeInteger(body.pid));
      await writeFile(join(root, 'approval-waiting.json'), JSON.stringify({ pid: body.pid, request: body })); return;
    }
    res.end(JSON.stringify({ outcome: 'allowed-once' })); return;
  }
  if (req.url === '/finish') {
    const stream = streams.get(body.taskId); assert.ok(stream); const task = tasks.get(body.taskId); assert.equal(task.status.state, 'TASK_STATE_CANCELED');
    stream.res.end('id: 2\ndata: ' + JSON.stringify(stream.wrap({ statusUpdate: { taskId: task.id, contextId: task.contextId,
      status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n'); streams.delete(body.taskId); res.end('{}'); return;
  }
  if (req.url === '/agentengine/api/v1/ListAToASpaceAgents') {
    counts.discovery++; res.end(JSON.stringify({ Code: 0, Data: { Agents: [{ A2AAgentId: 'remote', VersionId: 'version', AgentCard: {
      capabilities: { streaming: true }, supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    } }] } })); return;
  }
  assert.equal(req.url, '/rpc'); const wrap = result => ({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'SendStreamingMessage') {
    counts.send++; const busy = body.params.message.parts[0].text === 'busy';
    const task = { id: `task-${counts.send}`, contextId: `context-${counts.send}`, status: { state: busy ? 'TASK_STATE_WORKING' : 'TASK_STATE_INPUT_REQUIRED' } };
    tasks.set(task.id, task); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 1\ndata: ' + JSON.stringify(wrap({ task })) + '\n\n');
    if (busy) streams.set(task.id, { res, wrap }); else res.end(); return;
  }
  const task = tasks.get(body.params.id ?? body.params.message?.taskId); assert.ok(task);
  if (body.method === 'GetTask') { counts.get++; res.end(JSON.stringify(wrap(task))); return; }
  if (body.method === 'CancelTask') { counts.cancel++; task.status = { state: 'TASK_STATE_CANCELED' }; }
  else { assert.equal(body.method, 'SendMessage'); counts.continue++; assert.equal(body.params.message.contextId, task.contextId);
    assert.match(raw, /9007199254740993/); task.status = { state: 'TASK_STATE_COMPLETED' }; }
  res.end(JSON.stringify(wrap(body.method === 'SendMessage' ? { task } : task)));
})().catch(error => { failures.push(error.message); res.statusCode = 500; res.end('{}'); }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
async function untilFile(name) { const deadline = Date.now() + 45000; for (;;) {
  try { return JSON.parse(await readFile(join(root, name), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(Date.now() < deadline, `${name} timed out`); await new Promise(resolve => setTimeout(resolve, 25));
} }
try {
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules'); await mkdir(graph);
  execFileSync('tar', ['-xzf', archive, '-C', graph]); await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) if (!name.startsWith('.') && name !== '@deepseek-ai')
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  const sdkPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(sdkPackages)) await symlink(join(sdkPackages, name), join(dependencies, '@deepseek-ai', name));
  const pluginRoot = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud'); await mkdir(pluginRoot, { recursive: true });
  await symlink(installed, join(pluginRoot, 'agentkit-studio'));
  const bin = join(root, 'node-only-bin'); await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
  const patch = join(root, 'controls.patch.yml');
  const plugins = ['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
    '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-client-file-upload', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-agent-preset-registry'];
  await writeFile(patch, ['- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none', '- insert:',
    ...plugins.flatMap((name, i) => [`    - id: controls-${i}`, `      name: ${JSON.stringify(name)}`,
      ...(i === 0 ? ['      config:', "        host: '127.0.0.1'", '        port: 0'] : i === 6 ? ['      config:', '        default: standard'] : [])]),
    '    - id: controls-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-dsh-a2a-controls.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        peer: ${JSON.stringify(origin)}`,
    `        crashApproval: ${Boolean(values['crash-approval'])}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch],
    dshHome: join(root, 'home'), cwd: root, processCwd: root, provider: 'agentkit-studio-dsh-a2a-proof', model: 'unused', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: bin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options); await harness.start(); await writeFile(join(root, 'start-proof'), 'Start after actual mounted Host ready.');
  let interruptedApproval;
  if (values['crash-approval']) {
    interruptedApproval = await untilFile('approval-waiting.json');
    assert.equal(counts.continue, 0); assert.equal(counts.cancel, 0);
    process.kill(interruptedApproval.pid, 'SIGKILL');
    await rm(join(root, 'start-proof')); await harness.close().catch(() => {});
    const deadline = Date.now() + 15000;
    for (;;) {
      try { process.kill(interruptedApproval.pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25));
    }
    harness = new DeepSeekHarness(options); await harness.start();
    await writeFile(join(root, 'start-proof'), 'Explicit same-command recovery after killed approval Host.');
  }
  const proof = await untilFile('proof.json'); assert.equal(proof.passed, true, JSON.stringify(proof));
  assert.deepEqual(proof.runtimes.map(row => row.runtime), values['crash-approval'] ? ['dsh-native'] : ['dsh-native', 'codex']);
  assert.equal(proof.node, process.version); assert.equal(proof.path, bin);
  if (interruptedApproval) { assert.notEqual(proof.pid, interruptedApproval.pid); assert.equal(proof.runtimes[0].recoveredTurn, 2); }
  // One explicit inspection and one pre-continuation observation. The
  // continuation itself returns the terminal Task; there is no third Get.
  assert.deepEqual(counts, values['crash-approval'] ? { discovery: 1, send: 1, get: 2, continue: 1, cancel: 0, approval: 2 }
    : { discovery: 4, send: 4, get: 10, continue: 2, cancel: 2, approval: 4 });
  const beforeCold = structuredClone(counts); await rm(join(root, 'start-proof')); await harness.close();
  const exitedBy = Date.now() + 15000; for (;;) {
    try { process.kill(proof.pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
    assert.ok(Date.now() < exitedBy); await new Promise(resolve => setTimeout(resolve, 25));
  }
  harness = new DeepSeekHarness(options); await harness.start(); await writeFile(join(root, 'start-proof'), 'Cold confirmation after original PID exit.');
  const cold = await untilFile('cold-proof.json'); assert.equal(cold.passed, true, JSON.stringify(cold)); assert.notEqual(cold.pid, proof.pid);
  assert.equal(cold.previousPid, proof.pid); assert.equal(cold.unchanged, true); assert.deepEqual(counts, beforeCold); assert.deepEqual(failures, []);
  const evidence = { node: process.version, archive: { path: archive, sha256: sha(await readFile(archive)) },
    maintainedSource: { source, commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    fixtureSha256: sha(await readFile(join(installed, 'tests/fixtures/studio-dsh-a2a-controls.mjs'))), verifierSha256: sha(await readFile(new URL(import.meta.url))),
    counts, proof, cold, requests, ...(interruptedApproval ? { interruptedApproval, signal: 'SIGKILL' } : {}),
    limitation: 'Actual packed mounted Host/registry/SessionController/ApprovalService/authenticated HTTP and UI state; deterministic HTTP peer/human answerer, linked existing dependencies, no model/CLI/browser/Electron/online/fresh-install claim.' };
  await writeFile(join(root, 'reviewed-proof.json'), JSON.stringify(evidence, null, 2));
  console.log(values['crash-approval']
    ? 'PASS: approval SIGKILL, new Host PID resumes SAME owned turn, fresh consent, one original Send/continuation, cold audit/duplicate confirmation, zero model calls.'
    : 'PASS: DSH Native and Codex original-call input/cancel, actual approval/authenticated routes, busy registry call, cold duplicate confirmation, zero repeated effects/model calls.');
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack, counts, failures, requests }, null, 2)); throw error;
} finally {
  await harness?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
