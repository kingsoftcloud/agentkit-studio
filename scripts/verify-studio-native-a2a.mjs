import { createRequire } from 'node:module';
/**
 * Verify Studio Native A2A through the packed production Host, real DSH SDK
 * preset/ToolRegistry/SessionController (full mounted host with authenticated
 * HTTP control RPC and production preset admission), NativeKernel/SQLite, a
 * real local HTTP A2A AgentCard discovery + JSONRPC/SSE peer, and deterministic
 * local model HTTP SSE.
 *
 * Usage:
 *   node scripts/verify-studio-native-a2a.mjs \
 *     --source <built DSH SDK checkout> \
 *     --archive <packed studio .tgz> \
 *     [--keep] [--reconcile-cold [--receipt-crash] | --busy-cancel]
 * For normal/internal/inbound proofs, --installation <completed fresh Host>
 * replaces --source and verifies the archive, dependency lock and Host pins.
 *
 * --reconcile-cold uses the real mounted SessionController and authenticated
 * recovery RPC after SIGKILL, without a new prompt or Send. --receipt-crash
 * additionally kills the replacement while GetTask is pending, then verifies
 * duplicate command confirmation cannot repeat that lost read. These modes
 * use the same controlled HTTP peer/model and existing dependency graph.
 * --busy-cancel verifies cancellation while the original stream remains open,
 * through actual ApprovalService with a deterministic HTTP approval answerer.
 *
 * The mounted Host wires the A2A tool binding for an Agent spec with:
 *   bindings.modelProfileIds = ['fixture']   (text-only primary, modelName 'main')
 *   bindings.tools = ['call_a2a_agent']
 *   bindings.a2a = [{ local_name, binding_id, space_id, target_agent_id,
 *     expected_version_id, exposure: 'tool' }]
 *   runtime.type = 'harness'
 *
 * The model emits a call_a2a_agent tool call. The Native A2A host discovers
 * the remote agent via the local HTTP ListAToASpaceAgents peer, sends a real
 * JSONRPC SendStreamingMessage, receives a Task with a text artifact and completed status, selects the
 * terminal reply, and the model completes.
 *
 * Verifies (exact, not >=):
 *   - Exactly 1 completed Run in SQLite
 *   - Exactly 2 model HTTP calls (tool-call + completion)
 *   - Exactly 1 discovery HTTP call (ListAToASpaceAgents)
 *   - Exactly 1 A2A peer Send (SendStreamingMessage), no GetTask for this stream
 *   - The tool result reply is the remote artifact text
 *   - Cold-before count snapshot saved, then a REAL Host/SDK process restart
 *     (close DSH subprocess, spawn fresh with same config, resumeSession via
 *     real SessionController/SDK history read — no new prompt). Model/tool/
 *     A2A-peer/discovery counts must NOT increase (real comparison).
 *   - Entire store.load record canonical unchanged after the real restart
 *   - PIDs recorded for both the original and restarted Host processes
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { readNativeDshOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-ownership';
import { verifyMountedA2aRecovery } from './verify-studio-native-a2a-recovery.mjs';
import { verifyMountedA2aBusyCancel } from './verify-studio-native-a2a-busy-cancel.mjs';
import { verifyMountedChildA2aRecovery } from './verify-studio-native-child-a2a-recovery.mjs';
import { createMountedInboundProof } from './verify-studio-native-a2a-inbound.mjs';
import { createMountedNativeKernelProof } from './verify-studio-native-kernel.mjs';
import { readNodeHostInstallation } from './node-host-packages.mjs';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    installation: { type: 'string' },
    archive: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'reconcile-cold': { type: 'boolean', default: false },
    'receipt-crash': { type: 'boolean', default: false },
    'terminal-close-crash': { type: 'boolean', default: false },
    'busy-cancel': { type: 'boolean', default: false },
    'child-question-cold': { type: 'boolean', default: false },
    'child-question-approval': { type: 'boolean', default: false },
    'child-answer-crash': { type: 'boolean', default: false },
    'internal-control-plane': { type: 'boolean', default: false },
    'public-tool-activity': { type: 'boolean', default: false },
    'inbound-protocol': { type: 'boolean', default: false },
    'inbound-execution': { type: 'boolean', default: false },
    'inbound-formal-binding': { type: 'boolean', default: false },
    'inbound-structured-input': { type: 'boolean', default: false },
    'inbound-crash-boundary': { type: 'string' },
  },
});

assert.ok(Boolean(values.source) !== Boolean(values.installation),
  'Use --source <built DSH SDK checkout> OR --installation <verified fresh Host project>');
assert.ok(!values.installation || !values['reconcile-cold'] && !values['busy-cancel'] && !values['child-question-cold'],
  'Fresh installation currently proves ordinary/internal/inbound execution and managed SIGKILL; other recovery verifiers require --source');
assert.ok(values.archive, 'Use --archive <packed studio .tgz>');
assert.ok(!values['receipt-crash'] || values['reconcile-cold'], '--receipt-crash requires --reconcile-cold');
assert.ok(!values['terminal-close-crash'] || values['reconcile-cold'], '--terminal-close-crash requires --reconcile-cold');
assert.ok(!values['busy-cancel'] || !values['reconcile-cold'], '--busy-cancel and --reconcile-cold are separate scenarios');
assert.ok(!values['internal-control-plane'] || !values['busy-cancel'] && !values['reconcile-cold'], 'internal mode currently proves the normal mounted turn/history scenario');
assert.ok(!values['public-tool-activity'] || values['internal-control-plane'], 'public tool activity requires the internal canonical path');
assert.ok(!values['inbound-protocol'] || values['internal-control-plane'], 'inbound protocol proof requires the internal mounted regression');
assert.ok(!values['inbound-formal-binding'] || values['inbound-execution'], 'formal binding requires the actual inbound execution proof');
assert.ok(!values['inbound-structured-input'] || values['inbound-formal-binding'], 'structured input requires the formal Studio binding');
assert.ok(!values['inbound-crash-boundary'] || values['inbound-formal-binding'] && !values['inbound-structured-input']
  && ['before-owner', 'after-owner-flush', 'after-input-flush', 'after-tool-effect', 'before-turn-end', 'after-terminal-flush']
    .includes(values['inbound-crash-boundary']), 'managed crash proof requires formal binding and a known crash boundary');
assert.ok(!values['child-question-cold'] || !values['busy-cancel'] && !values['reconcile-cold'] && !values['internal-control-plane'], 'child question recovery is a separate mounted scenario');
assert.ok(!values['child-question-approval'] || values['child-question-cold'], 'child remote approval requires --child-question-cold');
assert.ok(!values['child-answer-crash'] || values['child-question-cold'], 'child answer crash requires --child-question-cold');

const managedMode = values['internal-control-plane'] || values['child-question-cold'];

const source = values.source ? resolve(values.source) : null;
const archive = resolve(values.archive);
const repository = fileURLToPath(new URL('..', import.meta.url));

const archiveBuf = await readFile(archive);
const archiveSha = createHash('sha256').update(archiveBuf).digest('hex');
const fresh = values.installation ? await readNodeHostInstallation(values.installation, { archive, studio: repository }) : null;
console.log(`Archive: ${archive}`);
console.log(`Archive SHA256: ${archiveSha}`);

// Resolve the temp root through symlinks: the A2A host's privateDirectory
// checks noSymlinks on every path component (resolve() is lexical), so the
// macOS /var → private/var symlink in /var/folders would trigger
// background_state_symlink. realpath resolves it to /private/var/folders/...
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-native-a2a-')));
console.log(`A2A proof root: ${root}`);
assert.ok(!values['inbound-execution'] || values['inbound-protocol'], '--inbound-execution requires --inbound-protocol');
const inboundProof = values['inbound-execution'] ? createMountedNativeKernelProof(root, {
  formalBinding: values['inbound-formal-binding'], structuredInput: values['inbound-structured-input'],
  crashBoundary: values['inbound-crash-boundary'] })
  : values['inbound-protocol'] ? createMountedInboundProof(root) : null;
const inboundProofPath = await inboundProof?.prepare();

// A2A binding spec — the pinned remote target.
const a2aSpec = {
  local_name: 'research',
  binding_id: 'a2a-binding-0000000000000000000000000001',
  space_id: 'a2a-space-00000000000040008000000000000001',
  target_agent_id: 'a2a-agent-00000000000040008000000000000002',
  expected_version_id: 'a2a-version-00000000000040008000000000000003',
  exposure: 'tool',
  ...(values['child-question-cold'] ? { timeout_seconds: 240 } : {}),
};

const a2aReply = 'The remote agent found 3 relevant documents.';
const remoteTaskId = 'remote-task-a2a-proof-001';
const remoteContextId = 'remote-context-a2a-proof-001';
const publicToolArtifact = completed => ({ artifactId: 'remote-public-tool',
  metadata: { extension_uri: 'urn:ksadk:a2a:tool-activity:v1' }, parts: [{ data: {
    event_id: completed ? 'remote-completed' : 'remote-started', item_id: 'remote-public-item', call_id: 'remote-public-call',
    item_kind: 'tool_call', operation: completed ? 'completed' : 'started', execution_status: completed ? 'completed' : 'running',
    name: 'remote_search', arguments: { query: 'documents', apiKey: '[REDACTED]' },
  } }] });
const platformTaskId = 'a2a-task-00000000000040008000000000000004';
const internalActions = [];
const internalEventBatches = [], acceptedInternalEvents = new Map();
const workloadTokens = Object.fromEntries(['a2a-registry', 'a2a-task-sink', 'a2a-gateway'].map(aud => [aud,
  'e30.' + Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.c2ln']));

// Track all HTTP calls for exact counting.
let modelCalls = 0, discoveryCalls = 0, a2aSends = 0, a2aGets = 0, a2aCancels = 0;
const modelRequests = [], a2aPeerRequests = [], discoveryRequests = [], serverFailures = [];
const recoveryPeer = { complete: false, holdNextGet: false, cancelled: false, finishStream: null };
const childPeer = { questions: [], approvals: [], releaseAnswers: false, releaseApprovals: !values['child-answer-crash'],
  remoteApproval: values['child-question-approval'], answerCrash: values['child-answer-crash'],
  answer: values['child-question-approval'] ? 'approve' : 'Shanghai' };
const questionAnswer = id => ({ id, ...(childPeer.remoteApproval ? { selected: ['批准远端操作'] } : { selected: [], custom: childPeer.answer }) });
const pausedQuestion = { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'mounted-child-question', role: 'ROLE_AGENT',
  parts: [{ text: childPeer.remoteApproval ? 'Approve the remote research operation?' : 'Which city should the child research?' }],
  metadata: { input_schema: { type: 'string', ...(childPeer.remoteApproval ? { enum: ['approve', 'reject'] } : {}) },
    ...(childPeer.remoteApproval ? { ksadk_interaction: { version: 1, kind: 'approval', allowed_decisions: ['approve', 'reject'],
      presentation: { title: 'remote-research', description: '{"arguments":{}}' } } } : {}) } } };
const jsonl = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function managedRecords(root) {
  const base = join(root, 'studio/native-harness/workspace-state');
  const files = (await readdir(base, { recursive: true })).filter(path => path.includes('a2a-calls/') && path.endsWith('.json')).sort();
  return Promise.all(files.map(async path => ({ path, content: await readFile(join(base, path), 'utf8') })));
}
async function history(root, sessionId = 'a2a-session') {
  const base = join(root, 'sessions');
  const logs = (await readdir(base, { recursive: true })).filter(path => path.endsWith('.jsonl'));
  const matching = [];
  for (const path of logs) {
    const events = await jsonl(join(base, path));
    if (events[0]?.type === 'session' && events[0].id === sessionId) matching.push(events);
  }
  assert.equal(matching.length, 1, `expected exactly one durable history for ${sessionId}`);
  return matching[0];
}
let originalPid = null, restartedPid = null;

// Single HTTP server serves three roles by URL path:
//   /v1/chat/completions  → deterministic model SSE
//   /agentengine/api/v1/ListAToASpaceAgents → A2A discovery
//   /rpc  → A2A JSONRPC peer (SendStreamingMessage, GetTask)
const server = createHttpServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (inboundProof && await inboundProof.handle(request, response, body, workloadTokens)) return;
    if (managedMode && request.url.startsWith('/agentengine/internal/v1/a2a/')) {
      const action = request.url.split('/').at(-1); internalActions.push(action);
      const audience = ['BindA2ARemoteTask', 'AppendA2ATaskEvents'].includes(action) ? 'a2a-task-sink' : 'a2a-registry';
      assert.equal(request.headers.authorization, 'Bearer ' + workloadTokens[audience]);
      if (action !== 'ListA2ASpaceAgents') {
        const original = JSON.parse((await managedRecords(root))[0].content); let data = {};
        if (action === 'PrepareA2ACall' || action === 'PrepareA2ATaskOperation') {
          if (!values['child-question-cold'] || action === 'PrepareA2ACall') assert.equal(original.phase, 'sending');
          const method = action === 'PrepareA2ACall' ? 'SendStreamingMessage' : body.Operation === 'send_message' ? 'SendMessage' : 'GetTask';
          assert.ok(Object.values(original.managed.operations).some(value => value.phase === 'preparing' && value.method === method),
            'the exact managed operation intent must precede its grant HTTP');
          if (action === 'PrepareA2ACall') {
            assert.equal(body.MessageId, original.request.message.messageId); assert.equal(body.ExpectedVersionId, a2aSpec.expected_version_id);
          } else { assert.equal(body.A2ATaskId, platformTaskId); assert.ok((values['child-question-cold'] ? ['get_task', 'send_message'] : ['get_task']).includes(body.Operation), 'only the expected managed task operation'); }
          data = { A2ATaskId: platformTaskId, Target: { A2AAgentId: a2aSpec.target_agent_id,
            VersionId: a2aSpec.expected_version_id, CardSha256: 'c'.repeat(64) },
            Route: { Kind: 'hosted_gateway', Interface: { Url: `http://127.0.0.1:${server.address().port}/rpc`,
              ProtocolVersion: '1.0', ProtocolBinding: 'JSONRPC' }, Capabilities: { Streaming: true } },
            CallPermit: 'mounted-private-permit', CallPermitExpiresAt: new Date(Date.now() + 60000).toISOString(),
            ...(action === 'PrepareA2ATaskOperation' ? { RemoteTask: { RemoteTaskId: remoteTaskId, RemoteContextId: remoteContextId } } : {}) };
        } else if (action === 'AppendA2ATaskEvents') {
          assert.equal(body.A2ATaskId, platformTaskId); assert.ok(body.Events.length > 0 && body.Events.length <= 100);
          for (const event of body.Events) {
            assert.equal(event.schema_version, 2); assert.equal(event.source.framework, 'a2a');
            assert.equal(event.event_type.startsWith('run.'), false); assert.equal(event.run_id, original.request.native.runId);
            assert.equal(event.parent_scope_id, original.request.native.runId); assert.equal(event.scope_id, original.request.scopeId);
            assert.ok(original.managed.events.log.some(value => canonical(value) === canonical(event)), 'canonical log precedes append');
            assert.ok(original.managed.events.pending.some(batch => batch.events.some(value => value.event_id === event.event_id)), 'unacknowledged outbox precedes append');
            if (acceptedInternalEvents.has(event.event_id)) assert.equal(acceptedInternalEvents.get(event.event_id), canonical(event));
            acceptedInternalEvents.set(event.event_id, canonical(event));
          }
          internalEventBatches.push(body); data = { AcceptedCount: body.Events.length };
        } else {
          assert.equal(action, 'BindA2ARemoteTask'); assert.equal(original.managed.remote.phase, 'binding');
          assert.equal(body.A2ATaskId, platformTaskId); assert.equal(body.RemoteTaskId, remoteTaskId);
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ Code: 0, Data: data })); return;
      }
    }

    if (values['busy-cancel'] && request.url === '/approval') {
      assert.equal(body.toolName, 'a2a_cancel_task');
      const reason = JSON.parse(body.reason); assert.equal(reason.action, 'cancel');
      assert.equal(reason.remoteTaskId, remoteTaskId); assert.equal(reason.commandId, 'mounted-busy-cancel');
      await writeFile(join(root, 'approval-http.json'), JSON.stringify(body));
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ outcome: 'allowed-once' })); return;
    }

    if (values['child-question-cold'] && request.url === '/question') {
      assert.equal(body.sessionId, 'a2a-session'); assert.equal(body.questions.length, 1);
      childPeer.questions.push({ body, response });
      if (childPeer.releaseAnswers) { response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ answers: [questionAnswer(body.questions[0].id)] })); }
      return;
    }
    if (values['child-question-cold'] && request.url === '/approval') {
      assert.equal(body.toolName, 'a2a_continue_task'); childPeer.approvals.push({ body, response });
      if (childPeer.releaseApprovals) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ outcome: 'allowed-once' })); } return;
    }

    // === Model SSE server ===
    if (request.url === '/v1/chat/completions') {
      modelCalls++;
      modelRequests.push(body);
      console.log(`[model] call ${modelCalls}: ${body.messages.length} messages, tools=${body.tools?.length || 0}`);

      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });

      if (values['child-question-cold']) {
        const own = modelRequests.filter(row => row.model === body.model).length;
        let tool, text;
        if (body.model === 'main' && own === 1) tool = { name: 'native_start_child', arguments: { role: 'researcher',
          task: 'Ask research to find documents about A2A.', background: true, model_call_limit: 3, tool_call_limit: 2 } };
        else if (body.model === 'child' && own === 1) tool = { name: 'call_a2a_agent', arguments: { agent: 'research', message: 'Find documents about A2A' } };
        else { assert.ok(own <= (body.model === 'main' ? 3 : 2), 'no unbounded model retry'); text = a2aReply; }
        const delta = tool ? { tool_calls: [{ index: 0, id: body.model + '-tool', type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text };
        response.write('data: ' + JSON.stringify({ id: `${body.model}-${own}`, model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
        response.end('data: ' + JSON.stringify({ id: `${body.model}-${own}`, model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 8 } }) + '\n\ndata: [DONE]\n\n'); return;
      }

      if (modelCalls === 1) {
        // First call: emit a tool call to call_a2a_agent.
        const toolCallChunk = {
          id: 'model-1', model: 'main',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a2a-call-1', type: 'function',
            function: { name: 'call_a2a_agent',
              arguments: JSON.stringify({ agent: 'research', message: 'Find documents about A2A' }) } }] }, finish_reason: null }],
        };
        response.write('data: ' + JSON.stringify(toolCallChunk) + '\n\n');
        const toolCallEnd = {
          id: 'model-1', model: 'main',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 15, completion_tokens: 8 },
        };
        response.end('data: ' + JSON.stringify(toolCallEnd) + '\n\ndata: [DONE]\n\n');
        return;
      }

      // Second call: model receives the tool result (A2A reply) and completes.
      const toolMsg = body.messages.find(m => m.role === 'tool');
      if (toolMsg) {
        console.log(`[model] tool result (first 200): ${String(toolMsg.content).slice(0, 200)}`);
      }

      const answerChunk = {
        id: 'model-2', model: 'main',
        choices: [{ index: 0, delta: { content: values['busy-cancel'] ? 'Original remote task was cancelled.'
          : 'I called the remote research agent and it reported: ' + a2aReply }, finish_reason: null }],
      };
      response.write('data: ' + JSON.stringify(answerChunk) + '\n\n');
      const answerEnd = {
        id: 'model-2', model: 'main',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 25, completion_tokens: 12 },
      };
      response.end('data: ' + JSON.stringify(answerEnd) + '\n\ndata: [DONE]\n\n');
      return;
    }

    // === A2A discovery ===
    if (request.url === (managedMode ? '/agentengine/internal/v1/a2a/ListA2ASpaceAgents' : '/agentengine/api/v1/ListAToASpaceAgents')) {
      discoveryCalls++;
      discoveryRequests.push(body);
      console.log(`[discovery] call ${discoveryCalls}: space=${body?.A2ASpaceId}`);
      assert.equal(body.A2ASpaceId, a2aSpec.space_id, 'discovery space matches spec');
      assert.equal(body.PageSize, 100, 'discovery page size');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ Code: 0, Data: { Agents: [{
        A2AAgentId: a2aSpec.target_agent_id,
        VersionId: a2aSpec.expected_version_id,
        Source: 'hosted',
        ...(managedMode ? { RouteKind: 'hosted_gateway', Callable: true, CardSha256: 'c'.repeat(64) } : {}),
        AgentCard: {
          name: 'research',
          description: 'Research agent',
          capabilities: { streaming: true },
          supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        },
      }] } }));
      return;
    }

    // === A2A JSONRPC peer ===
    if (request.url === '/rpc') {
      if (managedMode) {
        assert.equal(request.headers.authorization, 'Bearer ' + workloadTokens['a2a-gateway']);
        assert.equal(request.headers['x-agentengine-a2a-permit'], 'mounted-private-permit');
        const original = JSON.parse((await managedRecords(root))[0].content);
        assert.equal(original.platformTaskId, platformTaskId);
        assert.ok(Object.values(original.managed.operations).some(value => value.phase === 'transport'));
      }
      a2aPeerRequests.push({ method: body?.method, params: body?.params, id: body?.id });
      const rpcId = body?.id;
      const wrap = result => ({ jsonrpc: '2.0', id: rpcId, result });

      if (values['child-question-cold'] && body.method === 'SendMessage') {
        a2aSends++; assert.equal(a2aSends, 2, 'only the independently approved continuation');
        assert.equal(childPeer.approvals.length, childPeer.answerCrash ? 2 : 1); assert.equal(body.params.message.taskId, remoteTaskId);
        assert.deepEqual(body.params.message.parts, [{ data: childPeer.answer }]); recoveryPeer.complete = true;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(wrap({ task: { id: remoteTaskId, contextId: remoteContextId,
          status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'result-docs', parts: [{ text: a2aReply }] }] } }))); return;
      }

      if (body.method === 'SendStreamingMessage') {
        a2aSends++;
        console.log(`[a2a-peer] SendStreamingMessage: messageId=${body.params?.message?.messageId}, role=${body.params?.message?.role}`);
        assert.equal(body.params.message.role, 'ROLE_USER', 'A2A message role');
        assert.equal(body.params.message.parts[0].text, 'Find documents about A2A', 'A2A message text');

        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const event = (id, payload) => `id: ${id}\r\ndata: ${JSON.stringify(wrap(payload))}\r\n\r\n`;
        // Stream: WORKING → artifact → COMPLETED
        response.write(event('1', { task: { id: remoteTaskId, contextId: remoteContextId, status: { state: 'TASK_STATE_WORKING' } } }));
        if (values['child-question-cold']) {
          response.end(event('2', { statusUpdate: { taskId: remoteTaskId, contextId: remoteContextId, status: pausedQuestion } })); return;
        }
        if (values['busy-cancel']) {
          recoveryPeer.finishStream = () => { response.end(event('2', { statusUpdate: { taskId: remoteTaskId, contextId: remoteContextId,
            status: { state: 'TASK_STATE_WORKING' } } })); };
          return; // Original stream remains open during the authenticated cancel.
        }
        if (values['reconcile-cold']) {
          response.end(event('2', { statusUpdate: { taskId: remoteTaskId, contextId: remoteContextId,
            status: { state: 'TASK_STATE_INPUT_REQUIRED' } } }));
          return;
        }
        response.write(event('2', { artifactUpdate: { taskId: remoteTaskId, contextId: remoteContextId,
          artifact: { artifactId: 'result-docs', parts: [{ text: a2aReply }] } } }));
        if (values['public-tool-activity']) {
          const payload = { artifactUpdate: { taskId: remoteTaskId, contextId: remoteContextId, artifact: publicToolArtifact(false), lastChunk: true } };
          response.write(event('tool-first', payload));
          response.write(event('tool-duplicate', payload));
        }
        response.write(event('3', { statusUpdate: { taskId: remoteTaskId, contextId: remoteContextId,
          status: { state: 'TASK_STATE_COMPLETED' } } }));
        response.end();
        return;
      }

      if (values['busy-cancel'] && body.method === 'SubscribeToTask') {
        assert.equal(body.params.id, remoteTaskId);
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const working = { task: { id: remoteTaskId, contextId: remoteContextId, status: { state: 'TASK_STATE_WORKING' } } };
        // IDs may restart in another stream. Repeated identical frames in this
        // subscription remain idempotent, and EOF does not mean completion.
        response.write('id: 1\ndata: ' + JSON.stringify(wrap(working)) + '\n\n');
        response.end('id: 1\ndata: ' + JSON.stringify(wrap(working)) + '\n\n'); return;
      }
      if (body.method === 'GetTask') {
        a2aGets++;
        assert.equal(body.params.id, remoteTaskId);
        if (recoveryPeer.holdNextGet) { recoveryPeer.holdNextGet = false; return; }
        console.log(`[a2a-peer] GetTask: id=${body.params?.id}`);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(wrap({
          id: remoteTaskId, contextId: remoteContextId,
          status: { state: values['busy-cancel'] ? recoveryPeer.cancelled ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING'
            : (values['reconcile-cold'] || values['child-question-cold']) && !recoveryPeer.complete ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED',
            ...(values['child-question-cold'] && !recoveryPeer.complete ? { message: pausedQuestion.message } : {}) },
          ...(values['busy-cancel'] || (values['reconcile-cold'] || values['child-question-cold']) && !recoveryPeer.complete ? {} : {
            artifacts: [{ artifactId: 'result-docs', parts: [{ text: a2aReply }] }, ...(values['public-tool-activity'] ? [publicToolArtifact(true)] : [])],
          }),
        })));
        return;
      }
      if (values['busy-cancel'] && body.method === 'CancelTask') {
        a2aCancels++; assert.equal(body.params.id, remoteTaskId); recoveryPeer.cancelled = true;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(wrap({ id: remoteTaskId,
          contextId: remoteContextId, status: { state: 'TASK_STATE_CANCELED' } }))); return;
      }

      throw new Error(`Unexpected JSONRPC method: ${body.method}`);
    }

    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  } catch (error) {
    serverFailures.push(error.message);
    console.error('Server error:', error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end('verification failed');
  }
});

let harness, failed = false;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const modelUrl = `http://127.0.0.1:${serverPort}/v1`;
  const a2aServiceUrl = `http://127.0.0.1:${serverPort}`;
  const tokenDirectory = join(root, 'workload-tokens');
  if (managedMode) {
    await mkdir(tokenDirectory);
    for (const [aud, token] of Object.entries(workloadTokens)) await writeFile(join(tokenDirectory, aud + '.jwt'), token, { mode: 0o400 });
  }
  console.log(`Model server: ${modelUrl}`);
  console.log(`A2A service: ${a2aServiceUrl}`);

  const { DeepSeekHarness } = await import(pathToFileURL(fresh
    ? join(fresh.dependencies, '@deepseek-ai/dsh-sdk-client/lib/index.js') : join(source, 'packages/sdk/client/lib/index.js')).href);
  const graph = join(root, 'host'), installed = join(graph, 'package'), dependencies = join(graph, 'node_modules');
  await mkdir(graph);
  execFileSync('tar', ['-xzf', archive, '-C', graph]);

  // Copy the new fixture into the extracted package.
  await mkdir(join(installed, 'tests/fixtures'), { recursive: true });
  if (fresh || values['child-question-cold'] || values['inbound-crash-boundary']) assert.deepEqual(await readFile(join(installed, 'tests/fixtures/studio-native-a2a.mjs')),
    await readFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs')), 'child verifier uses the actual packed fixture');
  else await copyFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs'),
    join(installed, 'tests/fixtures/studio-native-a2a.mjs'));

  if (fresh) {
    // The only dependency graph is the completed ordinary npm installation.
    // The outer verifier may use this checkout; the actual Host must not.
    await symlink(fresh.dependencies, dependencies);
  } else {
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  // Symlink the SDK's built @deepseek-ai packages.
  const dshDeps = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(dshDeps)) {
    try { await symlink(join(dshDeps, entry), join(dependencies, '@deepseek-ai', entry)); } catch { /* exists */ }
  }
  const missingFromSource = [
    ['packages/client/connection', 'dsh-client-connection'],
    ['packages/api/session-controller', 'dsh-api-session-controller'],
    ['packages/preset/agent-preset-registry', 'dsh-agent-preset-registry'],
  ];
  for (const [rel, pkgName] of missingFromSource) {
    try { await symlink(join(source, rel), join(dependencies, '@deepseek-ai', pkgName)); } catch { /* exists */ }
  }

  // Symlink ordinary Studio dependencies from this checkout's node_modules.
  for (const entry of await readdir(join(repository, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue;
    try { await symlink(join(repository, 'node_modules', entry), join(dependencies, entry)); } catch { /* exists */ }
  }
  }
  await writeFile(join(root, 'dependency-graph.json'), JSON.stringify(fresh?.evidence ?? { kind: 'maintained-source', source }, null, 2));

  // Node-only PATH.
  const nodeOnlyBin = join(root, 'node-only-bin');
  await mkdir(nodeOnlyBin);
  await symlink(process.execPath, join(nodeOnlyBin, 'node'));

  // Profile packages for the mounted host.
  const profilePackages = join(root, 'home/profiles/sdk/node_modules/@kingsoftcloud');
  await mkdir(profilePackages, { recursive: true });
  await symlink(installed, join(profilePackages, 'agentkit-studio'));

  // DSH patch YAML.
  const patch = join(root, 'a2a.patch.yml');
  const fixturePath = pathToFileURL(join(installed, 'tests/fixtures/studio-native-a2a.mjs')).href;
  await writeFile(patch, [
    '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- insert:',
    '    - id: studio-proof-webserver', "      name: '@deepseek-ai/dsh-host-webserver'", '      config:',
    "        host: '127.0.0.1'", '        port: 0',
    '    - id: studio-proof-connection', "      name: '@deepseek-ai/dsh-client-connection'",
    '    - id: studio-proof-model-selection-settings', "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
    ...(values['reconcile-cold'] || values['busy-cancel'] || values['child-question-cold'] || values['inbound-execution'] ? [
      '    - id: studio-proof-workspace', "      name: '@deepseek-ai/dsh-workspace'",
      '    - id: studio-proof-file-upload', "      name: '@deepseek-ai/dsh-client-file-upload'",
      '    - id: studio-proof-session-controller', "      name: '@deepseek-ai/dsh-api-session-controller'",
    ] : []),
    '    - id: studio-proof-preset-registry', "      name: '@deepseek-ai/dsh-agent-preset-registry'", '      config:',
    "        default: standard",
    '    - id: studio-native-a2a-proof', `      name: ${JSON.stringify(fixturePath)}`, '      config:',
    `        directory: ${JSON.stringify(root)}`,
    `        repository: ${JSON.stringify(installed)}`,
    `        modelUrl: ${JSON.stringify(modelUrl)}`,
    `        a2aServiceUrl: ${JSON.stringify(a2aServiceUrl)}`,
    `        a2aServiceToken: ${JSON.stringify('a2a-fixture-token')}`,
    ...(managedMode ? [`        a2aControlPlaneUrl: ${JSON.stringify(a2aServiceUrl)}`,
      `        a2aTokenDirectory: ${JSON.stringify(tokenDirectory)}`] : []),
    `        a2aBindings: ${JSON.stringify(JSON.stringify([a2aSpec]))}`,
    `        mountHost: true`,
    ...(inboundProofPath ? [`        inboundProofPath: ${JSON.stringify(inboundProofPath)}`] : []),
    `        exportControl: ${values['reconcile-cold'] || values['busy-cancel'] || values['child-question-cold'] || values['inbound-execution']}`,
    `        holdTerminalClose: ${values['terminal-close-crash']}`,
    ...(values['busy-cancel'] ? [`        approvalUrl: ${JSON.stringify(`http://127.0.0.1:${serverPort}/approval`)}`] : []),
    ...(values['child-question-cold'] ? ['        childQuestion: true',
      `        approvalUrl: ${JSON.stringify(`http://127.0.0.1:${serverPort}/approval`)}`,
      `        questionUrl: ${JSON.stringify(`http://127.0.0.1:${serverPort}/question`)}`] : []),
    '',
  ].join('\n'));

  const patches = [fresh ? join(fresh.dependencies, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml')
    : join(source, 'packages/bundle/web-app/presets/standard.patch.yml'), patch];
  const options = {
    dshBin: fresh ? join(fresh.dependencies, '@deepseek-ai/dsh/lib/bin.js') : join(source, 'apps/cli/lib/bin.js'),
    profile: 'sdk',
    patches,
    dshHome: join(root, 'home'),
    cwd: root,
    processCwd: root,
    provider: 'agentkit-studio-fixture',
    model: 'main',
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    env: {
      ...process.env,
      PATH: nodeOnlyBin,
      AGENTKIT_PYTHON: '/unavailable/python',
      AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      AGENTKIT_KSADK_PYTHON: '/unavailable/python',
      AGENTKIT_KSADK_ROOT: '/unavailable/ksadk',
      KSADK_PYTHON: '/unavailable/python', KSADK_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_AGENTS_HOME: join(root, 'agents'),
    },
  };

  harness = new DeepSeekHarness(options);
  if (values['inbound-crash-boundary']) {
    await inboundProof.crashProof({ harness, makeHarness: () => new DeepSeekHarness(options), source,
      archiveSha, nodeOnlyBin, serverFailures, dependencyEvidence: fresh?.evidence });
  } else if (values['child-question-cold']) {
    await verifyMountedChildA2aRecovery({ root, installed, repository, source, archiveSha, harness,
      makeHarness: () => new DeepSeekHarness(options), childPeer, requests: { modelRequests, a2aPeerRequests, serverFailures },
      counts: () => ({ model: modelCalls, discovery: discoveryCalls, send: a2aSends, get: a2aGets, cancel: a2aCancels }), a2aReply });
  } else if (values['busy-cancel']) {
    await verifyMountedA2aBusyCancel({ root, installed, repository, source, archive, archiveSha, harness, recoveryPeer,
      counts: () => ({ model: modelCalls, discovery: discoveryCalls, send: a2aSends, get: a2aGets, cancel: a2aCancels }),
      requests: { modelRequests, a2aPeerRequests, serverFailures } });
  } else if (values['reconcile-cold']) {
    await verifyMountedA2aRecovery({ root, installed, repository, source, archive, archiveSha,
      harness, makeHarness: () => new DeepSeekHarness(options), recoveryPeer,
      receiptCrash: values['receipt-crash'], terminalCloseCrash: values['terminal-close-crash'], nodeOnlyBin,
      counts: () => ({ model: modelCalls, discovery: discoveryCalls, send: a2aSends, get: a2aGets }),
      requests: { modelRequests, a2aPeerRequests, discoveryRequests, serverFailures }, a2aReply, remoteTaskId, remoteContextId });
  } else {
  const session = harness.session('a2a-session');
  const result = await session.run('Ask the research agent to find documents about A2A.');
  // After the turn, the DSH subprocess is alive — capture its real PID.
  originalPid = harness.client?.child?.pid ?? null;
  console.log(`\nOriginal DSH subprocess PID: ${originalPid}`);
  console.log(`Turn finalResponse: ${result.finalResponse}`);
  console.log(`HTTP calls: model=${modelCalls}, discovery=${discoveryCalls}, a2aSend=${a2aSends}, a2aGet=${a2aGets}`);

  // === Exact HTTP call counts ===
  // Internal Native mirrors the managed reference: terminal notifications
  // require one original GetTask. The existing public path keeps its behavior.
  assert.equal(modelCalls, 2, `model HTTP calls: expected exactly 2, got ${modelCalls}`);
  assert.equal(discoveryCalls, 1, `discovery HTTP calls: expected exactly 1, got ${discoveryCalls}`);
  assert.equal(a2aSends, 1, `A2A peer Send calls: expected exactly 1, got ${a2aSends}`);
  assert.equal(a2aGets, managedMode ? 1 : 0, 'exact authoritative reads for the selected transport');
  assert.deepEqual(serverFailures, []);

  // === Verify the tool result contains the A2A reply ===
  assert.equal(modelRequests.length, 2, `model requests captured: ${modelRequests.length}`);
  const toolResultMsg = modelRequests[1].messages.find(m => m.role === 'tool');
  assert.ok(toolResultMsg, 'second model request has a tool result message');
  const toolResultContent = String(toolResultMsg.content);
  assert.ok(toolResultContent.includes(a2aReply),
    `tool result contains the A2A reply: "${a2aReply}" in "${toolResultContent.slice(0, 200)}"`);

  // === Verify the A2A peer received the correct message ===
  assert.equal(a2aPeerRequests.length, a2aGets + 1, `A2A peer requests: ${a2aPeerRequests.length}`);
  assert.equal(a2aPeerRequests[0].method, 'SendStreamingMessage', 'first A2A peer request is SendStreamingMessage');
  if (a2aGets > 0) assert.equal(a2aPeerRequests[1].method, 'GetTask', 'second A2A peer request is GetTask');

  // === SQLite: exactly one completed Run ===
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
  const dbPath = join(root, 'studio/native-harness/runs.sqlite');
  const store = new SqliteRunStore(dbPath);
  const { id: agentId } = JSON.parse(await readFile(join(root, 'agent-id.json'), 'utf8'));
  const scope = {
    tenantId: 'local',
    workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex'),
    userId: 'local-user', agentId,
  };

  const allRuns = store.list(scope, 'a2a-session');
  assert.equal(allRuns.length, 1, `exactly one Run in SQLite: got ${allRuns.length}`);
  const runId = allRuns[0].runId;
  const record = store.load(scope, runId);
  assert.equal(record.snapshot.phase, 'completed', `Run phase: expected completed, got ${record.snapshot.phase}`);
  console.log(`Run ${runId}: phase=${record.snapshot.phase}, usage.modelCalls=${record.snapshot.usage?.modelCalls}`);

  assert.equal(record.snapshot.usage.modelCalls, 2); assert.equal(record.snapshot.usage.toolCalls, 1);
  const toolReceipts = record.receipts.filter(receipt => receipt.result?.results);
  assert.equal(toolReceipts.length, 1); assert.equal(toolReceipts[0].status, 'committed');
  const toolResults = toolReceipts[0].result.results;
  assert.equal(toolResults.length, 1); assert.equal(toolResults[0].status, 'ok');
  assert.equal(toolResults[0].content.reply, a2aReply);
  let managedBefore = await managedRecords(root);
  if (managedMode) {
    const deadline = Date.now() + 10000;
    while (true) {
      const journal = JSON.parse(managedBefore[0].content).managed.events;
      if (!journal.pending.length && journal.sessionDelivery?.through === journal.nextSeq - 1) break;
      assert.ok(Date.now() < deadline, 'Host remote outbox or durable Session delivery did not acknowledge canonical events');
      await new Promise(resolve => setTimeout(resolve, 20)); managedBefore = await managedRecords(root);
    }
  }
  assert.equal(managedBefore.length, 1, 'the managed task record is mandatory');
  const managed = JSON.parse(managedBefore[0].content);
  assert.equal(managed.phase, 'terminal'); assert.equal(managed.projection.taskId, remoteTaskId);
  assert.equal(managed.projection.contextId, remoteContextId); assert.equal(managed.projection.state, 'completed');
  assert.equal(toolResults[0].content.task_id, managed.platformTaskId);
  assert.match(managed.platformTaskId, /^a2a-task-[a-f0-9]{32}$/u);
  assert.deepEqual(managed.owner.scope, scope); assert.equal(managed.owner.sessionId, 'a2a-session');
  assert.deepEqual(managed.request.native.scope, scope);
  for (const key of ['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'])
    assert.equal(managed.request.native[key], record.snapshot[key], key);
  assert.equal(managed.request.native.operationKey, toolReceipts[0].operationKey);
  assert.equal(managed.request.native.call.callId, 'a2a-call-1');
  assert.equal(managed.request.native.call.name, 'call_a2a_agent');
  const nativeIntent = record.intents.find(intent => intent.operationKey === toolReceipts[0].operationKey);
  assert.ok(nativeIntent); assert.equal(nativeIntent.claimedFence, managed.request.native.executionFence);
  const admissionPath = join(root, 'tool-admissions.jsonl');
  const admissionsBefore = await readFile(admissionPath, 'utf8'), admissions = await jsonl(admissionPath);
  assert.equal(admissions.length, 1); assert.equal(admissions[0].name, 'call_a2a_agent');
  const durableBefore = await history(root), owners = durableBefore.filter(event => event.type === 'turn/owner');
  const sessionObservations = durableBefore.filter(event => event.type === 'agentkit/a2a-observation');
  if (managedMode) {
    assert.equal(sessionObservations.length, managed.managed.events.log.length);
    assert.deepEqual(sessionObservations.map(event => event.data.eventJson), managed.managed.events.log.map(canonical));
    assert.equal(new Set(sessionObservations.map(event => event.seq)).size, sessionObservations.length);
    for (const event of sessionObservations) {
      assert.equal(event.ignorable, true); assert.equal(event.surfaceOp, undefined); assert.equal(event.sourceEventSeqs, undefined);
      assert.equal(event.data.contract, 'agentkit.a2a-session-event/v1');
      assert.deepEqual(event.data.owner, { agentId: scope.agentId, sessionId: 'a2a-session', kind: 'native' });
      assert.equal(event.data.sourceKey, managed.managed.events.sessionDelivery.sourceKey);
    }
    assert.ok(modelRequests.every(request => !JSON.stringify(request.messages).includes('agentkit/a2a-observation')));
    if (values['public-tool-activity']) assert.ok(modelRequests.every(request => !JSON.stringify(request.messages).includes('remote_search')),
      'remote tool observations are not model tool-call authority');
  } else assert.equal(sessionObservations.length, 0);
  assert.equal(owners.length, 1);
  const ownership = readNativeDshOwnership(owners[0].data, { sessionId: 'a2a-session', turn: 1 });
  assert.equal(ownership.identity.runId, runId); assert.deepEqual(ownership.identity.scope, scope);
  assert.equal(ownership.identity.buildId, record.snapshot.buildId);
  assert.equal(durableBefore.filter(event => event.type === 'turn/end').length, 1);
  assert.equal(durableBefore.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(durableBefore.filter(event => event.type === 'tool/result').length, 1);
  const processPath = join(root, 'host-processes.jsonl'), processesBefore = await jsonl(processPath);
  assert.equal(processesBefore.length, 1); assert.equal(processesBefore[0].pid, originalPid);
  assert.equal(processesBefore[0].node, process.version); assert.equal(processesBefore[0].path, nodeOnlyBin);
  // === Cold-before snapshot ===
  const coldBefore = {
    modelCalls, discoveryCalls, a2aSends, a2aGets,
    a2aPeerRequests: a2aPeerRequests.length,
    runCount: allRuns.length,
  };
  const recordCanonical = canonical(record);
  await writeFile(join(root, 'native-run-before.json'), recordCanonical);
  await writeFile(join(root, 'managed-call-before.json'), managedBefore[0].content);
  await writeFile(join(root, 'a2a-http-requests.json'), JSON.stringify({ modelRequests, discoveryRequests, a2aPeerRequests }, null, 2));
  console.log(`Cold-before snapshot: ${JSON.stringify(coldBefore)}`);
  console.log(`Full record canonical length: ${recordCanonical.length}`);
  store.close();

  // === Real Host/SDK process restart ===
  await inboundProof?.probe('before');
  await harness.close();
  assert.throws(() => process.kill(originalPid, 0), { code: 'ESRCH' }, 'old actual Host process exited');
  harness = new DeepSeekHarness(options);
  const resumed = await harness.resumeSession('a2a-session');
  // Wait for the fixture's resume handler.
  const probePath = join(root, 'mounted-host-http.jsonl');
  const resumeDeadline = Date.now() + 15000;
  let resumeProbe;
  while (Date.now() < resumeDeadline) {
    const rows = (await readFile(probePath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
    resumeProbe = rows.find(row => row.source === 'resume');
    if (resumeProbe) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(resumed.id, 'a2a-session');
  assert.ok(resumeProbe, 'resume probe is mandatory after preset reconstruction');
  assert.equal(resumeProbe.historyHasAnswer, true); assert.equal(resumeProbe.historyHasCompletedTurn, true);
  // Capture the restarted DSH subprocess PID — must differ from the original.
  restartedPid = harness.client?.child?.pid ?? null;
  console.log(`Restarted DSH subprocess PID: ${restartedPid}`);
  assert.ok(restartedPid !== null, 'restarted DSH subprocess PID captured');
  assert.notEqual(restartedPid, originalPid,
    `restarted PID differs from original: original=${originalPid}, restarted=${restartedPid}`);

  assert.equal(resumeProbe.pid, restartedPid);
  const processesAfter = await jsonl(processPath); assert.equal(processesAfter.length, 2);
  assert.equal(processesAfter[1].pid, restartedPid); assert.equal(processesAfter[1].node, process.version);
  await inboundProof?.probe('after');
  assert.equal(processesAfter[1].path, nodeOnlyBin);
  assert.equal(await readFile(admissionPath, 'utf8'), admissionsBefore);
  assert.deepEqual(await managedRecords(root), managedBefore, 'complete original managed call bytes unchanged');
  const durableAfter = await history(root);
  const executionTypes = new Set(['turn/start','turn/owner','turn/end','user/message','assistant/message','tool/call','tool/result']);
  assert.deepEqual(durableAfter.filter(event => executionTypes.has(event.type)), durableBefore.filter(event => executionTypes.has(event.type)));
  assert.deepEqual(serverFailures, []);
  // === Assert counts did NOT increase ===
  assert.equal(modelCalls, coldBefore.modelCalls,
    `no new model calls after restart+resume: ${coldBefore.modelCalls} -> ${modelCalls}`);
  assert.equal(discoveryCalls, coldBefore.discoveryCalls,
    `no new discovery calls after restart+resume: ${coldBefore.discoveryCalls} -> ${discoveryCalls}`);
  assert.equal(a2aSends, coldBefore.a2aSends,
    `no new A2A sends after restart+resume: ${coldBefore.a2aSends} -> ${a2aSends}`);
  assert.equal(a2aGets, coldBefore.a2aGets,
    `no new A2A gets after restart+resume: ${coldBefore.a2aGets} -> ${a2aGets}`);

  // === Entire store.load record canonical unchanged ===
  const reopened = new SqliteRunStore(dbPath);
  const coldRecord = reopened.load(scope, runId);
  const coldCanonical = canonical(coldRecord);
  await writeFile(join(root, 'native-run-after.json'), coldCanonical);
  await writeFile(join(root, 'managed-call-after.json'), (await managedRecords(root))[0].content);
  assert.equal(coldCanonical, recordCanonical,
    'entire store.load record unchanged after real Host restart + SessionController history replay');
  assert.equal(coldRecord.snapshot.phase, 'completed', 'cold run phase completed');
  reopened.close();

  // === Verify no credentials leaked into the SQLite record ===
  const recordStr = canonical(coldRecord);
  assert.equal(recordStr.includes('a2a-fixture-token'), false, 'A2A service token not leaked into SQLite record');
  if (managedMode) {
    assert.deepEqual(internalActions.filter(action => action !== 'AppendA2ATaskEvents'), ['ListA2ASpaceAgents', 'PrepareA2ACall', 'BindA2ARemoteTask', 'PrepareA2ATaskOperation']);
    assert.equal(internalEventBatches.length, values['public-tool-activity'] ? 6 : 5);
    assert.equal(acceptedInternalEvents.size, values['public-tool-activity'] ? 9 : 6);
    const lifecycle = managed.managed.events.log.filter(e => e.item_kind === 'status');
    assert.deepEqual(lifecycle.map(e => (e.initial ?? e.snapshot).parts[0].data.status), ['submitted', 'working', 'completed']);
    const artifact = managed.managed.events.log.filter(e => e.item_kind === 'artifact');
    assert.deepEqual(artifact.map(e => e.event_type), ['item.started', 'item.snapshot_replaced', 'item.completed']);
    assert.equal(artifact.at(-1).snapshot.parts[0].text, a2aReply);
    assert.deepEqual(lifecycle.at(-1).snapshot.parts[0].data.output_refs, [{ scope_id: managed.request.scopeId,
      item_id: artifact.at(-1).item_id, part_id: artifact.at(-1).snapshot.parts[0].part_id }]);
    assert.deepEqual(internalEventBatches.flatMap(batch => batch.Events), managed.managed.events.log);
    assert.equal(managed.managed.events.pending.length, 0);
    assert.equal(managed.managed.events.delivered, values['public-tool-activity'] ? 6 : 5);
    if (values['public-tool-activity']) {
      const tools = managed.managed.events.log.filter(e => e.item_kind === 'tool_call');
      assert.deepEqual(tools.map(e => e.event_type), ['item.started', 'item.updated', 'item.completed']);
      assert.equal(tools[1].update.name, 'remote_search');
      assert.deepEqual(tools[2].snapshot.parts, [tools[1].update]);
      assert.ok(tools.every(e => e.source.metadata.remote_observation === true));
      assert.ok(managed.managed.events.adapter.toolActivityBytes > 0);
    }
    assert.equal(managed.managed.remote.phase, 'bound'); assert.equal(managed.platformTaskId, platformTaskId);
    for (const bytes of [recordStr, managedBefore[0].content]) {
      assert.equal(bytes.includes('mounted-private-permit'), false);
      for (const token of Object.values(workloadTokens)) assert.equal(bytes.includes(token), false);
    }
  }

  // === Save evidence ===
  const evidence = {
    archive: { path: archive, sha256: archiveSha },
    sdk: { source, commit: fresh?.evidence.maintainedHost.source.headCommit
      ?? execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    dependencies: fresh?.evidence ?? { kind: 'maintained-source', source },
    node: process.version,
    internalControlPlane: managedMode, publicToolActivity: values['public-tool-activity'], internalActions,
    internalEvents: managedMode ? { batches: internalEventBatches.length, accepted: acceptedInternalEvents.size,
      pending: managed.managed.events.pending.length, sessionDelivery: managed.managed.events.sessionDelivery,
      sessionObservationCount: sessionObservations.length, log: managed.managed.events.log } : null,
    proofRoot: root,
    originalPid, restartedPid,
    httpCalls: { model: modelCalls, discovery: discoveryCalls, a2aSend: a2aSends, a2aGet: a2aGets },
    coldBefore,
    coldAfter: { modelCalls, discoveryCalls, a2aSends, a2aGets, runCount: 1 },
    runId, agentId, sessionId: 'a2a-session',
    a2aReply, remoteTaskId, remoteContextId,
    a2aPeerMethods: a2aPeerRequests.map(r => r.method),
    recordCanonicalLength: recordCanonical.length,
    recordSha256: createHash('sha256').update(recordCanonical).digest('hex'),
    historyOwnershipDigest: createHash('sha256').update(canonical(owners[0])).digest('hex'),
    canonicalMatchAfterHostRestart: coldCanonical === recordCanonical,
    a2aCallRecordPhase: managed.phase, managedRecordSha256: createHash('sha256').update(managedBefore[0].content).digest('hex'),
    scope, turnId: record.snapshot.turnId, buildId: record.snapshot.buildId, operationKey: toolReceipts[0].operationKey,
    fixtureSha256: createHash('sha256').update(await readFile(join(repository, 'tests/fixtures/studio-native-a2a.mjs'))).digest('hex'),
    limitation: `${fresh ? 'Fresh normally installed maintained Host graph' : 'Fixed local dependency graph'}, actual graceful Host process restart; controlled Server/model, not online service or Frozen deployment.`,
  };
  await writeFile(join(root, 'a2a-proof-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\nEvidence saved: ${join(root, 'a2a-proof-evidence.json')}`);

  process.stdout.write('\nPASS: real A2A discovery + JSONRPC/SSE peer, deterministic model, '
    + 'model calls call_a2a_agent with real reply, '
    + `exactly 2 model + 1 discovery + 1 send + ${a2aGets} get HTTP calls, `
    + 'real Host restart + SessionController history replay with no new calls, '
    + 'entire store.load record canonical unchanged, '
    + 'A2A call identity record terminal, no credential leak\n');
  }
} catch (error) {
  failed = true;
  const detail = { code: error.code, message: error.message, stack: error.stack,
    counts: { modelCalls, discoveryCalls, a2aSends, a2aGets, modelRequests: modelRequests.length, a2aPeerRequests: a2aPeerRequests.length } };
  await writeFile(join(root, 'a2a-proof-failure.json'), JSON.stringify(detail, null, 2)).catch(() => {});
  console.error('A2A proof FAILED:', error.message, error.stack);
  throw error;
} finally {
  if (harness) await harness.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  if (!values.keep && !failed) await rm(root, { recursive: true, force: true });
}
