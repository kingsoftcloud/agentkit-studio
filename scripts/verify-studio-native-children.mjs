import { createRequire } from 'node:module';
/** Real SDK + production preset admission + packed Studio parent/child execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createChildRewindProof } from './native-child-rewind-proof.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' },
  promote: { type: 'boolean' }, 'continue-child': { type: 'boolean' }, history: { type: 'boolean' }, 'child-controls': { type: 'boolean' }, 'conversation-rewind': { type: 'boolean' },
  'guidance-fifo': { type: 'boolean' }, 'task-controls': { type: 'boolean' }, 'child-plan': { type: 'boolean' }, 'edit-matching': { type: 'boolean' }, 'structured-patch': { type: 'boolean' }, 'workspace-rewind': { type: 'boolean' }, 'command-workspace': { type: 'boolean' } } });
assert.ok(values.source && values.archive, 'Use --source <built maintained DSH> --archive <Studio.tgz>');
if (values['conversation-rewind']) assert.ok(!Object.entries(values).some(([key, value]) => value === true
  && !['conversation-rewind', 'keep'].includes(key)), '--conversation-rewind is a separate child lifecycle proof');
const conversationRewindProof = values['conversation-rewind'] ? createChildRewindProof() : null;
if (values['child-controls']) assert.ok(values.promote && values.history && values['continue-child'], '--child-controls requires --promote --history --continue-child');
if (values['guidance-fifo']) assert.ok(values['child-controls'], '--guidance-fifo requires --child-controls');
if (values['task-controls']) assert.ok(!values.promote && !values['child-controls'], '--task-controls runs its own bounded child workflow');
if (values['child-plan']) assert.ok(values['task-controls'] && values['continue-child'], '--child-plan requires --task-controls --continue-child');
if (values['edit-matching']) assert.ok(values['continue-child'] && values.history && !values['task-controls'] && !values['child-controls'] && !values.promote,
  '--edit-matching requires --continue-child --history without other child scenarios');
if (values['structured-patch']) assert.ok(values['continue-child'] && values.history && !values['task-controls'] && !values['child-controls'] && !values.promote && !values['edit-matching'],
  '--structured-patch requires --continue-child --history without other child scenarios');
const editedChild = values['edit-matching'] || values['structured-patch'];
if (values['command-workspace']) assert.ok(values['continue-child'] && values.history && !editedChild
  && !values.promote && !values['task-controls'] && !values['child-controls'], '--command-workspace requires --continue-child --history on its own');
if (values['workspace-rewind']) assert.ok(values['structured-patch'], '--workspace-rewind requires --structured-patch');
const repository = resolve(fileURLToPath(new URL('..', import.meta.url))), source = resolve(values.source);
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-native-children-sdk-')));
console.log(`Studio child evidence: ${root}`);
let harness, turn = 1, parentStep = 0, childStep = 0, firstChildId, firstCheckpoint;
const requests = [], failures = [], httpMetadata = [];
let releaseChild, promotion = null;
const parentContinued = new Promise(resolve => { releaseChild = resolve; });
async function control(method, payload) {
  const { origin, cookie } = JSON.parse(await readFile(join(root, 'control-auth.json'), 'utf8'));
  const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }) });
  const reply = (await response.json()).result;
  assert.equal(response.status, 200); assert.equal(reply?.ok, true, JSON.stringify(reply));
  return reply.value;
}
const latestChild = body => [...JSON.stringify(body.messages).matchAll(/native-child-[a-f0-9]{64}/g)].at(-1)?.[0];
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const part of request) raw += part;
    httpMetadata.push({ method: request.method, path: request.url, bytes: Buffer.byteLength(raw) });
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: ['parent-proof', 'child-proof'].map(id => ({ id, object: 'model' })) }));
      return;
    }
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    if (conversationRewindProof) return conversationRewindProof.respond({ body, response });
    const child = body.model === 'child-proof';
    assert.ok(child || body.model === 'parent-proof');
    if (values['command-workspace'] && !child) assert.doesNotMatch(body.messages[0].content,
      /Use the read tool —|Use the glob tool —|Track every background job id|create_goal may infer|Start independent delegations with/);
    let call, calls, text;
    if (child) {
      const finalOnly = values['guidance-fifo'] && turn === 1 && childStep === 2 || values['task-controls'] && childStep === 3
        || editedChild && (values['workspace-rewind'] ? turn === 2 && childStep === 3 : childStep === 2);
      assert.deepEqual((body.tools ?? []).map(tool => tool.function.name).filter(name => name !== 'submit_final_output'), finalOnly ? []
        : ['read_workspace_file', ...(values['command-workspace'] ? ['run_command'] : []), ...(values['child-plan'] ? ['write_workspace_file'] : []),
          ...(values['edit-matching'] ? ['edit_workspace_file', 'multi_edit_workspace_file'] : []),
          ...(values['structured-patch'] ? ['apply_workspace_patch'] : []),
          ...(values['workspace-rewind'] ? ['list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files'] : []),
          'TodoRead', 'TodoWrite', 'RespondToCoordinator', 'ArtifactRead', 'ArtifactSearch', 'ArtifactList']);
      assert.match(body.messages[0].content, /CHILD_WORKSPACE_READER/);
      const results = body.messages.filter(message => message.role === 'tool');
      if (values['child-controls'] && childStep > 0 && turn === 1) assert.match(JSON.stringify(body.messages), /SDK child guidance/);
      if (values['guidance-fifo'] && turn === 1 && childStep > 0) {
        if (childStep === 1) assert.doesNotMatch(JSON.stringify(body.messages), /SDK second guidance/);
        else {
          assert.match(JSON.stringify(body.messages), /SDK second guidance/);
          assert.match(JSON.stringify(body.messages), /First guided draft/);
        }
      }
      if (values['task-controls'] && childStep < 2) {
        if (childStep++ === 0) {
          if (turn === 2 && values['continue-child']) assert.match(JSON.stringify(body.messages), /Child checklist 1/);
          call = { name: 'TodoWrite', arguments: { todos: [{ content: `Child checklist ${turn}`, status: 'in_progress', priority: 'high' }] } };
        } else call = { name: 'RespondToCoordinator', arguments: { summary: `Inspecting ${turn}`, message: `SDK child progress ${turn}; continuing work.` } };
      }
      else if (childStep++ === (values['task-controls'] ? 2 : 0)) {
        if (values['continue-child'] && turn === 2) {
          assert.ok(results.length, 'follow-up must carry the original child protocol history');
          assert.match(JSON.stringify(body.messages), /Child evidence 1/);
        }
        if (values['child-controls']) {
          const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
          const identity = { agentId, sessionId: 'native-child-parent' };
          const current = await control('sessions/native-child-history', identity), task = current.tasks[0], send = turn === 1;
          assert.equal(task.canSendInput, true); assert.equal(task.canCancel, true);
          const command = { ...identity, runId: current.runId, childRunId: task.childRunId, commandId: `sdk-child-${send ? 'send' : 'cancel'}`,
            ...(send ? { text: 'SDK child guidance: verify the original file.', expectedGoalRevision: task.goalRevision } : {}) };
          const method = `sessions/native-child-${send ? 'send' : 'cancel'}`;
          assert.equal((await control(method, command)).status, 'accepted'); assert.equal((await control(method, command)).status, 'duplicate');
          if (send && values['guidance-fifo']) {
            const next = { ...command, commandId: 'sdk-child-send-second', text: 'SDK second guidance: state the original observation scope.' };
            assert.equal((await control(method, next)).status, 'accepted'); assert.equal((await control(method, next)).status, 'duplicate');
          }
          if (!send) {
            let canceled = false;
            for (let index = 0; index < 400; index++) {
              const history = await control('sessions/native-child-history', identity);
              if (history.tasks[0].phase === 'canceled') { canceled = true; break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(canceled, true, 'the original child must cancel before its model response can dispatch a tool');
          }
        }
        if (values.promote && turn === 1) {
          const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
          const state = await control('sessions/native-child-tasks', { agentId, sessionId: 'native-child-parent' });
          if (values.history) {
            const live = await control('sessions/native-child-history', { agentId, sessionId: 'native-child-parent' });
            assert.equal(live.tasks.length, 1); assert.equal(live.tasks[0].childRunId, state.tasks[0].childRunId);
            assert.equal(live.tasks[0].canPromote, true); assert.equal(live.tasks[0].resultAvailable, false);
            assert.equal(live.tasks[0].usageIncludedInParent, false);
            const pending = await control('sessions/native-child-result', { agentId, sessionId: 'native-child-parent', childRunId: state.tasks[0].childRunId });
            assert.equal(pending.text, ''); assert.equal(pending.task.resultAvailable, false);
          }
          assert.equal(state.tasks.length, 1); assert.equal(state.tasks[0].canPromote, true); assert.equal(state.tasks[0].delivery, 'foreground');
          promotion = { agentId, sessionId: 'native-child-parent', runId: state.runId, childRunId: state.tasks[0].childRunId,
            commandId: 'actual-sdk-promote' };
          assert.equal((await control('sessions/native-child-promote', promotion)).status, 'accepted');
          assert.equal((await control('sessions/native-child-promote', promotion)).status, 'duplicate');
          await parentContinued;
        }
        call = { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
        if (values['command-workspace']) call = { name: 'run_command', arguments: { command: turn === 1
          ? "printf 'Child-owned command bytes\\n' > child-command.txt; /bin/cat proof.txt; pwd"
          : '/bin/cat child-command.txt; pwd' } };
        if (values['structured-patch']) call = { name: 'apply_workspace_patch', arguments: { patch_text: ['*** Begin Patch',
          '*** Update File: proof.txt', '@@', `-${turn === 1 ? 'Evidence from the actual child workspace' : 'Child patched 1'}`, `+Child patched ${turn}`,
          ...(turn === 1 ? ['*** Add File: move-source.txt', '+move old', '*** Add File: obsolete.txt', '+obsolete']
            : ['*** Update File: move-source.txt', '*** Move to: moved.txt', '@@', '-move old', '+move new', '*** Delete File: obsolete.txt']),
          '*** End Patch'].join('\n') } };
        if (values['child-plan']) {
          calls = [{ name: 'write_workspace_file', arguments: { path: 'plan-child.txt', content: `Child implementation ${turn}` } }, call];
          call = undefined;
        }
      }
      else if (values['structured-patch'] && childStep === 2) {
        assert.match(results.at(-1).content, /"ok":true/); assert.match(results.at(-1).content, /"files"/);
        if (values['workspace-rewind']) {
          const id = results.at(-1).content.match(/"checkpoint_id":"([0-9a-f-]{36})"/)?.[1]; assert.ok(id);
          if (turn === 1) firstCheckpoint = id;
        }
        call = values['workspace-rewind'] && turn === 2
          ? { name: 'preview_workspace_rewind', arguments: { checkpoint_id: firstCheckpoint } }
          : { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
        if (values['workspace-rewind'] && turn === 2) {
          calls = [call, { name: 'read_workspace_file', arguments: { path: 'proof.txt' } }]; call = undefined;
        }
      }
      else if (values['workspace-rewind'] && turn === 2 && childStep === 3) {
        const preview = results.findLast(message => message.content.includes('"preview_token"'));
        assert.match(preview.content, /"can_apply":true/); assert.match(results.at(-1).content, /Child patched 2/);
        const token = preview.content.match(/"preview_token":"([0-9a-f]{64})"/)?.[1]; assert.ok(token);
        call = { name: 'rewind_workspace_files', arguments: { checkpoint_id: firstCheckpoint, preview_token: token } };
      }
      else if (values['edit-matching'] && childStep === 2) {
        assert.match(results.at(-1).content, turn === 1 ? /Evidence from the actual child workspace/ : /Child edited 1/);
        call = turn === 1 ? { name: 'edit_workspace_file', arguments: { path: 'proof.txt',
          old_text: '1: Evidence from the actual child workspace', new_text: 'Child edited 1' } }
          : { name: 'multi_edit_workspace_file', arguments: { path: 'proof.txt', edits: [{ old_text: '\\u0043hild edited 1', new_text: 'Child edited 2' }] } };
      }
      else { if (values['edit-matching']) assert.match(results.at(-1).content, turn === 1 ? /line_number_prefix_stripped/ : /unicode_escape_normalized/);
        else if (values['structured-patch']) assert.match(results.at(-1).content, values['workspace-rewind'] && turn === 2
          ? /"rewound_checkpoint_ids"/ : new RegExp(`Child patched ${turn}`));
        else if (values['command-workspace']) {
          const command = JSON.parse(results.at(-1).content);
          assert.equal(command.exit_code, 0);
          assert.match(command.stdout, turn === 1 ? /Evidence from the actual child workspace/ : /Child-owned command bytes/);
          assert.match(command.stdout, /child-workspaces\/.+\/work/);
        } else assert.match(results.at(-1).content, /Evidence from the actual child workspace/);
        if (values['child-plan']) {
          const writeCall = body.messages.flatMap(message => message.tool_calls ?? []).findLast(item => item.function.name === 'write_workspace_file');
          const written = results.findLast(message => message.tool_call_id === writeCall?.id);
          assert.ok(written, 'child receives its own write outcome');
          if (turn === 1) assert.match(written.content, /plan_mode_write_denied/);
          else { assert.doesNotMatch(written.content, /plan_mode_write_denied/); assert.match(written.content, /"ok":true/); }
        }
        text = values['guidance-fifo'] && turn === 1 && childStep === 2 ? 'First guided draft' : turn === 2 ? '{"count":2}' : `Child evidence ${turn}`; }
    } else {
      assert.ok(body.tools.some(tool => tool.function.name === 'native_start_child'));
      const step = parentStep++;
      if (step === 0) call = { name: turn === 1 || values['continue-child'] ? 'native_delegate' : 'native_start_child', arguments: { role: 'reader', task: `${editedChild ? 'Read and edit' : 'Read'} proof.txt for turn ${turn}`,
        ...(turn === 2 ? { output_format: 'json_object', output_contract: 'parent',
          ...(values['continue-child'] ? { continuation_of: firstChildId, background: true } : {}) } : {}) } };
      else if (step === 1) {
        if (turn === 1) { firstChildId = latestChild(body); assert.ok(firstChildId); }
        if (turn === 1 && values.promote) {
          assert.ok(promotion);
          const state = await control('sessions/native-child-tasks', { agentId: promotion.agentId, sessionId: promotion.sessionId, runId: promotion.runId });
          assert.equal(state.tasks[0].childRunId, promotion.childRunId); assert.equal(state.tasks[0].delivery, 'background');
          assert.equal(state.tasks[0].canPromote, false);
          assert.equal(requests.filter(item => item.model === 'child-proof').length, 1);
          assert.match(body.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '', /started/);
          releaseChild();
        } else if (turn === 1) assert.match(body.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '', /Child evidence 1/);
        call = { name: 'native_child_control', arguments: { child_run_id: latestChild(body), action: 'wait', wait_seconds: 1 } };
      }
      else if (step === 2) calls = [
        { name: 'native_child_result', arguments: { child_run_id: latestChild(body) } },
        { name: 'native_child_tasks', arguments: {} },
      ];
      else {
        assert.match(JSON.stringify(body.messages), /native.child-result\/v1/);
        assert.match(JSON.stringify(body.messages), /native.child-tasks\/v2/);
        text = turn === 2 ? '{"count":2}' : `Parent completed ${turn}`;
      }
    }
    if (text && (body.tools ?? []).some(tool => tool.function.name === 'submit_final_output')) {
      const schema = body.tools.find(tool => tool.function.name === 'submit_final_output').function.parameters;
      const answer = schema.properties?.answer;
      call = { name: 'submit_final_output', arguments: answer ? {
        answer: answer.type === 'object' ? answer.properties?.output ? { output: JSON.parse(text) } : JSON.parse(text) : text,
        artifacts: [] } : { output: JSON.parse(text) } }; text = undefined;
    }
    const toolCalls = (calls ?? (call ? [call] : [])).map(item => {
      const definition = body.tools?.find(tool => tool.function.name === item.name)?.function.parameters;
      return ['native_start_child', 'native_delegate'].includes(item.name) && definition?.properties?.required_tools
        ? { ...item, arguments: { required_tools: [], ...item.arguments } } : item;
    });
    const delta = toolCalls.length ? { tool_calls: toolCalls.map((item, index) => ({ index, id: `tool-${requests.length}-${index}`, type: 'function',
      function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) } : { content: text };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: `r-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
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
    ...(values['conversation-rewind'] ? ['    - id: child-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
      '    - id: child-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
      '    - id: child-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'"] : []),
    '    - id: child-proof-presets', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:', '        default: standard',
    '    - id: child-proof-fixture', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-children.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, `        modelUrl: ${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}`,
    ...(values['task-controls'] ? ['        taskControls: true'] : []), '',
    ...(values['conversation-rewind'] ? ['        conversationRewindProof: true'] : []),
    ...(values['child-plan'] ? ['        childPlanMode: true'] : []),
    ...(values['edit-matching'] ? ['        editMatching: true'] : []),
    ...(values['structured-patch'] ? ['        structuredPatch: true'] : []),
    ...(values['workspace-rewind'] ? ['        workspaceRewind: true'] : []),
    ...(values['command-workspace'] ? ['        commandWorkspace: true'] : []),
  ].join('\n'));
  const { DeepSeekHarness } = await import(pathToFileURL(join(source, 'packages/sdk/client/lib/index.js')).href);
  const options = { dshBin: join(source, 'apps/cli/lib/bin.js'), profile: 'sdk',
    patches: [join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch], dshHome: join(root, 'home'),
    cwd: root, processCwd: root, provider: 'agentkit-studio-parent-profile', model: 'parent-proof', initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
    env: { ...process.env, PATH: nodeBin, DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'),
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' } };
  harness = new DeepSeekHarness(options);
  if (conversationRewindProof) {
    await conversationRewindProof.run({ harness, DeepSeekHarness, options, root, installed, control, failures, requests });
    harness = null;
  } else {
  let session = harness.session('native-child-parent');
  for (turn = 1; turn <= 2; turn++) {
    parentStep = 0; childStep = 0;
    const result = await session.run(turn === 2 ? '读取 proof.txt。最后只返回 JSON 对象，格式为 {"count":整数}。' : `Use a bounded reader for proof ${turn}.`);
    assert.deepEqual(failures, []);
    assert.equal(result.finalResponse, turn === 2 ? '{"count":2}' : `Parent completed ${turn}`, JSON.stringify(result.events.filter(event => event.type === 'turn/end')));
    const tools = result.events.filter(event => event.type === 'tool/call');
    const expectedTools = [turn === 1 || values['continue-child'] ? 'native_delegate' : 'native_start_child', 'native_child_control', 'native_child_result', 'native_child_tasks',
      ...(turn === 2 ? ['submit_final_output'] : [])];
    if (values['command-workspace']) {
      assert.deepEqual(tools.map(event => event.data.name).filter(name => name !== 'submit_final_output'), expectedTools.filter(name => name !== 'submit_final_output'));
      assert.equal(result.events.filter(event => event.type === 'tool/result').length, tools.length);
    } else {
      assert.deepEqual(tools.map(event => event.data.name), expectedTools);
      assert.equal(result.events.filter(event => event.type === 'tool/result').length, expectedTools.length);
    }
    if (values.history) {
      const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
      const identity = { agentId, sessionId: 'native-child-parent' };
      const history = await control('sessions/native-child-history', { ...identity, limit: 1 });
      assert.equal(history.contract, 'agentkit.studio-native-child-history/v1'); assert.equal(history.totalTasks, turn);
      assert.equal(history.tasks[0].parentRunId, history.runId); assert.equal(history.tasks[0].resultAvailable, true);
      assert.equal(history.tasks[0].usageIncludedInParent, true); assert.equal(history.tasks[0].canPromote, false);
      const saved = await control('sessions/native-child-result', { ...identity, childRunId: firstChildId, offset: 2, limit: 5 });
      assert.equal(saved.text, [...'Child evidence 1'].slice(2, 7).join('')); assert.equal(saved.parentAcceptance, 'not_evaluated');
      if (!history.complete) {
        const next = await control('sessions/native-child-history', { ...identity, offset: history.nextOffset, inventoryDigest: history.inventoryDigest, limit: 1 });
        assert.equal(next.complete, true); assert.equal(next.tasks[0].childRunId, firstChildId);
        assert.notEqual(next.tasks[0].parentRunId, history.runId);
      }
    }
    if (turn === 1) {
      await harness.close(); harness = new DeepSeekHarness(options); session = await harness.resumeSession('native-child-parent');
      if (values.history) {
        const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
        const restored = await control('sessions/native-child-history', { agentId, sessionId: 'native-child-parent' });
        assert.equal(restored.tasks.length, 1); assert.equal(restored.tasks[0].childRunId, firstChildId);
        assert.equal(restored.tasks[0].resultAvailable, true); assert.equal(restored.tasks[0].canPromote, false);
      }
    }
  }
  await harness.close(); harness = null;
  assert.deepEqual(failures, []); assert.equal(requests.filter(body => body.model === 'child-proof').length,
    values['workspace-rewind'] ? 7 : values['task-controls'] ? 8 : editedChild ? 6 : values['child-controls'] ? values['guidance-fifo'] ? 4 : 3 : 4);
  const { agentId } = JSON.parse(await readFile(join(root, 'identity.json'), 'utf8'));
  const catalogAuthoring = values['structured-patch']
    ? JSON.parse(await readFile(join(root, 'native-catalog-authoring-proof.json'), 'utf8')) : null;
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const { readNativeRecoveryBinding } = await import(pathToFileURL(join(installed, 'src/providers/native-recovery-binding.mjs')).href);
  const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(join(root, 'workspace'))).digest('hex'), userId: 'local-user', agentId };
  try {
    const parents = store.list(scope, 'native-child-parent'); assert.equal(parents.length, 2);
    const childIds = new Set();
    for (const parent of parents) {
      const record = store.load(scope, parent.runId);
      const recovery = readNativeRecoveryBinding(record, { agentId, sessionId: 'native-child-parent', runId: parent.runId });
      assert.equal(recovery.agentRevision, 1); assert.equal(recovery.buildId, catalogAuthoring?.buildId ?? null);
      assert.deepEqual(recovery.source, { provider: 'agentkit-studio-parent-profile', model: 'parent-proof' });
      assert.ok(recovery.messages.some(message => message.content.some(part => part.type === 'text'
        && (parent.turnId === '1' ? part.text.includes('Use a bounded reader for proof 1') : part.text.includes('读取 proof.txt')))));
      assert.equal(typeof recovery.systemPrompt, 'string'); assert.ok(recovery.systemPrompt.length > 0);
      assert.equal(JSON.stringify(recovery).includes('child-proof-secret'), false);
      const canceled = values['child-controls'] && !parent.childRunIds.includes(firstChildId);
      assert.equal(parent.phase, 'completed'); assert.equal(parent.childBudgetReservations.length, 1);
      assert.equal(parent.descendantUsage.modelCalls, values['workspace-rewind'] && parent.turnId !== '1' ? 4 : canceled ? 1 : values['task-controls'] ? 4 : values['guidance-fifo'] || editedChild ? 3 : 2);
      assert.equal(parent.descendantUsage.toolCalls, values['workspace-rewind'] && parent.turnId !== '1' ? 4 : canceled ? 0 : values['child-plan'] ? 4 : values['task-controls'] ? 3 : editedChild ? 2 : 1);
      const reservation = parent.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
      if (reservation.deliveryMode === 'foreground') {
        assert.equal(parent.messages.filter(message => message.kind === 'background_child_observation').length, 0);
      }
      childIds.add(reservation.childRunId);
      const child = store.load(reservation.childScope, reservation.childRunId);
      assert.equal(child.snapshot.phase, canceled ? 'canceled' : 'completed'); assert.equal(child.configuration.profile.profileId, 'child-profile');
      assert.equal(child.configuration.childOwnerBinding.parent.runId, parent.runId);
      if (values['command-workspace']) {
        assert.equal(record.configuration.hostRecoveryBinding.instructionAssemblyPolicy, 'admitted-tool-sections/v1');
        const binding = child.configuration.hostRecoveryBinding.childWorkspace;
        assert.equal(child.configuration.hostRecoveryBinding.childExecutionResource.contract, 'agentkit.child-local-command-resource/v1');
        const workspace = join(root, 'studio/native-harness/child-workspaces', binding.isolationId, 'work');
        assert.equal(child.configuration.modelSurface.environment.commandCwd, workspace);
        assert.equal(await readFile(join(workspace, 'child-command.txt'), 'utf8'), 'Child-owned command bytes\n');
        await assert.rejects(readFile(join(root, 'workspace/child-command.txt')), { code: 'ENOENT' });
        const receipts = child.events.filter(event => event.kind === 'tool.completed' && event.payload.name === 'run_command');
        assert.equal(receipts.length, 1);assert.equal(receipts[0].payload.status, 'ok');
      }
      if (values['structured-patch']) {
        assert.equal(child.configuration.tools.find(tool => tool.name === 'apply_workspace_patch').workspacePatchPolicy, 'zcode-patch/v1');
        if (values['workspace-rewind']) assert.equal(child.configuration.tools.find(tool => tool.name === 'apply_workspace_patch').workspaceCheckpointPolicy, 'file-preimages/v1');
        const patchReceipt = child.receipts.find(row => row.result.results?.[0]?.content?.files?.length === 3);
        assert.ok(patchReceipt); assert.equal(patchReceipt.result.results[0].status, 'ok');
        if (parent.turnId !== '1') {
          const isolated = join(root, 'studio/native-harness/child-workspaces', child.configuration.hostRecoveryBinding.childWorkspace.isolationId, 'work');
          assert.equal(await readFile(join(isolated, 'proof.txt'), 'utf8'), values['workspace-rewind'] ? 'Evidence from the actual child workspace' : 'Child patched 2\n');
          if (values['workspace-rewind']) {
            for (const path of ['moved.txt', 'obsolete.txt', 'move-source.txt']) await assert.rejects(readFile(join(isolated, path)), { code: 'ENOENT' });
            const rewind = child.receipts.find(row => row.result.results?.[0]?.content?.rewound_checkpoint_ids?.length === 2);
            assert.ok(rewind); assert.equal(rewind.result.results[0].status, 'ok');
          } else {
            assert.equal(await readFile(join(isolated, 'moved.txt'), 'utf8'), 'move new\n');
            for (const path of ['obsolete.txt', 'move-source.txt']) await assert.rejects(readFile(join(isolated, path)), { code: 'ENOENT' });
          }
        }
      }
      if (values['edit-matching']) {
        for (const name of ['edit_workspace_file', 'multi_edit_workspace_file'])
          assert.equal(child.configuration.tools.find(tool => tool.name === name).workspaceEditPolicy, 'zcode-match/v1');
        if (parent.turnId !== '1') assert.equal(await readFile(join(root, 'studio/native-harness/child-workspaces',
          child.configuration.hostRecoveryBinding.childWorkspace.isolationId, 'work/proof.txt'), 'utf8'), 'Child edited 2');
      }
      if (values['child-plan']) {
        const active = parent.turnId === '1';
        assert.equal(record.configuration.childPlanPolicy, 'inherit-plan/v1');
        assert.equal(child.configuration.planModePolicy, 'inherited-child-plan/v1');
        assert.equal(child.configuration.childOwnerBinding.planMode, active); assert.equal(child.snapshot.planMode.active, active);
        assert.equal(parent.planMode.active, active);
        const childWorkspace = child.configuration.hostRecoveryBinding.childWorkspace;
        assert.ok(childWorkspace?.isolationId);
        // The first Run never creates a file. The fresh second Run continues the
        // same isolated workspace without publishing changes into the parent.
        if (!active) assert.equal(await readFile(join(root, 'studio/native-harness/child-workspaces', childWorkspace.isolationId, 'work/plan-child.txt'), 'utf8'), 'Child implementation 2');
      }
      if (values['task-controls']) {
        assert.equal(record.configuration.childTaskPolicy, 'session-controls/v1');
        assert.equal(child.configuration.coordinatorResponsePolicy, 'owned-parent-response/v1');
        assert.equal(child.configuration.tools.some(tool => ['EnterPlanMode', 'ExitPlanMode'].includes(tool.name)), false);
        assert.equal(child.events.filter(event => event.kind === 'coordinator.response_queued').length, 1);
        const reports = parent.messages.filter(message => message.kind === 'child_response');
        assert.equal(reports.length, 1); assert.match(reports[0].content, /SDK child progress/);
        assert.equal(JSON.parse(reports[0].content).trust, 'data');
        assert.equal(parent.childResponseCursors[child.snapshot.runId], child.events.find(event => event.kind === 'coordinator.response_queued').seq);
        assert.equal(child.snapshot.todos.items[0].content, `Child checklist ${parent.turnId}`);
        assert.equal(child.snapshot.todos.revision, values['continue-child'] && child.snapshot.runId !== firstChildId ? 2 : 1);
      }
      if (values['continue-child'] && child.snapshot.runId !== firstChildId) {
        const firstParent = parents.find(item => item.childRunIds.includes(firstChildId));
        const original = store.load(reservation.childScope, firstChildId);
        assert.equal(child.snapshot.parentRunId, firstChildId); assert.equal(child.snapshot.sessionId, original.snapshot.sessionId);
        assert.equal(child.configuration.childOwnerBinding.continuationOf, firstChildId);
        assert.equal(child.configuration.childOwnerBinding.continuationParentRunId, firstParent.runId);
        assert.equal(original.snapshot.phase, 'completed'); assert.equal(original.snapshot.usage.modelCalls, values['task-controls'] ? 4 : values['guidance-fifo'] || editedChild ? 3 : 2);
        assert.equal(original.snapshot.usage.toolCalls, values['child-plan'] ? 4 : values['task-controls'] ? 3 : editedChild ? 2 : 1); assert.equal(original.snapshot.finalText, 'Child evidence 1');
        if (values['child-plan']) assert.equal(original.snapshot.planMode.active, true);
        assert.equal(store.sessionHead(reservation.childScope, original.snapshot.sessionId).runId, child.snapshot.runId);
      } else assert.equal(child.snapshot.parentRunId, null);
      assert.equal(child.snapshot.usage.toolCalls, values['workspace-rewind'] && parent.turnId !== '1' ? 4 : canceled ? 0 : values['child-plan'] ? 4 : values['task-controls'] ? 3 : editedChild ? 2 : 1);
      if (values['child-controls']) {
        const commandKind = canceled ? 'cancel' : 'guide';
        const count = !canceled && values['guidance-fifo'] ? 2 : 1;
        assert.equal(child.commands.filter(row => row.command.kind === commandKind).length, count);
        assert.equal(store.events(scope, parent.runId).filter(event => event.kind === (canceled ? 'child.cancel_requested' : 'child.input_queued')).length, count);
        if (!canceled && values['guidance-fifo']) {
          assert.equal(child.configuration.guidancePolicy, 'boundary-guide/v1');
          assert.deepEqual(child.snapshot.pendingGuidanceIds, []);
          const events = store.events(reservation.childScope, child.snapshot.runId);
          const applied = events.filter(event => event.kind === 'input.guidance_applied');
          const consumed = events.filter(event => event.kind === 'input.guidance_consumed');
          assert.equal(applied.length, 2); assert.equal(consumed.length, 2);
          assert.deepEqual(applied.map(event => event.payload.inputId), consumed.map(event => event.payload.inputId));
          assert.ok(consumed[0].seq < applied[1].seq);
          assert.notEqual(consumed[0].payload.operationKey, consumed[1].payload.operationKey);
        }
      }
      const parentConfiguration = store.load(scope, parent.runId).configuration;
      if (parentConfiguration.contract.finalSubmissionSchema) {
        assert.deepEqual(child.configuration.contract.finalSubmissionSchema.properties.output,
          parentConfiguration.contract.finalSubmissionSchema.properties.output);
        assert.notEqual(child.configuration.contract.objective, parentConfiguration.contract.objective);
        assert.equal(child.snapshot.finalText, canceled ? '' : '{"count":2}');
      }
      assert.equal(store.events(scope, parent.runId).filter(event => event.kind === (canceled ? 'usage.unavailable' : 'usage.reported') && event.payload.source === 'descendant_runs').length, 1);
    }
    assert.equal(childIds.size, 2);
    assert.equal(parents.filter(parent => parent.childBudgetReservations[0].deliveryMode === 'foreground').length, 1);
    if (values.promote) {
      assert.ok(parents.some(parent => parent.promotedChildRunIds?.includes(promotion.childRunId)));
      assert.equal(parents.flatMap(parent => store.events(scope, parent.runId)).filter(event => event.kind === 'child.promoted').length, 1);
    }
    assert.equal(JSON.stringify(parents).includes('child-proof-secret'), false);
  } finally { store.close(); }
  if (values['child-plan']) await assert.rejects(readFile(join(root, 'workspace/plan-child.txt')), { code: 'ENOENT' });
  if (values['edit-matching']) {
    assert.equal(await readFile(join(root, 'workspace/proof.txt'), 'utf8'), 'Evidence from the actual child workspace');
    const hosts = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(hosts.map(host => host.pid)).size, 2);
    await writeFile(join(root, 'edit-matching-proof.json'), JSON.stringify({ contract: 'agentkit.native-edit-matching-proof/v1', hostProcesses: hosts,
      parentModelRequests: requests.filter(body => body.model === 'parent-proof').length,
      childModelRequests: requests.filter(body => body.model === 'child-proof').length,
      strategies: ['line_number_prefix_stripped', 'unicode_escape_normalized'], actualReads: 2, actualEdits: 2,
      continuedChildSession: true, parentWorkspaceUnchanged: true, noPython: true }, null, 2));
  }
  if (values['structured-patch']) {
    assert.equal(await readFile(join(root, 'workspace/proof.txt'), 'utf8'), 'Evidence from the actual child workspace');
    for (const path of ['move-source.txt', 'moved.txt', 'obsolete.txt']) await assert.rejects(readFile(join(root, 'workspace', path)), { code: 'ENOENT' });
    const hosts = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(new Set(hosts.map(host => host.pid)).size, 2);
    const authoring = catalogAuthoring;
    assert.equal(authoring.authenticatedCatalog, true); assert.equal(authoring.authenticatedCreate, true); assert.equal(authoring.authenticatedBuild, true);
    assert.equal(authoring.tool.resourceId, 'apply_workspace_patch'); assert.equal(authoring.tool.source, 'studio-native');
    assert.match(authoring.buildId, /^build_/);
    await writeFile(join(root, 'structured-patch-proof.json'), JSON.stringify({ contract: 'agentkit.native-structured-patch-proof/v1', hostProcesses: hosts,
      parentModelRequests: requests.filter(body => body.model === 'parent-proof').length, childModelRequests: requests.filter(body => body.model === 'child-proof').length,
      actualPatchCalls: 2, verifiedFileChanges: 6, actualReads: 2, continuedChildSession: true, parentWorkspaceUnchanged: true, noPython: true,
      ...(values['workspace-rewind'] ? { actualRewindCalls: 1, checkpointsAcrossColdHost: 2, restoredOriginalWorkspace: true } : {}),
      catalogAuthoring: authoring }, null, 2));
  }
  if (values['task-controls']) {
    const hosts = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(hosts.map(host => host.pid)).size, 2);
    await writeFile(join(root, 'task-controls-proof.json'), JSON.stringify({ contract: 'agentkit.native-child-task-proof/v1',
      hostProcesses: hosts, parentModelRequests: requests.filter(body => body.model === 'parent-proof').length,
      childModelRequests: requests.filter(body => body.model === 'child-proof').length,
      parentTurns: 2, queuedResponses: 2, deliveredResponses: 2, actualWorkspaceReads: 2,
      continuedChildSession: Boolean(values['continue-child']), noPython: true,
      ...(values['child-plan'] ? { childPlanModes: [true, false], originalRunModePreserved: true, deniedPlanWrites: 1,
        actualIsolatedWrites: 1, parentWorkspaceUnchanged: true } : {}) }, null, 2));
  }
  if (values['command-workspace']) {
    const hosts = (await readFile(join(root, 'host-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(hosts.map(host => host.pid)).size, 2);
    const instructionSources = (await readFile(join(root, 'host-instruction-sources.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(instructionSources.some(row => row.sections.includes('tool:read') && row.sections.includes('tool:jobs')),
      'the real global Host assembly still contains unavailable DSH guidance before Native source selection');
    await writeFile(join(root, 'command-workspace-proof.json'), JSON.stringify({ contract: 'agentkit.native-child-command-proof/v1',
      hostProcesses: hosts, parentTurns: 2, childModelRequests: requests.filter(body => body.model === 'child-proof').length,
      actualCommandCalls: 2, continuedChildSession: true, committedCommandsReplayed: 0, parentWorkspaceUnchanged: true,
      noPython: true, instructionAssemblyPolicy: 'admitted-tool-sections/v1', instructionSourceRows: instructionSources.length,
      inactiveGlobalToolGuidanceExcludedFromModel: true, archive: resolve(values.archive) }, null, 2));
  }
  const controlsProof = values['child-controls'] ? `authenticated same-ID guidance and child cancellation, no tool after cancellation, ${values['guidance-fifo'] ? 'two FIFO guidance commands consumed by distinct model receipts' : 'one original child inbox command'}, ` : '';
  console.log(`Studio Native children PASS: actual packed mountStudioHost, authenticated preset admission, ${values.promote ? 'authenticated foreground promotion before parent continuation, original child and budget preserved' : 'foreground native_delegate result before the next parent model'}, ${values['continue-child'] ? 'same child Session continued with a fresh Run and budget after Host restart, original history preserved' : 'background child after Host restart'}, ${values.history ? 'authenticated read-only live and historical inventory, sealed result pages and history after restart, ' : ''}${controlsProof}${values['command-workspace'] ? 'child-scoped commands across two Host PIDs without parent file changes or committed-command replay, ' : ''}${values['task-controls'] ? 'child-local Todo continuity and exactly-once coordinator reports across two Host PIDs, ' : ''}independent approved child model, real scoped workspace reads, explicit parent output constraint with separate child acceptance, one budget settlement per child, two parent turns, Node-only PATH.`);
  }
} finally {
  if (values.keep) await writeFile(join(root, 'http-metadata.json'), JSON.stringify(httpMetadata, null, 2));
  releaseChild();
  await harness?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
