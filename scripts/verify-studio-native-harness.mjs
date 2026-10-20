/** Actual Studio Native Host through a selected preset and the shipped DSH SDK. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' }, keep: { type: 'boolean', default: false } } });
assert.ok(values.source, 'Use --source <built maintained DSH checkout>');
const source = resolve(values.source), repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'studio-native-host-')), requests = [], failures = [];
console.log(`Studio Native Host evidence: ${root}`);
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(body.model, 'pinned');
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['write_workspace_file']);
    const count = requests.length, turn = Math.ceil(count / 2);
    if (count === 2 || count === 4) {
      assert.equal(body.messages.filter(message => message.role === 'tool').at(-1).content, `Published published-${turn}.txt (policy view)`);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.equal(body.messages.at(-1).content, `Loaded context for published-${turn}.txt`);
    }
    if (count === 3) {
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Publish marker 1 and report completion.'));
      assert.ok(body.messages.some(message => message.role === 'user' && message.content === 'Loaded context for published-1.txt'));
    }
    if (count === 6) assert.match(JSON.stringify(body.messages.filter(message => message.role === 'tool').at(-1)), /Verification policy denied this write/);
    const delta = count % 2 ? { tool_calls: [{ index: 0, id: 'reused-provider-id', type: 'function',
      function: { name: 'write_workspace_file', arguments: JSON.stringify({ path: turn === 3 ? 'denied.txt' : `published-${turn}.txt`, content: `publication-${turn}` }) } }] }
      : { content: turn === 3 ? 'Policy denied the write.' : `Native turn ${turn} completed.` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `response-${count}`, choices: [{ index: 0, delta,
      finish_reason: count % 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.writeHead(500); response.end('verification failed'); }
});
let harness;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  // Install the actual packed Studio files into an isolated Host graph. DSH
  // owns its public packages; ordinary Studio dependencies use the installed
  // versions in this checkout. Nothing is installed into the developer's home.
  execFileSync('pnpm', ['pack', '--pack-destination', root], { cwd: repository, stdio: 'pipe' });
  const archive = (await readdir(root)).find(name => name.endsWith('.tgz'));
  assert.ok(archive, 'Studio package was produced');
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', join(root, archive), '-C', graph]);
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue;
    await symlink(join(repository, 'node_modules', entry), join(dependencies, entry));
  }
  for (const entry of await readdir(join(repository, 'node_modules/@deepseek-ai'))) {
    await symlink(join(repository, 'node_modules/@deepseek-ai', entry), join(dependencies, '@deepseek-ai', entry));
  }
  await symlink(join(source, 'packages/core/system-prompt'), join(dependencies, '@deepseek-ai/dsh-system-prompt'));
  const nodeOnlyBin = join(root, 'node-only-bin');
  await mkdir(nodeOnlyBin); await symlink(process.execPath, join(nodeOnlyBin, 'node'));
  const patch = join(root, 'native.patch.yml'), sessions = join(root, 'sessions');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(sessions)}`, '    compression: none',
    '- insert:',
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: studio-native-proof',
    '    - id: studio-native-host-proof', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-harness.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`, '',
  ].join('\n'));
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk', patches: [patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-fixture', model: 'pinned', initializeTimeoutMs: 30_000, requestTimeoutMs: 30_000,
    env: { ...process.env, PATH: nodeOnlyBin, AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } };
  harness = new DeepSeekHarness(options);
  let session = harness.session('native-studio-session');
  for (let turn = 1; turn <= 2; turn++) {
    const result = await session.run(`Publish marker ${turn} and report completion.`);
    assert.equal(result.finalResponse, `Native turn ${turn} completed.`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
    for (const kind of ['turn/start', 'turn/end', 'tool/call', 'tool/result']) assert.equal(result.events.filter(event => event.type === kind).length, 1, kind);
    for (const kind of ['step/start', 'step/end', 'assistant/message']) assert.equal(result.events.filter(event => event.type === kind).length, 2, kind);
    assert.equal(result.events.some(event => ['request/header', 'request/context'].includes(event.type)), false);
    assert.deepEqual(result.events.filter(event => event.type === 'assistant/message').map(event => event.data.usage),
      [{ inputTokens: 5, outputTokens: 7 }, { inputTokens: 5, outputTokens: 7 }]);
    assert.equal(await readFile(join(root, 'workspace', `published-${turn}.txt`), 'utf8'), `publication-${turn}`);
    const receipt = result.events.find(event => event.type === 'tool/result').data.message;
    assert.deepEqual(receipt.content, [{ type: 'text', text: `Published published-${turn}.txt (policy view)` }]);
    const context = result.events.filter(event => event.type === 'user/message').find(event => event.data.source.kind === 'tool');
    assert.deepEqual(context.data.content, [{ type: 'text', text: `Loaded context for published-${turn}.txt` }]);
    assert.equal(context.data.source.callId, receipt.toolCallId);
    if (turn === 1) { await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession('native-studio-session'); }
  }
  const denied = await session.run('Attempt the denied write and report its denial.');
  assert.equal(denied.finalResponse, 'Policy denied the write.');
  assert.equal(denied.events.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(denied.events.some(event => event.type === 'request/header'), false);
  await assert.rejects(readFile(join(root, 'workspace/denied.txt')), { code: 'ENOENT' });
  const delegated = await harness.session('default-session').run('Use the default engine.');
  assert.equal(delegated.finalResponse, 'Default engine completed.');
  await harness.close(); harness = null;
  assert.deepEqual(failures, []); assert.equal(requests.length, 6);
  const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(admissions.length, 3); assert.equal(new Set(admissions.map(row => row.callId)).size, 3);
  assert.deepEqual(admissions.map(row => row.name), ['write_workspace_file', 'write_workspace_file', 'write_workspace_file']);
  assert.equal((await readFile(join(root, 'default-invocations.jsonl'), 'utf8')).trim().split('\n').length, 1);
  const logs = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'));
  assert.equal(logs.length, 2);
  const stored = (await Promise.all(logs.map(file => readFile(join(sessions, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(stored.filter(event => event.type === 'assistant/message').length, 7);
  assert.equal(stored.filter(event => event.type === 'tool/result').length, 3);
  assert.equal(stored.filter(event => event.type === 'turn/end').length, 4);
  assert.equal(JSON.stringify(stored).includes('sk-studio-fixture-secret'), false);
  assert.equal((await readFile(join(root, 'studio/native-harness/runs.sqlite'))).includes(Buffer.from('sk-studio-fixture-secret')), false);
  console.log('Studio Native Host PASS: actual packed Studio files, public Host prompt import, Node-only PATH, selected production preset, 2 successful Native turns across process restart plus 1 policy-denied turn, 6 actual HTTP requests, 2 Node workspace writes, authoritative post-policy text and deferred contexts in model/Session/history, no denied write and 1 separate default DSH turn.');
} finally {
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
