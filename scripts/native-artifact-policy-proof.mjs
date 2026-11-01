import { createRequire } from 'node:module';
/** Actual packed Studio + maintained SDK/Host. Model HTTP is deterministic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function createArtifactPolicyProof() {
  let uri;
  async function respond({ request, response, raw, requests, frozen }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    const count = requests.length; assert.ok(count <= 5);
    assert.deepEqual(new Set(body.tools.map(tool => tool.function.name)),
      new Set(['list_workspace_files', 'ArtifactRead', 'ArtifactSearch', 'ArtifactList']));
    if (frozen) {
      assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
      assert.equal(JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'), false);
    }
    if (count === 2) {
      const receipt = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      uri = receipt.artifact_uri; assert.equal(typeof uri, 'string');
      const observation = JSON.parse(receipt.observed_content).content;
      assert.equal(observation.paths.length, 100); assert.equal(observation.omitted_entries, 142);
      assert.equal(observation.paths.includes('dir-241'), false);
    }
    if (count === 3 || count === 5) {
      const page = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      assert.equal(page.uri, uri); assert.equal(page.returned_chars, 128); assert.ok(page.content);
    }
    const call = count === 1 ? { name: 'list_workspace_files', arguments: { path: '.', recursive: false } }
      : [2, 4].includes(count) ? { name: 'ArtifactRead', arguments: { uri, limit_chars: 128 } } : null;
    const delta = call ? { tool_calls: [{ index: 0, id: `artifact-call-${count}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: `Archive verified ${count === 3 ? 1 : 2}` };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `artifact-response-${count}`, choices: [{ index: 0, delta,
      finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: initial, DeepSeekHarness, options, root, installed, requests, failures, frozen }) {
    let harness = initial;
    const workspace = join(root, 'workspace'); await mkdir(workspace, { recursive: true });
    for (let index = 0; index < 242; index++) await mkdir(join(workspace, `dir-${String(index).padStart(3, '0')}`));
    try {
      let session = harness.session('native-studio-session');
      assert.equal((await session.run('List the workspace, then read the authorized full archive.')).finalResponse, 'Archive verified 1');
      await harness.close(); harness = new DeepSeekHarness(options);
      session = await harness.resumeSession('native-studio-session');
      assert.equal((await session.run('Read the archive actually granted in the previous turn.')).finalResponse, 'Archive verified 2');
    } finally { await harness.close(); }
    assert.deepEqual(failures, []); assert.equal(requests.length, 5);
    const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(resolve(workspace))).digest('hex'), userId: 'local-user', agentId };
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const { createNativeArtifactStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/artifact-store')).href);
    const ledger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const runs = ledger.list(scope, 'native-studio-session'); assert.equal(runs.length, 2);
      const records = runs.map(run => ledger.load(scope, run.runId));
      for (const record of records) {
        assert.equal(record.snapshot.phase, 'completed'); assert.equal(record.configuration.artifactPolicy, 'runtime-artifacts/v1');
        assert.ok(record.snapshot.artifactRefs.some(ref => ref.uri === uri));
        assert.equal(record.configuration.tools.find(tool => tool.name === 'list_workspace_files').directoryObservationPolicy, 'studio-directory-observation/v3');
      }
      const first = records.find(record => record.snapshot.usage.toolCalls === 2), result = first.receipts.flatMap(row => row.result.results ?? [])[0];
      assert.equal(result.content.entries.length, 242); assert.equal(result.archiveContext.content.includes('dir-241'), true);
      assert.ok(first.snapshot.context.directoryProgress.entries.some(path => path.child_directories.length === 242));
      const artifacts = await createNativeArtifactStore({ directory: join(root, 'studio/native-harness/workspace-state',
        createHash('sha256').update(agentId).digest('hex'), 'result-artifacts'), scope });
      let content = '', offset = 0;
      for (;;) {
        const page = await artifacts.read({ scope, runId: first.snapshot.runId, operationKey: 'proof', signal: new AbortController().signal,
          ref: first.snapshot.artifactRefs.find(ref => ref.uri === uri), offset, limit: 32000 });
        content += page.content; if (page.nextOffset === null) break; offset = page.nextOffset;
      }
      assert.ok(content.includes('dir-241'));
      const admissions = (await readFile(join(root, 'tool-admissions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(admissions.map(item => item.name), ['list_workspace_files']);
      const probes = (await readFile(join(root, 'mounted-host-http.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(probes.length, 2); assert.equal(new Set(probes.map(probe => probe.hostPid)).size, 2);
      assert.ok(probes.every(probe => Number.isSafeInteger(probe.hostPid) && probe.unauthorizedStatus === 401 && probe.compatible));
      await writeFile(join(root, 'artifact-policy-proof.json'), JSON.stringify({ passed: true, node: process.version, frozen,
        runs: records.map(record => ({ runId: record.snapshot.runId, modelCalls: record.snapshot.usage.modelCalls,
          toolCalls: record.snapshot.usage.toolCalls })), hostPids: probes.map(probe => probe.hostPid),
        archiveUri: uri, canonicalEntries: 242, modelEntries: 100,
        scope: 'Packed mounted Host and two SDK processes, inherited artifact grant, actual Node filesystem/SQLite/ArtifactStore; controlled model HTTP and reused maintained dependencies. No clean-install/all-entry/default-switch claim.' }, null, 2));
    } finally { ledger.close(); }
    console.log('Studio Native artifact policy PASS: two SDK turns/cold Host, bounded directory view, full archive, inherited earned read, reserved tools bypass external registry.');
  }
  return { respond, run };
}
