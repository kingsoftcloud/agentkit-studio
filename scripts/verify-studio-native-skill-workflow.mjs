import { createRequire } from 'node:module';
/** Actual packed Studio Host + maintained SDK + HTTP model/Skill directory +
 * CA-verified HTTPS ZIP + supervised script + SQLite/JSONL + new Host history.
 * Uses a fixed installed dependency graph; this is not fresh-install, E2B,
 * Frozen deployment or SIGKILL acceptance. Production archive is never patched. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createZip } from '../src/zip.mjs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean', default: false } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <packed Studio> [--keep]');
const source = resolve(values.source), archive = resolve(values.archive), repository = fileURLToPath(new URL('..', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-native-skill-workflow-')));
console.log(`Skill workflow proof root: ${root}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = digest(await readFile(archive));
const skillText = '---\nname: proof-skill\ndescription: Produce exact workflow artifacts.\n---\n# Proof Skill\nRun the bound workflow script.\n';
const outputText = 'Native Skill output: 中文\n';
const script = 'printf "effect\\n" >> "$KSADK_SKILL_WORKDIR/effects.txt"\n'
  + 'printf "Native Skill output: 中文\\n" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\n'
  + 'printf "\\000\\377\\001" > "$KSADK_SKILL_OUTPUT_DIR/result.bin"\n'
  + 'printf "artifact=artifacts/result.txt\\nartifact=artifacts/result.bin\\n"\n';
const skillZip = createZip([{ name: 'SKILL.md', data: skillText }, { name: 'scripts/run-workflow.sh', data: script }]);
const skillHash = digest(skillZip), finalAnswer = 'Native Skill workflow delivered exact bytes.';
const sessionId = 'skill-workflow-session', requests = [], serviceRequests = [], failures = [];
let downloads = 0, downloadPort, harness, SqliteRunStore, installed, scope;
const jsonl = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function currentRecord() {
  const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  scope = { tenantId: 'local', workspaceId: digest(JSON.stringify(resolve(root, 'workspace'))), userId: 'local-user', agentId };
  const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try { const runs = store.list(scope, sessionId); assert.equal(runs.length, 1); return store.load(scope, runs[0].runId); }
  finally { store.close(); }
}
async function assertLiveIntent() {
  const record = await currentRecord(); assert.equal(record.snapshot.phase, 'executing_tools');
  const intent = record.intents.find(item => item.operationKey === record.snapshot.pendingIntent);
  assert.equal(intent.status, 'running'); assert.equal(intent.claimedFence, record.lease.fence);
}
function failure(error, response) {
  failures.push(error.stack ?? error.message); console.error(error.stack ?? error.message);
  if (!response.headersSent) response.writeHead(500); response.end('proof assertion failed');
}
const service = createServer(async (request, response) => {
  try {
    await assertLiveIntent();
    assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, 'Bearer skill-workflow-service-secret');
    const url = new URL(request.url, 'http://127.0.0.1'), action = url.pathname.split('/').at(-1);
    assert.ok(url.pathname.startsWith('/api/v1/')); serviceRequests.push({ action, params: [...url.searchParams] });
    let data;
    if (action === 'ListSkillsBySpaceId') {
      assert.equal(url.searchParams.get('SpaceId'), 'workflow-space');
      data = { SkillSpaceId: 'workflow-space', TotalCount: 1, Skills: [{ SkillId: 'workflow-skill', VersionId: 'workflow-v1',
        Name: 'proof-skill', Description: 'Produce exact workflow artifacts.', Status: 'active', ContentHash: 'sha256:' + skillHash }] };
    } else {
      assert.equal(action, 'GetSkillDownloadUrl'); assert.equal(url.searchParams.get('SkillId'), 'workflow-skill');
      assert.equal(url.searchParams.get('VersionId'), 'workflow-v1');
      data = { DownloadUrl: `https://127.0.0.1:${downloadPort}/skill.zip?download-private=secret` };
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ Data: data }));
  } catch (error) { failure(error, response); }
});
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body); assert.equal(body.model, 'pinned'); assert.ok(requests.length <= 2);
    let delta, reason;
    if (requests.length === 1) {
      assert.ok(body.tools.some(tool => tool.function.name === 'execute_skills'));
      delta = { tool_calls: [{ index: 0, id: 'workflow-call', type: 'function', function: { name: 'execute_skills',
        arguments: JSON.stringify({ workflow_prompt: 'Use proof-skill to generate exact artifacts.', skill_names: ['proof-skill'] }) } }] };
      reason = 'tool_calls';
    } else {
      assert.ok(body.messages.some(message => message.role === 'tool' && String(message.content).includes('Native Skill output')));
      delta = { content: finalAnswer }; reason = 'stop';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `workflow-model-${requests.length}`, model: 'pinned',
      choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failure(error, response); }
});
let download;
try {
  const certs = join(root, 'certs'); await mkdir(certs);
  const key = join(certs, 'key.pem'), cert = join(certs, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'pipe' });
  download = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    try {
      await assertLiveIntent(); assert.equal(request.url, '/skill.zip?download-private=secret');
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['x-ksc-account-id'], undefined);
      downloads++; response.writeHead(200, { 'content-type': 'application/zip', 'content-length': skillZip.length }); response.end(skillZip);
    } catch (error) { failure(error, response); }
  });
  for (const server of [service, download, model]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  downloadPort = download.address().port;
  const graph = join(root, 'host'), dependencies = join(graph, 'node_modules'); installed = join(graph, 'package');
  await mkdir(graph); execFileSync('tar', ['-xzf', archive, '-C', graph]);
  const productionPaths = ['src/providers/native-skill-runtime.mjs', 'src/providers/native-skill-workflow.mjs',
    'src/providers/native-skill-host.mjs', 'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/skill-tools.mjs'];
  const productionHashes = {};
  for (const path of productionPaths) {
    const bytes = await readFile(join(installed, path));
    assert.deepEqual(bytes, await readFile(join(repository, path)), `archive production matches reviewed checkout: ${path}`);
    productionHashes[path] = digest(bytes);
  }
  const fixture = 'tests/fixtures/studio-native-skill-workflow.mjs';
  await mkdir(join(installed, 'tests/fixtures'), { recursive: true }); await copyFile(join(repository, fixture), join(installed, fixture));
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(source, 'apps/cli/node_modules/@deepseek-ai')))
    await symlink(join(source, 'apps/cli/node_modules/@deepseek-ai', entry), join(dependencies, '@deepseek-ai', entry));
  for (const [path, name] of [['packages/client/connection', 'dsh-client-connection'], ['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry']]) {
    try { await symlink(join(source, path), join(dependencies, '@deepseek-ai', name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry !== '@deepseek-ai' && !entry.startsWith('.')) await symlink(join(repository, 'node_modules', entry), join(dependencies, entry));
  }
  const profile = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud'); await mkdir(profile, { recursive: true });
  await symlink(installed, join(profile, 'agentkit-studio'));
  const bin = join(root, 'runtime-bin'); await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node')); await symlink('/bin/bash', join(bin, 'bash'));
  const patch = join(root, 'workflow.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:', '    - id: workflow-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: workflow-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: workflow-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: workflow-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: workflow-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, fixture)).href)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${model.address().port}/v1`)}`,
    `        skillServiceUrl: ${JSON.stringify(`http://127.0.0.1:${service.address().port}/api/v1`)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  ({ SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href));
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'), cwd: root, processCwd: root,
    provider: 'agentkit-studio-fixture', model: 'pinned', initializeTimeoutMs: 30000, requestTimeoutMs: 60000,
    env: { ...process.env, PATH: bin, NODE_EXTRA_CA_CERTS: cert, AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk', DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  const result = await harness.session(sessionId).run('Use the proof Skill to generate exact artifacts.');
  const originalPid = harness.client?.child?.pid; assert.ok(Number.isSafeInteger(originalPid));
  assert.equal(result.finalResponse, finalAnswer); assert.equal(requests.length, 2);
  assert.deepEqual(serviceRequests.map(item => item.action), ['ListSkillsBySpaceId', 'GetSkillDownloadUrl']); assert.equal(downloads, 1); assert.deepEqual(failures, []);
  const record = await currentRecord(); assert.equal(record.snapshot.phase, 'completed');
  assert.equal(record.snapshot.usage.modelCalls, 2); assert.equal(record.snapshot.usage.toolCalls, 1);
  const receipts = record.receipts.filter(item => item.result?.results); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'committed');
  assert.equal(receipts[0].result.results.length, 1); const tool = receipts[0].result.results[0]; assert.equal(tool.status, 'ok');
  const executed = tool.content; assert.equal(executed.ok, true); assert.equal(executed.executed, true); assert.equal(executed.workflow_status, 'ok');
  assert.equal(executed.executed_skill, 'proof-skill'); assert.equal(executed.output_text, outputText); assert.equal(executed.commands.length, 1);
  assert.equal(executed.commands[0].exit_code, 0); assert.equal(executed.command_ids.length, 1);
  const delivered = {};
  for (const meta of executed.artifact_metadata) {
    const bytes = await readFile(meta.path); assert.equal(digest(bytes), meta.sha256); assert.equal(bytes.length, meta.size_bytes);
    assert.ok(meta.path.startsWith(join(root, 'workspace/.agentkit/skill-results/') )); delivered[meta.source_path] = { path: meta.path, sha256: meta.sha256, bytes: [...bytes] };
  }
  assert.deepEqual(Object.keys(delivered).sort(), ['artifacts/result.bin', 'artifacts/result.txt']);
  assert.deepEqual(delivered['artifacts/result.bin'].bytes, [0, 255, 1]);
  assert.deepEqual(delivered['artifacts/result.txt'].bytes, [...Buffer.from(outputText)]);
  const base = join(root, 'studio/native-harness/workspace-state');
  const allStatePaths = await readdir(base, { recursive: true });
  const paths = allStatePaths.filter(path => /\/runtime\/[a-f0-9]{64}\/record\.json$/u.test(path));
  assert.equal(paths.length, 1); const runtimePath = join(base, paths[0]), runtimeBytes = await readFile(runtimePath, 'utf8'), runtime = JSON.parse(runtimeBytes);
  assert.equal(runtime.phase, 'finished'); assert.equal(runtime.runtimeId, executed.runtime_id); assert.equal(runtime.taskId, executed.task_id);
  assert.deepEqual(runtime.binding.scope, scope); assert.equal(runtime.binding.sessionId, sessionId);
  for (const key of ['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']) assert.deepEqual(runtime.request[key], record.snapshot[key], key);
  assert.equal(runtime.request.callId, 'workflow-call'); assert.equal(runtime.request.call.name, 'execute_skills');
  assert.equal(runtime.request.operationKey, receipts[0].operationKey);
  const intent = record.intents.find(item => item.operationKey === receipts[0].operationKey); assert.ok(intent);
  assert.equal(intent.claimedFence, runtime.request.executionFence);
  assert.equal(runtime.packages.length, 1); assert.equal(runtime.packages[0].archiveHash, skillHash);
  assert.equal(runtime.packages[0].skillId, 'workflow-skill'); assert.equal(runtime.packages[0].versionId, 'workflow-v1');
  assert.equal(runtime.commands.length, 1); assert.equal(runtime.commands[0].taskId, executed.command_ids[0]);
  const commandPaths = allStatePaths.filter(path => path.includes('/runtime/processes/commands/') && path.endsWith('/record.json'));
  assert.equal(commandPaths.length, 1);
  const commandPath = join(base, commandPaths[0]), commandBytes = await readFile(commandPath, 'utf8'), command = JSON.parse(commandBytes);
  assert.equal(command.commandId, executed.command_ids[0]); assert.equal(command.status, 'completed'); assert.equal(command.exitCode, 0);
  assert.equal(command.evidenceIncomplete, false); assert.equal(command.outputLimitExceeded, false);
  const work = join(runtimePath, '../work'); assert.equal(await readFile(join(work, 'effects.txt'), 'utf8'), 'effect\n');
  const runtimeDir = resolve(runtimePath, '..');
  assert.equal(await readFile(join(runtimeDir, 'packages/0/SKILL.md'), 'utf8'), skillText);
  assert.equal(await readFile(join(runtimeDir, 'packages/0/scripts/run-workflow.sh'), 'utf8'), script);
  const historyPaths = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl')); assert.equal(historyPaths.length, 1);
  const historyPath = join(root, 'sessions', historyPaths[0]), beforeHistory = await jsonl(historyPath);
  const owners = beforeHistory.filter(event => event.type === 'turn/owner'); assert.equal(owners.length, 1);
  const ownership = readNativeDshOwnership(owners[0].data, { sessionId, turn: 1 }); assert.deepEqual(ownership.identity.scope, scope);
  assert.equal(ownership.identity.runId, record.snapshot.runId); assert.equal(ownership.identity.buildId, record.snapshot.buildId);
  assert.equal(beforeHistory.filter(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed').length, 1);
  const admissionPath = join(root, 'tool-admissions.jsonl'), admissions = await readFile(admissionPath, 'utf8');
  assert.equal((await jsonl(admissionPath)).length, 1); assert.equal((await jsonl(admissionPath))[0].name, 'execute_skills');
  const before = canonical(record); for (const secret of ['skill-workflow-service-secret', 'skill-workflow-model-secret', 'download-private']) assert.ok(!before.includes(secret));
  await writeFile(join(root, 'native-run-before.json'), before);
  await harness.close(); assert.throws(() => process.kill(originalPid, 0), { code: 'ESRCH' });
  harness = new DeepSeekHarness(options); const resumed = await harness.resumeSession(sessionId); assert.equal(resumed.id, sessionId);
  const restartedPid = harness.client?.child?.pid; assert.ok(Number.isSafeInteger(restartedPid)); assert.notEqual(restartedPid, originalPid);
  const deadline = Date.now() + 15000; let ready;
  while (Date.now() < deadline) { ready = (await jsonl(join(root, 'host-ready.jsonl'))).find(row => row.source === 'resume'); if (ready) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(ready); assert.equal(ready.pid, restartedPid); assert.equal(ready.historyHasAnswer, true); assert.equal(ready.historyHasCompletedTurn, true);
  assert.equal(canonical(await currentRecord()), before); assert.equal(await readFile(runtimePath, 'utf8'), runtimeBytes);
  assert.equal(await readFile(commandPath, 'utf8'), commandBytes);
  assert.equal(await readFile(admissionPath, 'utf8'), admissions); assert.equal(await readFile(join(work, 'effects.txt'), 'utf8'), 'effect\n');
  assert.equal(await readFile(join(runtimeDir, 'packages/0/SKILL.md'), 'utf8'), skillText);
  assert.equal(await readFile(join(runtimeDir, 'packages/0/scripts/run-workflow.sh'), 'utf8'), script);
  for (const item of Object.values(delivered)) assert.equal(digest(await readFile(item.path)), item.sha256);
  const types = new Set(['turn/start', 'turn/owner', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result']);
  assert.deepEqual((await jsonl(historyPath)).filter(event => types.has(event.type)), beforeHistory.filter(event => types.has(event.type)));
  const pids = await jsonl(join(root, 'host-processes.jsonl')); assert.deepEqual(pids.map(item => item.pid), [originalPid, restartedPid]);
  for (const item of pids) { assert.equal(item.node, process.version); assert.equal(item.path, bin); }
  assert.equal(requests.length, 2); assert.equal(downloads, 1); assert.equal(serviceRequests.length, 2); assert.deepEqual(failures, []);
  for (const path of productionPaths) assert.equal(digest(await readFile(join(installed, path))), productionHashes[path]);
  await writeFile(join(root, 'accepted-evidence.json'), JSON.stringify({ node: process.version, archive, archiveSha256,
    sdk: { source, commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    root, productionHashes, fixtureSha256: digest(await readFile(join(installed, fixture))), originalPid, restartedPid,
    scope, sessionId, runId: record.snapshot.runId, operationKey: receipts[0].operationKey, runtimeId: runtime.runtimeId,
    taskId: runtime.taskId, commandIds: executed.command_ids, recordSha256: digest(before), runtimeRecordSha256: digest(runtimeBytes), commandRecordSha256: digest(commandBytes),
    counts: { model: requests.length, directory: 1, downloadUrl: 1, https: downloads, scripts: 1 }, delivered,
    limitation: 'Fixed installed dependency graph; actual graceful Host restart. Not fresh install, E2B, Frozen deployment or SIGKILL acceptance.' }, null, 2));
  console.log(`PASS ${process.version}: actual packed Native Skill workflow, exact binary/text artifacts, original durable ownership and new Host history; ${root}`);
} finally {
  await writeFile(join(root, 'server-failures.json'), JSON.stringify(failures, null, 2));
  await harness?.close();
  for (const server of [service, download, model]) if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
