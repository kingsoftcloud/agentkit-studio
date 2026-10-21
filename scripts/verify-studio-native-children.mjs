/** Real SDK + production preset admission + packed Studio parent/child execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source);
const root = await mkdtemp(join(tmpdir(), 'studio-native-children-sdk-'));
console.log(`Studio child evidence: ${root}`);
let harness, turn = 1, parentStep = 0;
const requests = [], failures = [];
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    const child = body.model === 'child-proof';
    assert.ok(child || body.model === 'parent-proof');
    let call, text;
    if (child) {
      assert.deepEqual(body.tools.map(tool => tool.function.name), ['read_workspace_file']);
      assert.match(body.messages[0].content, /CHILD_WORKSPACE_READER/);
      const results = body.messages.filter(message => message.role === 'tool');
      if (!results.length) call = { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
      else { assert.match(results.at(-1).content, /Evidence from the actual child workspace/); text = `Child evidence ${turn}`; }
    } else {
      assert.ok(body.tools.some(tool => tool.function.name === 'native_start_child'));
      if (parentStep++ === 0) call = { name: 'native_start_child', arguments: { role: 'reader', task: `Read proof.txt for turn ${turn}` } };
      else text = `Parent completed ${turn}`;
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `tool-${requests.length}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { failures.push(error); response.statusCode = 500; response.end('Child proof failed'); }
});
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
  const patch = join(root, 'children.patch.yml');
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:', '    - id: child-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:', "        host: '127.0.0.1'", '        port: 0',
    '    - id: child-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: child-proof-model-selection', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    '    - id: child-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: child-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-children.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`, '',
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-parent-profile', model: 'parent-proof', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options);
  let session = harness.session('native-child-parent');
  for (turn = 1; turn <= 2; turn++) {
    parentStep = 0;
    const result = await session.run(`Use a bounded reader for proof ${turn}.`);
    assert.equal(result.finalResponse, `Parent completed ${turn}`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
    const tools = result.events.filter(event => event.type === 'tool/call');
    assert.equal(tools.length, 1); assert.equal(tools[0].data.name, 'native_start_child');
    assert.equal(result.events.filter(event => event.type === 'tool/result').length, 1);
    if (turn === 1) { await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession('native-child-parent'); }
  }
  await harness.close(); harness = null;
  assert.deepEqual(failures, []); assert.equal(requests.filter(body => body.model === 'child-proof').length, 4);
  const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
  const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(join(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
  try {
    const parents = store.list(scope, 'native-child-parent'); assert.equal(parents.length, 2);
    const childIds = new Set();
    for (const parent of parents) {
      assert.equal(parent.phase, 'completed'); assert.equal(parent.childBudgetReservations.length, 1);
      assert.equal(parent.descendantUsage.modelCalls, 2); assert.equal(parent.descendantUsage.toolCalls, 1);
      const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
      childIds.add(reservation.childRunId);
      const child = store.load(reservation.childScope, reservation.childRunId);
      assert.equal(child.snapshot.phase, 'completed'); assert.equal(child.configuration.profile.profileId, 'child-profile');
      assert.equal(child.configuration.childOwnerBinding.parent.runId, parent.runId); assert.equal(child.snapshot.parentRunId, null);
      assert.equal(child.snapshot.usage.toolCalls, 1);
      assert.equal(store.events(scope, parent.runId).filter(event => event.kind === 'usage.reported' && event.payload.source === 'descendant_runs').length, 1);
    }
    assert.equal(childIds.size, 2);
    assert.equal(JSON.stringify(parents).includes('child-proof-secret'), false);
  } finally { store.close(); }
  console.log('Studio Native children PASS: actual packed mountStudioHost, authenticated preset admission, independent approved child model, real scoped workspace reads, one budget settlement per child, two parent turns across Host restart, Node-only PATH.');
} finally {
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
