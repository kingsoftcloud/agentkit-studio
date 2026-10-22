/** Packed Studio + maintained DSH SDK: live isolated child survives Host exit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-native-child-write-recovery-'));
console.log(`Studio writing child recovery evidence: ${root}`);
let harness, recovered = false, parentCalls = 0, childCalls = 0, recoveryStep = 0, originalChildId;
const requests = [], failures = [];
const text = 'Original isolated child bytes, written once.\n';
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    let call, final;
    if (body.model === 'child-proof') {
      childCalls++;
      assert.match(body.messages[0].content, /CHILD_WORKSPACE_WRITER/);
      assert.deepEqual((body.tools ?? []).map(tool => tool.function.name).sort(), ['read_workspace_file', 'write_workspace_file']);
      if (childCalls === 1) call = { name: 'write_workspace_file', arguments: { path: 'child.txt', content: text } };
      else {
        assert.match(JSON.stringify(body.messages.filter(message => message.role === 'tool')), /child\.txt/);
        if (!recovered) {
          if (parentCalls >= 2) await writeFile(join(root, 'crash-requested'), 'The child committed its write and both original models are waiting.');
          return; // Fault injector terminates the real Host while both models wait.
        }
        final = 'Writer delivered the original isolated file.';
      }
    } else {
      assert.equal(body.model, 'parent-proof'); parentCalls++;
      const advertised = (body.tools ?? []).map(tool => tool.function.name);
      assert.ok(advertised.includes('native_child_merge'));
      if (!recovered && parentCalls === 1) call = { name: 'native_start_child', arguments: {
        role: 'writer', task: 'Write child.txt once with the agreed evidence.', background: true } };
      else if (!recovered) {
        originalChildId = [...JSON.stringify(body.messages).matchAll(/native-child-[a-f0-9]{64}/g)].at(-1)?.[0];
        assert.ok(originalChildId);
        if (childCalls >= 2) await writeFile(join(root, 'crash-requested'), 'The child committed its write and both original models are waiting.');
        return;
      } else {
        assert.match(JSON.stringify(body.messages), new RegExp(originalChildId));
        const step = recoveryStep++;
        if (step === 0) call = { name: 'native_child_control', arguments: { child_run_id: originalChildId, action: 'wait', wait_seconds: 1 } };
        else if (step === 1) call = { name: 'native_child_result', arguments: { child_run_id: originalChildId } };
        else if (step === 2) {
          assert.match(JSON.stringify(body.messages), /Writer delivered the original isolated file/);
          call = { name: 'native_child_merge', arguments: { child_run_id: originalChildId } };
        } else {
          const result = body.messages.filter(message => message.role === 'tool').at(-1);
          assert.match(result.content, /native\.child-file-merge\/v2/);
          assert.equal(JSON.parse(result.content).ok, true);
          final = 'Recovered original writer and published its file once.';
        }
      }
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `proof-${requests.length}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: final };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: `response-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.statusCode = 500; response.end('Writing child recovery proof failed'); }
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rpc(method, payload) {
  const { origin, cookie } = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
  const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); return (await response.json()).result;
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || name === '@deepseek-ai') continue;
    await symlink(join(repository, 'node_modules', name), join(dependencies, name));
  }
  const publicPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(publicPackages)) await symlink(join(publicPackages, name), join(dependencies, '@deepseek-ai', name));
  const pluginDirectory = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(pluginDirectory, { recursive: true }); await symlink(installed, join(pluginDirectory, 'agentkit-studio'));
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  const patch = join(root, 'child-write-recovery.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:', '    - id: child-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: child-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: child-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: child-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: child-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: child-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: child-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: child-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-children.mjs')).href)}`,
    '      config:', '        writingRecovery: true', `        directory: ${JSON.stringify(root)}`,
    `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-parent-profile', model: 'parent-proof', initializeTimeoutMs: 30000, requestTimeoutMs: 45000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options);
  await assert.rejects(harness.session('native-child-parent').run('Use the isolated writer, wait for completion, then publish its file.'), /exit code: 37/);
  assert.deepEqual(failures, []);
  const crash = JSON.parse(await readFile(join(root, 'child-write-crash.json'), 'utf8'));
  const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
  const parentBefore = crash.parent, childBefore = crash.child, parent = parentBefore.snapshot, child = childBefore.snapshot;
  assert.equal(child.runId, originalChildId); assert.equal(parent.scope.agentId, agentId);
  assert.equal(parent.childBudgetReservations.length, 1);
  assert.equal(parent.childBudgetReservations[0].childRunId, child.runId);
  assert.equal(childBefore.configuration.childOwnerBinding.parent.runId, parent.runId);
  assert.equal(child.usage.toolCalls, 1); assert.equal(child.phase, 'requesting_model');
  assert.equal(parent.phase, 'requesting_model'); assert.equal(crash.events.some(event => event.type === 'turn/end'), false);
  const { createAgentStore } = await import(pathToFileURL(join(installed, 'src/agent-store.mjs')).href);
  const { nativeChildRoles } = await import(pathToFileURL(join(installed, 'src/providers/native-subagents.mjs')).href);
  const { createStudioNativeChildWorkspaces } = await import(pathToFileURL(join(installed, 'src/providers/native-child-workspace-host.mjs')).href);
  const agent = await createAgentStore({ storeDir: join(root, 'studio/agents') }).get(agentId);
  const role = nativeChildRoles(agent.spec)[0];
  const workspaces = createStudioNativeChildWorkspaces({ workspaceRoot: join(root, 'workspace'), stateDir: join(root, 'studio/native-harness') });
  const isolation = workspaces.bind({ scope: child.scope, sessionId: child.sessionId, role, existing: true,
    expectedBinding: childBefore.configuration.hostRecoveryBinding.childWorkspace });
  assert.equal(await readFile(join(isolation.root, 'child.txt'), 'utf8'), text);
  await assert.rejects(readFile(join(root, 'workspace/child.txt')), { code: 'ENOENT' });
  console.log('Crash boundary proven: original parent and child Run, committed isolated write, both awaiting models, no parent publication.');
  await harness.close(); harness = null;
  // Real wall-clock leases expire naturally; no ledger edits or synthetic clock.
  const leaseDeadline = Math.max(parentBefore.lease?.expiresAt ?? 0, childBefore.lease?.expiresAt ?? 0);
  if (leaseDeadline >= Date.now()) await sleep(leaseDeadline - Date.now() + 50);
  recovered = true;
  harness = new DeepSeekHarness(options); await harness.start();
  const identity = { agentId, sessionId: parent.sessionId }, request = { ...identity, runId: parent.runId };
  const requestsBeforeStatus = requests.length;
  const status = await rpc('sessions/native-recovery-status', identity);
  assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.value.state, 'available');
  assert.equal(status.value.runId, parent.runId); assert.equal(requests.length, requestsBeforeStatus);
  const wrong = await rpc('sessions/native-recovery-resume', { ...identity, runId: 'other-run' });
  assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'studio_native_recovery_identity_mismatch');
  const acks = await Promise.all([rpc('sessions/native-recovery-resume', request), rpc('sessions/native-recovery-resume', request)]);
  assert.ok(acks.every(ack => ack.ok && ack.value.state === 'recovering' && ack.value.runId === parent.runId), JSON.stringify(acks));
  let settled;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    settled = await rpc('sessions/native-recovery-status', request);
    if (settled.value?.state !== 'recovering') break;
    await sleep(25);
  }
  assert.deepEqual(failures, []);
  assert.equal(settled?.value?.state, 'closed', JSON.stringify(settled));
  const finishedCalls = requests.length;
  assert.equal((await rpc('sessions/native-recovery-resume', request)).value.state, 'closed');
  assert.equal(requests.length, finishedCalls);
  await harness.close(); harness = null;
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    assert.equal(store.list(parent.scope, parent.sessionId).length, 1);
    assert.equal(store.list(child.scope, child.sessionId).length, 1);
    const finalParent = store.load(parent.scope, parent.runId), finalChild = store.load(child.scope, child.runId);
    assert.equal(finalParent.snapshot.phase, 'completed'); assert.equal(finalChild.snapshot.phase, 'completed');
    assert.equal(finalParent.snapshot.finalText, 'Recovered original writer and published its file once.');
    assert.equal(finalChild.snapshot.finalText, 'Writer delivered the original isolated file.');
    assert.deepEqual(finalParent.configuration, parentBefore.configuration);
    assert.deepEqual(finalChild.configuration, childBefore.configuration);
    assert.deepEqual(finalParent.events.slice(0, parentBefore.events.length), parentBefore.events);
    assert.deepEqual(finalChild.events.slice(0, childBefore.events.length), childBefore.events);
    assert.equal(finalChild.snapshot.usage.toolCalls, 1);
    for (const row of [finalParent, finalChild]) {
      assert.equal(row.configuration.modelRecoveryPolicy, 'pure-inference/v1');
      assert.equal(row.snapshot.diagnostics.uncertainModelCalls, 1);
      assert.equal(row.snapshot.diagnostics.providerUsageIncomplete, true);
      const replayed = row.receipts.filter(receipt => receipt.status === 'uncertain'
        && receipt.result.recoveryPolicy === 'pure-inference/v1' && receipt.result.retryScheduled === true);
      assert.equal(replayed.length, 1, 'The lost inference remains uncertain and charged before a new attempt.');
    }
    assert.equal(finalParent.snapshot.usage.modelCalls, 6);
    assert.equal(finalChild.snapshot.usage.modelCalls, 3);
    assert.equal(finalParent.snapshot.descendantUsage.modelCalls, 3);
    assert.ok(finalParent.snapshot.childBudgetReservations[0].settledUsageDigest);
    const calls = finalParent.receipts.flatMap(receipt => receipt.result?.results ?? []);
    assert.equal(calls.filter(result => result.content?.schema_version === 'native.child-file-merge/v2' && result.content.ok).length, 1);
  } finally { store.close(); }
  const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(admissions.filter(call => call.name === 'write_workspace_file' && call.arguments.path === 'child.txt').length, 1);
  assert.equal(admissions.filter(call => call.name === 'native_child_merge').length, 1);
  assert.equal(childCalls, 3); assert.equal(parentCalls, 6);
  assert.equal(await readFile(join(root, 'workspace/child.txt'), 'utf8'), text);
  assert.equal(await readFile(join(isolation.root, 'child.txt'), 'utf8'), text);
  const logs = (await readdir(join(root, 'sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
  const events = (await Promise.all(logs.map(file => readFile(join(root, 'sessions', file), 'utf8'))))
    .flatMap(value => value.trim().split('\n').map(JSON.parse)).filter(event => event.type !== 'header' && event.type !== 'session');
  assert.deepEqual(events.slice(0, crash.events.length), crash.events);
  for (const kind of ['turn/start', 'turn/owner', 'turn/end']) assert.equal(events.filter(event => event.type === kind).length, 1);
  await writeFile(join(root, 'verified.json'), JSON.stringify({ parentRunId: parent.runId, childRunId: child.runId,
    childWorkspaceBinding: isolation.binding, childWrites: 1, parentPublications: 1, parentCalls, childCalls, node: process.version }, null, 2));
  console.log('PASS: packed production Host cold-resumed the original live writing child, one write, one controlled publication, duplicate recovery harmless, original Session/Run/config/event prefixes retained, Node-only PATH.');
} finally {
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
