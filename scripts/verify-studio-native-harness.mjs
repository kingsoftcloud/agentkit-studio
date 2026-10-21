/** Actual Studio Native Host through a selected preset and the shipped DSH SDK. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';
import { readNativeDshOwnership } from '../packages/agentkit-harness/src/native/dsh-turn-ownership.mjs';
import { respondToAutomationProof, runAutomationProof, verifyAutomationLedger } from './native-automation-proof.mjs';
import { respondToMemoryProof, runMemoryProof } from './native-memory-proof.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, keep: { type: 'boolean', default: false },
  'mount-host': { type: 'boolean', default: false }, 'mcp-schema': { type: 'boolean', default: false },
  commands: { type: 'boolean', default: false }, frozen: { type: 'boolean', default: false },
  automation: { type: 'boolean', default: false }, recovery: { type: 'boolean', default: false },
  hooks: { type: 'boolean', default: false }, memory: { type: 'boolean', default: false }, archive: { type: 'string' } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
assert.ok(!values['mcp-schema'] || values['mount-host'], '--mcp-schema requires --mount-host');
assert.ok(!values.commands || !values['mcp-schema'], '--commands and --mcp-schema are separate proofs');
assert.ok(!values.frozen || values['mount-host'], '--frozen requires --mount-host');
assert.ok(!values.automation || values['mount-host'] && values.commands && !values.frozen, '--automation requires --mount-host --commands without --frozen');
assert.ok(!values.recovery || values['mount-host'] && !values.automation, '--recovery requires --mount-host without --automation');
assert.ok(!values.hooks || values['mount-host'] && !values.automation && !values.commands && !values['mcp-schema'],
  '--hooks exercises mounted Host workspace tools without automation/commands/MCP');
assert.ok(!values.memory || values['mount-host'] && !values.automation && !values.commands && !values['mcp-schema'] && !values.hooks && !values.recovery,
  '--memory exercises mounted Host original-user Memory without the other proof scenarios; --frozen is supported');
const toolName = values.commands ? 'run_command' : 'write_workspace_file';
const source = resolve(values.source), repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'studio-native-host-')), requests = [], failures = [];
const exactInteger = 9007199254740993n, mcpEffects = [];
const automationCalls = []; let automationProof;
console.log(`Studio Native Host evidence: ${root}`);
const jsonRows = async path => (await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
})).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function waitForPublicPrefix(count, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await jsonRows(join(root, 'assistant-stream.jsonl'));
    const native = rows.filter(row => row.frame.attemptId.startsWith('native-dsh-'));
    const current = native.filter(row => row.frame.type === 'start')[count - 1]?.frame.attemptId;
    if (current && native.some(row => row.frame.attemptId === current
      && (row.frame.chunk?.text === expected || row.frame.chunk?.argumentsDelta === expected))) {
      assert.equal(native.filter(row => row.frame.type === 'start').length, count);
      assert.equal(native.filter(row => row.frame.type === 'end').length, count - 1,
        'Public prefix must precede durable model settlement');
      if (!values.memory && count % 2) assert.equal((await jsonRows(join(root, 'tool-admissions.jsonl'))).length, (count - 1) / 2,
        'An unsealed streamed tool preview cannot dispatch the tool');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`No public Native stream prefix before provider completion ${count}`);
}
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (values['mcp-schema'] && request.url === '/mcp') {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      const body = parseNativeJson(raw);
      if (body.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      const exactId = { type: 'integer', minimum: exactInteger, maximum: exactInteger };
      if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion,
        serverInfo: { name: 'studio-native-schema', version: '1' }, capabilities: { tools: {} } };
      else if (body.method === 'tools/list') result = { tools: [{ name: 'write_workspace_file', description: 'Publish the requested marker.',
        inputSchema: { type: 'object', properties: { id: exactId, path: { type: 'string' }, content: { type: 'string' } },
          required: ['id', 'path', 'content'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { id: exactId }, required: ['id'] } }] };
      else if (body.method === 'tools/call') {
        const args = body.params.arguments;
        assert.equal(body.params.name, 'write_workspace_file'); assert.equal(args.id, exactInteger);
        assert.match(args.path, /^published-[12]\.txt$/);
        mcpEffects.push(args.path);
        await writeFile(join(root, 'workspace', args.path), args.content);
        result = { content: [{ type: 'text', text: 'Marker published.' }], structuredContent: { id: exactInteger }, _meta: { audit: 'private-mcp-schema-audit' } };
      } else throw Error(`Unexpected MCP method ${body.method}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(canonical({ jsonrpc: '2.0', id: body.id, result })); return;
    }
    const body = JSON.parse(raw);
    if (values.memory) {
      await respondToMemoryProof({ request, response, body, requests, frozen: values.frozen, waitForPublicPrefix }); return;
    }
    if (values.automation && respondToAutomationProof(body, response, automationCalls)) return;
    requests.push(body);
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    if (values.frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
    }
    assert.deepEqual(body.tools.map(tool => tool.function.name), [toolName]);
    if (values['mcp-schema']) {
      const parameters = parseNativeJson(raw).tools[0].function.parameters;
      assert.equal(parameters.properties.id.minimum, exactInteger); assert.equal(parameters.properties.id.maximum, exactInteger);
      assert.equal(JSON.stringify(body.messages).includes('private-mcp-schema-audit'), false);
    }
    const count = requests.length, turn = Math.ceil(count / 2);
    if (count === 2 || count === 4) {
      assert.equal(body.messages.filter(message => message.role === 'tool').at(-1).content, `Published published-${turn}.txt (policy view)`);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.equal(body.messages.at(-1).content, `Live instruction for published-${turn}.txt`);
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === `Loaded context for published-${turn}.txt`));
    }
    if (count === 3) {
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Publish marker 1 and report completion.'));
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Loaded context for published-1.txt'));
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Live instruction for published-1.txt'));
    }
    if (count === 6) assert.match(JSON.stringify(body.messages.filter(message => message.role === 'tool').at(-1)), /Verification policy denied this write/);
    const args = values.commands ? { command: `printf publication-${turn} > ${turn === 3 ? 'denied.txt' : `published-${turn}.txt`}`, timeout: 2 }
      : { path: turn === 3 ? 'denied.txt' : `published-${turn}.txt`, content: `publication-${turn}`,
        ...(values['mcp-schema'] ? { id: exactInteger } : {}) };
    const delta = count % 2 ? { tool_calls: [{ index: 0, id: 'reused-provider-id', type: 'function',
      function: { name: toolName, arguments: values['mcp-schema'] ? canonical(args) : JSON.stringify(args) } }] }
      : { content: turn === 3 ? 'Policy denied the write.' : `Native turn ${turn} completed.` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const complete = delta.content;
    const prefix = complete ? complete.slice(0, 7) : delta.tool_calls[0].function.arguments;
    const first = complete ? { content: prefix } : delta;
    response.write(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta: first, finish_reason: null }] })}\n\n`);
    await waitForPublicPrefix(count, prefix);
    const rest = complete ? { content: complete.slice(7) } : {};
    response.end(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta: rest,
      finish_reason: count % 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    failures.push(error);
    if (values.memory) await writeFile(join(root, 'memory-model-errors.json'), JSON.stringify(failures.map(item => ({ message: item.message, stack: item.stack })), null, 2));
    if (values.automation) await writeFile(join(root, 'automation-model-errors.json'), JSON.stringify(failures.map(item => ({ message: item.message, stack: item.stack })), null, 2));
    if (!response.headersSent) response.writeHead(500);
    response.end('verification failed');
  }
});
let harness;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  // Install the actual packed Studio files into an isolated Host graph. DSH
  // owns its public packages; ordinary Studio dependencies use the installed
  // versions in this checkout. Nothing is installed into the developer's home.
  if (!values.archive) execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: repository, stdio: 'pipe' });
  const packedName = values.archive || (await readdir(root)).find(name => name.endsWith('.tgz'));
  assert.ok(packedName, 'Studio package was produced');
  const archive = values.archive ? resolve(packedName) : join(root, packedName);
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', archive, '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue;
    await symlink(join(repository, 'node_modules', entry), join(dependencies, entry));
  }
  const dshDependencies = values['mount-host'] ? join(source, 'apps/cli/node_modules/@deepseek-ai') : join(repository, 'node_modules/@deepseek-ai');
  for (const entry of await readdir(dshDependencies)) {
    await symlink(join(dshDependencies, entry), join(dependencies, '@deepseek-ai', entry));
  }
  if (!values['mount-host']) {
    await symlink(join(source, 'packages/core/system-prompt'), join(dependencies, '@deepseek-ai/dsh-system-prompt'));
    await symlink(join(source, 'packages/core/agent'), join(dependencies, '@deepseek-ai/dsh-agent'));
  }
  if (values['mount-host']) {
    const profilePackages = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
    await mkdir(profilePackages, { recursive: true });
    await symlink(installed, join(profilePackages, 'agentkit-studio'));
  }
  const nodeOnlyBin = join(root, 'node-only-bin');
  await mkdir(nodeOnlyBin); await symlink(process.execPath, join(nodeOnlyBin, 'node'));
  const patch = join(root, 'native.patch.yml'), sessions = join(root, 'sessions');
  const mountedRows = values['mount-host'] ? [
    '    - id: studio-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:',
    "        host: '127.0.0.1'", '        port: 0',
    '    - id: studio-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: studio-proof-model-selection-settings', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    ...values.automation || values.recovery ? ['    - id: studio-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
      '    - id: studio-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
      '    - id: studio-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'"] : [],
  ] : [];
  const fixture = values['mount-host'] ? 'studio-native-mounted-harness.mjs' : 'studio-native-harness.mjs';
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(sessions)}`, '    compression: none',
    '- insert:',
    ...mountedRows,
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:',
    `        default: ${values['mount-host'] ? 'standard' : 'studio-native-proof'}`,
    '    - id: studio-native-host-proof', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures', fixture)).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        repository: ${JSON.stringify(installed)}`,
    `        mountHost: ${values['mount-host']}`,
    `        commands: ${values.commands}`,
    `        frozen: ${values.frozen}`,
    `        automation: ${values.automation}`,
    `        recovery: ${values.recovery}`,
    `        hooks: ${values.hooks}`,
    `        memory: ${values.memory}`,
    `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`,
    ...values['mcp-schema'] ? [`        mcpUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/mcp`)}`] : [],
    '',
  ].join('\n'));
  const patches = values['mount-host'] ? [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch] : [patch];
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches, dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-fixture', model: 'pinned', initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, PATH: nodeOnlyBin, AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  if (values.memory) {
    await runMemoryProof({ harness, DeepSeekHarness, options, root, installed, sessions, requests, failures, frozen: values.frozen });
    harness = null;
  } else {
  let session = harness.session('native-studio-session');
  for (let turn = 1; turn <= 2; turn++) {
    let result;
    if (values.recovery && turn === 1) {
      await assert.rejects(session.run('Publish marker 1 and report completion.'), /exit code: 37/);
      const crash = JSON.parse(await readFile(join(root, 'recovery-crash.json'), 'utf8'));
      assert.deepEqual(crash.runs, []); assert.equal(requests.length, 0);
      assert.equal(crash.events.some(event => event.type === 'turn/end'), false);
      await harness.close(); harness = new DeepSeekHarness(options); await harness.start();
      const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
      const rpc = async (method, payload) => {
        const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(15000) });
        return (await response.json()).result;
      };
      const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
      const identity = { agentId, sessionId: 'native-studio-session' };
      const status = await rpc('sessions/native-recovery-status', identity);
      assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.value.state, 'available');
      assert.equal(status.value.runId, parseNativeJson(crash.owner.binding).identity.runId);
      assert.equal(requests.length, 0, 'Status cannot execute the model');
      const wrong = await rpc('sessions/native-recovery-resume', { ...identity, runId: 'other-run' });
      assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'studio_native_recovery_identity_mismatch');
      const request = { ...identity, runId: status.value.runId };
      const acks = await Promise.all([rpc('sessions/native-recovery-resume', request), rpc('sessions/native-recovery-resume', request)]);
      assert.ok(acks.every(ack => ack.ok && ack.value.runId === request.runId && ack.value.state === 'recovering'), JSON.stringify(acks));
      const deadline = Date.now() + 20000;
      let settled;
      while (Date.now() < deadline) {
        settled = await rpc('sessions/native-recovery-status', request);
        if (settled.value?.state !== 'recovering') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(settled?.value?.state, 'closed', JSON.stringify(settled));
      const requestCount = requests.length, confirmed = await rpc('sessions/native-recovery-resume', request);
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed)); assert.equal(confirmed.value.state, 'closed');
      assert.equal(confirmed.value.runId, request.runId); assert.equal(requests.length, requestCount,
        'Confirming a recovery reply after completion cannot execute another model call');
      await harness.close();
      const logs = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
      const events = (await Promise.all(logs.map(file => readFile(join(sessions, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line))).filter(item => item.type !== 'header' && item.type !== 'session');
      assert.deepEqual(events.slice(0, crash.events.length), crash.events);
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
      assert.equal(events.filter(event => event.type === 'turn/owner').length, 1);
      const last = events.findLast(event => event.type === 'assistant/message');
      result = { events, finalResponse: last.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') };
      console.log('Studio Native recovery PASS: real exit37 before Run creation; real SessionController cold resume; authenticated status/identity rejection/duplicate recovery; one original turn/owner/Run, no replacement prompt.');
    } else result = await session.run(`Publish marker ${turn} and report completion.`);
    assert.equal(result.finalResponse, `Native turn ${turn} completed.`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
    for (const kind of ['turn/start', 'turn/owner', 'turn/end', 'tool/call', 'tool/result']) assert.equal(result.events.filter(event => event.type === kind).length, 1, kind);
    const owner = result.events.find(event => event.type === 'turn/owner');
    const admission = readNativeDshOwnership(owner.data, { sessionId: 'native-studio-session', turn });
    assert.ok(owner.seq < result.events.find(event => event.type === 'step/start').seq);
    assert.equal(admission.configuration.hostRecoveryBinding.source.model, 'pinned');
    for (const kind of ['step/start', 'step/end', 'assistant/message']) assert.equal(result.events.filter(event => event.type === kind).length, 2, kind);
    assert.equal(result.events.some(event => ['request/header', 'request/context'].includes(event.type)), false);
    assert.deepEqual(result.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage),
      [{ inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 7 }]);
    assert.equal(await readFile(join(root, 'workspace', `published-${turn}.txt`), 'utf8'), `publication-${turn}${values.hooks ? ' via Hook' : ''}`);
    const receipt = result.events.find(event => event.type === 'tool/result').data.message;
    assert.deepEqual(receipt.content, [{ type: 'text', text: `Published published-${turn}.txt (policy view)` }]);
    const context = result.events.filter(event => event.type === 'user/message').find(event => event.data.source.kind === 'tool');
    assert.deepEqual(context.data.content, [{ type: 'text', text: `Loaded context for published-${turn}.txt` }]);
    assert.equal(context.data.source.callId, receipt.toolCallId);
    assert.equal(result.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && event.data.content.some(block => block.type === 'text'
        && block.text === `Live instruction for published-${turn}.txt`)).length, 1);
    if (turn === 1) { await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession('native-studio-session'); }
  }
  const denied = await session.run('Attempt the denied write and report its denial.');
  assert.equal(denied.finalResponse, 'Policy denied the write.');
  assert.equal(denied.events.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(denied.events.some(event => event.type === 'request/header'), false);
  await assert.rejects(readFile(join(root, 'workspace/denied.txt')), { code: 'ENOENT' });
  if (values.automation) automationProof = await runAutomationProof(root);
  const delegated = await harness.session('default-session').run('Use the default engine.');
  assert.equal(delegated.finalResponse, 'Default engine completed.');
  assert.equal(delegated.events.some(event => event.type === 'turn/owner'), false);
  await harness.close(); harness = null;
  assert.deepEqual(failures, []); assert.equal(requests.length, 6);
  if (values['mcp-schema']) assert.deepEqual(mcpEffects, ['published-1.txt', 'published-2.txt']);
  const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(admissions.length, 3); assert.equal(new Set(admissions.map(row => row.callId)).size, 3);
  assert.deepEqual(admissions.map(row => row.name), [toolName, toolName, toolName]);
  assert.equal((await readFile(join(root, 'default-invocations.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const logs = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
  assert.equal(logs.length, values.automation ? 4 : 2);
  const stored = (await Promise.all(logs.map(file => readFile(join(sessions, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(stored.filter(event => event.type === 'assistant/message').length, values.automation ? 11 : 7);
  assert.equal(stored.filter(event => event.type === 'tool/result').length, values.automation ? 5 : 3);
  const live = (await jsonRows(join(root, 'assistant-stream.jsonl'))).filter(row => row.session === 'native-studio-session' && row.frame.attemptId.startsWith('native-dsh-'));
  const starts = live.filter(row => row.frame.type === 'start');
  assert.equal(starts.length, 6);
  for (const { frame: start } of starts) {
    const frames = live.filter(row => row.frame.attemptId === start.attemptId).map(row => row.frame);
    const chunks = frames.filter(frame => frame.type === 'chunk'), end = frames.at(-1);
    assert.equal(end.type, 'end'); assert.equal(end.outcome.kind, 'committed');
    assert.equal(end.outcome.eventType, 'assistant/message'); assert.equal(end.index, chunks.length);
    assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index));
    assert.ok(frames.every(frame => frame.revision === start.revision));
    const matches = stored.filter(event => event.seq === end.outcome.seq
      && event.type === end.outcome.eventType && event.data.turn === start.turn && event.data.step === start.step
      && JSON.stringify(event.data.stream) === JSON.stringify(chunks.map(({ time, chunk }) => ({ type: 'chunk', time, chunk }))));
    assert.equal(matches.length, 1, 'Every public stream must settle to its exact durable Session stream');
  }
  assert.equal(stored.filter(event => event.type === 'turn/end').length, values.automation ? 6 : 4);
  assert.equal(JSON.stringify(stored).includes('sk-studio-fixture-secret'), false);
  assert.equal((await readFile(join(root, 'studio/native-harness/runs.sqlite'))).includes(Buffer.from('sk-studio-fixture-secret')), false);
  // Inspect the packed Host's independent, durable verdict after both process
  // lifetimes have ended. Successful text delivery cannot manufacture a pass.
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const { createNativeArtifactStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/artifact-store.mjs')).href);
  const { id: agentId, buildId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'),
    userId: 'local-user', agentId };
  const reopened = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    if (automationProof) verifyAutomationLedger({ store: reopened, scope, proof: automationProof, calls: automationCalls, events: stored });
    const runs = reopened.list(scope, 'native-studio-session');
    assert.equal(runs.length, 3);
    if (values.frozen) assert.ok(runs.every(run => run.buildId === buildId));
    assert.equal(runs.filter(run => run.parentRunId === null).length, 1);
    assert.ok(runs.every(run => run.parentRunId === null || runs.some(parent => parent.runId === run.parentRunId)));
    assert.equal(new Set(runs.map(run => reopened.load(scope, run.runId).configuration.contract.revision)).size, 3);
    const evidence = await createNativeArtifactStore({ directory: join(root, 'studio/native-harness/verification-evidence'), scope });
    for (const run of runs) {
      if (values.hooks) {
        const record = reopened.load(scope, run.runId);
        assert.equal(record.configuration.hooks.length, 1); assert.equal(record.configuration.stopHookContinuationLimit, 0);
        const receipts = record.receipts.filter(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1');
        assert.deepEqual(receipts.map(receipt => receipt.result.event), ['PreToolUse', 'PostToolUse', 'Stop']);
        assert.ok(receipts.every(receipt => receipt.status === 'committed' && receipt.result.status === 'ok'));
        assert.equal(record.configuration.hooks[0].sourceRef, 'plugin://studio-proof-governance@1');
        assert.ok(record.snapshot.messages.some(message => message.kind === 'hook_context'));
      }
      if (values.commands) {
        const record = reopened.load(scope, run.runId);
        assert.equal(record.configuration.backgroundNotificationPolicy, 'completed-before-model/v1');
        assert.equal(record.configuration.tools[0].backgroundCommandPolicy, 'owned-command-launch/v1');
        const results = record.receipts.flatMap(receipt => receipt.result.results ?? []);
        assert.equal(results.length, 1);
        if (run.goal === 'Attempt the denied write and report its denial.') assert.equal(results[0].status, 'error');
        else {
          assert.equal(results[0].status, 'ok'); assert.equal(results[0].content.backend, 'sandbox/local_process');
          assert.equal(results[0].content.exit_code, 0); assert.equal(results[0].content.evidence_incomplete, false);
          assert.equal(results[0].content.controls.schemaVersion, 'agentkit.local-process-control/v1');
          assert.match(results[0].content.command, /^printf publication-[12] > published-[12]\.txt$/);
          assert.equal(record.snapshot.workspaceModifiedPaths.filter(path => /^published-[12]\.txt$/.test(path)).length >= 1, true);
        }
      }
      if (values['mcp-schema']) {
        const record = reopened.load(scope, run.runId);
        assert.equal(record.configuration.tools[0].parameters.properties.id.minimum, exactInteger);
        const receipt = record.receipts.flatMap(receipt => receipt.result.results ?? []).find(result => result.content?.structuredContent);
        if (receipt) assert.equal(receipt.content.structuredContent.id, exactInteger);
        else {
          assert.equal(run.goal, 'Attempt the denied write and report its denial.');
          assert.ok(record.receipts.some(receipt => receipt.result.results?.some(result => result.status === 'error')),
            'only the policy-denied Run may omit a remote receipt');
        }
      }
      assert.equal(run.outcome, 'unverified');
      assert.equal(run.verification.checks[0].verifierId, 'studio.delivery-evidence-rejection');
      assert.equal(run.verification.checks[0].status, 'not_run');
      const content = await evidence.read({ scope, runId: run.runId, operationKey: 'inspect', signal: new AbortController().signal,
        ref: run.verification.checks[0].evidence.artifact, offset: 0, limit: 32000 });
      const proof = JSON.parse(content.content);
      assert.equal(proof.candidate.candidateId, run.candidate.candidateId);
      assert.deepEqual(proof.candidate.binding, run.candidate.binding);
      assert.deepEqual(proof.contract, reopened.load(scope, run.runId).configuration.contract);
      assert.equal(proof.contract.objective, run.goal);
      assert.equal(proof.contract.revision, run.verification.contractRevision);
      assert.equal(proof.results[0].status, 'not_run');
    }
  } finally { reopened.close(); }
  if (values['mount-host']) {
    const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(probes.length, values.recovery ? 3 : 2); assert.ok(probes.some(probe => probe.source === 'resume'));
    assert.ok(probes.every(probe => probe.unauthorizedStatus === 401 && probe.compatible));
  }
  if (automationProof) console.log('Studio Native automation PASS: authenticated Build operation, latest Revision schedule and frozen Build evaluation, actual unattended permission denial with no file effect, real model HTTP and durable independent Native ledgers.');
  console.log(`Studio Native Host PASS: ${values['mount-host'] ? 'full mountStudioHost with real authenticated HTTP control RPC, production preset admission and startup restoration' : 'production Host factory and runtime plugin'}, actual packed Studio files, public Host prompt import, Node-only PATH, 2 successful Native turns across process restart plus 1 policy-denied turn, 6 actual model HTTP requests, 6 public live streams before provider completion with exact durable Session stream settlement, ${values['mcp-schema'] ? '2 MCP marker effects with exact model/input/output schemas and persisted numeric receipts' : '2 Node workspace writes'}, authoritative post-policy text, deferred contexts and actual Host inbox steering in model/Session/history, no denied write and 1 separate default DSH turn.`);
  if (values.hooks) {
    const callbacks = await jsonRows(join(root, 'native-hook-callbacks.jsonl'));
    assert.equal(callbacks.length, 9); assert.equal(new Set(callbacks.map(row => row.operationKey + ':' + row.runId)).size, 9);
    assert.ok(callbacks.every(row => row.agentId === agentId && row.sessionId === 'native-studio-session'));
    console.log('Studio Native Hooks PASS: trusted exact-Agent registration; durable Pre/Post/Stop intents and receipts; actual rewritten workspace bytes; no denied write; original provider arguments retained; no callbacks on default DSH.');
  }
  }
} finally {
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
