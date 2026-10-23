/** Real packed Host: no-input background wake, cold discovery, and SIGKILL. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' },
  boundary: { type: 'string', default: 'warm' }, frozen: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } } });
assert.ok(values.source && values.archive, 'Use --source <maintained built DSH> --archive <Studio.tgz>');
assert.ok(['warm', 'cold', 'prepare', 'owner'].includes(values.boundary));
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source), archive = resolve(values.archive);
// Intentionally use the platform's normal tmpdir spelling, including macOS
// /var -> /private/var. Host state must work under a trusted aliased home.
const root = await mkdtemp(join(tmpdir(), 'studio-native-background-'));
console.log(`Studio Native background evidence: ${root}`);
const requests = [], failures = [], lifetimes = [];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
// The observational launch counter lives in the fixture's scratch home. It
// must not itself mutate the workspace while Native verifies a final answer.
const commandCode = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, 'effect-count.txt'))},'x');` +
  `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'release-command'))})){clearInterval(t);console.log('owned-command-completed')}},30);`;
const command = `${quote(process.execPath)} -e ${quote(commandCode)}`;
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(requests, null, 2));
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['run_command']);
    if (values.frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_BACKGROUND_SYSTEM')));
      assert.equal(JSON.stringify(body.messages).includes('LIVE_BACKGROUND_SYSTEM_CHANGED'), false);
    }
    assert.ok(requests.length <= 3, 'Exactly source model/tool/final plus one no-input completion model');
    const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'launch-owned-background', type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ command, background: true, background_timeout: 120 }) } }] }
      : { content: requests.length === 2 ? 'Background command started.' : 'Background command completed.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `background-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.writeHead(500); response.end('Background proof failed'); }
});
let harness, passed = false;
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function until(label, read, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw Error(`Timed out waiting for ${label}; modelCalls=${requests.length}`);
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function jsonl(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function durableSessionEvents() {
  const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
  assert.equal(logs.length, 1); return jsonl(join(root, 'sessions', logs[0]));
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
  // Only instrumentation is copied when reviewing an existing archive; every
  // production module runs exactly as packed. Record both hashes explicitly.
  const fixture = await readFile(join(repository, 'tests/fixtures/studio-native-background.mjs'));
  await writeFile(join(installed, 'tests/fixtures/studio-native-background.mjs'), fixture);
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  const patch = join(root, 'background.patch.yml');
  const plugins = [['bg-webserver', '@deepseek-ai/dsh-host-webserver', ["        host: '127.0.0.1'", '        port: 0']],
    ['bg-connection', '@deepseek-ai/dsh-client-connection'], ['bg-model-selection', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
    ['bg-workspace', '@deepseek-ai/dsh-workspace'], ['bg-file-upload', '@deepseek-ai/dsh-client-file-upload'],
    ['bg-session-controller', '@deepseek-ai/dsh-api-session-controller'],
    ['bg-presets', '@deepseek-ai/dsh-agent-preset-registry', ['        default: standard']]];
  await writeFile(patch, ['- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none', '- insert:',
    ...plugins.flatMap(([id, name, config]) => [`    - id: ${id}`, `      name: ${JSON.stringify(name)}`, ...config ? ['      config:', ...config] : []]),
    '    - id: bg-proof', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-background.mjs')).href)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`, `        boundary: ${values.boundary}`,
    `        frozen: ${values.frozen}`,
    `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`, ''].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-fixture', model: 'pinned', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  const result = await harness.session('native-background-session').run('Start the owned background command and report when it completes.');
  await writeFile(join(root, 'source-result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.finalResponse, 'Background command started.');
  assert.equal(requests.length, 2); assert.equal(result.events.filter(event => event.type === 'tool/call').length, 1);
  await until('actual background command start', async () => {
    try { return await readFile(join(root, 'effect-count.txt'), 'utf8') === 'x'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  const identity = await json(join(root, 'identity.json'));
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'),
    userId: 'local-user', agentId: identity.agentId };
  const ledgerPath = join(root, 'studio/native-harness/runs.sqlite');
  const records = () => { const store = new SqliteRunStore(ledgerPath); try { return store.list(scope, identity.sessionId).map(row => store.load(scope, row.runId)); } finally { store.close(); } };
  const original = records(); assert.equal(original.length, 1);
  assert.equal(original[0].snapshot.phase, 'completed'); assert.equal(original[0].snapshot.backgroundCommands.length, 1);
  const originalRef = original[0].snapshot.backgroundCommands[0].ref;
  const sourceModelCount = requests.length;
  await until('durable SDK source turn/end', async () => (await durableSessionEvents())
    .some(event => event.type === 'turn/end' && event.data.turn === 1));
  if (values.boundary === 'cold') {
    const host = await json(join(root, 'host-ready.json'));
    process.kill(host.pid, 'SIGKILL'); await harness.close(); harness = null;
    lifetimes.push({ pid: host.pid, signal: 'SIGKILL', boundary: 'source-completed-command-running' });
  }
  await writeFile(join(root, 'release-command'), 'release');
  if (values.boundary === 'cold') { harness = new DeepSeekHarness(options); await harness.start(); }
  let checkpoint;
  if (['prepare', 'owner'].includes(values.boundary)) {
    checkpoint = await until(`durable background ${values.boundary}`, () => json(join(root, `${values.boundary}-checkpoint.json`)));
    process.kill(checkpoint.pid, 'SIGKILL'); await harness.close(); harness = null;
    assert.equal(requests.length, sourceModelCount, 'Admission/owner must precede any completion model call');
    const admitted = records(); assert.equal(admitted.length, 2);
    const pending = admitted.find(row => row.snapshot.backgroundNotification);
    assert.equal(pending.snapshot.runId, checkpoint.binding?.identity.runId ?? checkpoint.runId);
    checkpoint.configDigest ??= pending.snapshot.configDigest;
    const durableLogs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
    const durableEvents = await jsonl(join(root, 'sessions', durableLogs[0]));
    checkpoint.durableStarts = durableEvents.filter(event => event.type === 'turn/start').length;
    assert.equal(durableEvents.filter(event => event.type === 'turn/owner').length, values.boundary === 'owner' ? 2 : 1);
    lifetimes.push({ pid: checkpoint.pid, signal: 'SIGKILL', boundary: `background-${values.boundary}-committed-before-model`,
      runId: pending.snapshot.runId, configDigest: pending.snapshot.configDigest, durableStarts: checkpoint.durableStarts });
    harness = new DeepSeekHarness(options); await harness.start();
  }
  const settled = await until('automatic background notice completion without another prompt', () => {
    const rows = records(); return rows.length === 2 && rows.find(row => row.snapshot.backgroundNotification)?.snapshot.phase === 'completed' ? rows : undefined;
  });
  const expectedTurns = values.boundary === 'prepare' ? checkpoint.durableStarts + 1 : 2;
  // Native's ledger commit precedes SDK turn closure. Do not tear down the
  // Host in that interval and mistake a partial Session projection for idle.
  await until('durable SDK background turn/end', async () => (await durableSessionEvents())
    .filter(event => event.type === 'turn/end').length === expectedTurns);
  await harness.close(); harness = null;
  const sourceRecord = settled.find(row => !row.snapshot.backgroundNotification), notice = settled.find(row => row.snapshot.backgroundNotification);
  assert.equal(sourceRecord.snapshot.runId, original[0].snapshot.runId);
  if (values.frozen) { assert.ok(identity.buildId); assert.equal(sourceRecord.snapshot.buildId, identity.buildId); }
  assert.equal(sourceRecord.snapshot.phase, 'completed'); assert.equal(sourceRecord.snapshot.configDigest, original[0].snapshot.configDigest);
  assert.deepEqual(sourceRecord.intents, original[0].intents); assert.deepEqual(sourceRecord.receipts, original[0].receipts);
  assert.equal(notice.snapshot.backgroundNotification.sourceRunId, sourceRecord.snapshot.runId);
  assert.equal(notice.snapshot.backgroundNotification.taskId, originalRef.taskId);
  assert.equal(notice.snapshot.buildId, sourceRecord.snapshot.buildId); assert.equal(notice.snapshot.taskChainId, sourceRecord.snapshot.taskChainId);
  assert.equal(notice.configuration.hostBindingDigest, sourceRecord.configuration.hostBindingDigest);
  assert.equal(notice.snapshot.usage.modelCalls, 1); assert.equal(notice.snapshot.usage.toolCalls, 0);
  assert.equal(requests.length, 3); assert.deepEqual(failures, []);
  assert.equal(await readFile(join(root, 'effect-count.txt'), 'utf8'), 'x');
  assert.equal((await jsonl(join(root, 'tool-admissions.jsonl'))).length, 1);
  const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
  assert.equal(logs.length, 1);
  const events = await jsonl(join(root, 'sessions', logs[0]));
  const owners = events.filter(event => event.type === 'turn/owner');
  assert.equal(owners.length, 2); assert.equal(owners[1].data.engine, 'agentkit.native-dsh-background-turn/v1');
  assert.equal(events.filter(event => event.type === 'turn/start').length, expectedTurns);
  assert.equal(events.filter(event => event.type === 'turn/end').length, expectedTurns);
  assert.equal(events.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(events.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 1);
  const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'agentkit-native-background-notification');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.source.sourceRunId, sourceRecord.snapshot.runId); assert.equal(notices[0].data.source.taskId, originalRef.taskId);
  const observation = JSON.parse(notices[0].data.content[0].text);
  assert.equal(observation.commands.length, 1); assert.deepEqual(observation.commands[0].ref, originalRef);
  assert.equal(observation.commands[0].status, 'completed'); assert.equal(observation.commands[0].exitCode, 0);
  assert.equal(observation.commands[0].stdout, 'owned-command-completed\n');
  assert.ok(JSON.stringify(requests[2].messages).includes('owned-command-completed'), 'The real completion observation reaches the actual model codec');
  if (checkpoint) {
    assert.equal(notice.snapshot.configDigest, checkpoint.configDigest, 'Recovery never resets the admitted Native configuration');
    if (checkpoint.owner) assert.deepEqual(owners[1], checkpoint.owner, 'Recovery preserves original numeric turn and exact flushed ownership');
  }
  const report = { passed: true, node: process.version, boundary: values.boundary, frozen: values.frozen,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    sdkCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope, sourceRunId: sourceRecord.snapshot.runId, noticeRunId: notice.snapshot.runId, ref: originalRef, lifetimes,
    modelCalls: requests.length, commandEffects: 1, sessionLoads: await jsonl(join(root, 'session-loads.jsonl')),
    limitation: 'Packed production modules with explicitly copied instrumentation fixture and fixed local dependency graph; not fresh installation.' };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); passed = true;
  console.log(`Studio Native background PASS: ${values.boundary}; actual packed Host, SDK idle turn, real command and SQLite/JSONL, one launch, one typed completion, no new prompt.`);
} finally {
  // Release a surviving owned command even when an assertion fails.
  await writeFile(join(root, 'release-command'), 'cleanup').catch(() => {});
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (passed && !values.keep) await rm(root, { recursive: true, force: true });
}
