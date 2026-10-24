// Real localhost control-plane and A2A peer. Synthetic projected JWTs are not
// signed by a real issuer; only the remote services themselves are fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const agentId = 'a2a-agent-11111111111141118111111111111111';
export const versionId = 'a2a-version-22222222222242228222222222222222';
export const taskId = 'a2a-task-33333333333343338333333333333333';
export const spec = { local_name: 'research', binding_id: 'internal', space_id: 'as-123456789abc',
  target_agent_id: agentId, expected_version_id: versionId };
export const scope = { tenantId: 'local', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
export const token = (aud, serial) => [Buffer.from('{"alg":"fixture"}').toString('base64url'),
  Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3600, serial })).toString('base64url'), 'c2ln'].join('.');
export async function internalPeer({ protocol = 'JSONRPC', streaming = false, kind = 'hosted_gateway', mode = 'complete',
  preparedStreaming = streaming, initialExisting = false, publicEgress = false, dsh = false,
  initialTask, streamUpdates, subscriptionUpdates, directMessage, expectedContinuationParts = [{ data: { answer: 1 } }], continuationTasks = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-internal-'))), workspaceRoot = join(root, 'workspace'), tokenDirectory = join(root, 'tokens');
  mkdirSync(workspaceRoot); mkdirSync(tokenDirectory);
  const rotate = (aud, serial) => {
    const path = join(tokenDirectory, aud + '.jwt'); if (existsSync(path)) chmodSync(path, 0o600);
    writeFileSync(path, token(aud, serial), { mode: 0o400 }); chmodSync(path, 0o400);
  };
  for (const aud of ['a2a-registry', 'a2a-task-sink', 'a2a-gateway', 'credential-broker']) rotate(aud, 1);
  const calls = [], errors = [], owners = [];
  let bound = initialExisting, fault = mode, hook, finishStream;
  let task = { id: 'original-remote', contextId: 'original-context', status: { state: mode === 'pause' ? 'TASK_STATE_INPUT_REQUIRED'
    : mode === 'hold-stream' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
    ...(mode === 'pause' ? { message: { messageId: 'question', role: 'ROLE_AGENT', parts: [{ text: 'Please answer' }],
      metadata: { input_schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } } } } : {}) } };
  if (initialTask) task = structuredClone(initialTask);
  const pendingContinuationTasks = structuredClone(continuationTasks);
  let recordDirectory = join(root, 'state');
  const records = () => {
    const directory = recordDirectory;
    try { return readdirSync(directory).flatMap(owner => readdirSync(join(directory, owner)).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(directory, owner, name), 'utf8')))); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const record = () => records()[0];
  const server = createServer((req, res) => void (async () => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, url = new URL(req.url, origin), action = url.pathname.split('/').at(-1);
    const call = { path: req.url, action, method: req.method, body, headers: { ...req.headers } }; calls.push(call);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.startsWith('/agentengine/internal/v1/a2a/')) {
      const audience = ['BindA2ARemoteTask', 'AppendA2ATaskEvents'].includes(action) ? 'a2a-task-sink' : action === 'ResolveA2ACredential' ? 'credential-broker' : 'a2a-registry';
      assert.equal(req.headers.authorization, 'Bearer ' + readFileSync(join(tokenDirectory, audience + '.jwt'), 'utf8'));
      let data = {};
      if (action === 'ListA2ASpaceAgents') {
        assert.equal(body.A2ASpaceId, spec.space_id);
        data = { Agents: [{ A2AAgentId: agentId, VersionId: versionId, CardSha256: 'c'.repeat(64), Source: kind === 'hosted_gateway' ? 'hosted' : 'external',
          RouteKind: kind, Callable: true, AgentCard: { name: 'research', capabilities: { streaming },
            supportedInterfaces: [{ url: origin + '/discovery-route', protocolBinding: protocol, protocolVersion: '1.0' }] } }] };
        rotate('a2a-registry', 2);
      } else if (action.startsWith('Prepare')) {
        assert.ok(record().phase !== 'prepared');
        const operation = Object.values(record().managed.operations).find(value => value.phase === 'preparing');
        assert.ok(operation, 'persisted operation intent precedes control-plane HTTP');
        if (action === 'PrepareA2ACall') {
          assert.equal(body.TargetA2AAgentId, agentId); assert.equal(body.ExpectedVersionId, versionId);
          assert.equal(body.MessageId, record().request.message.messageId);
          assert.ok(body.IdempotencyToken); assert.match(body.MessageSha256, /^[a-f0-9]{64}$/u);
        } else assert.equal(body.A2ATaskId, taskId);
        data = { A2ATaskId: taskId, Target: { A2AAgentId: agentId, VersionId: fault === 'version-drift'
          ? 'a2a-version-44444444444444448444444444444444' : versionId, CardSha256: 'c'.repeat(64) },
          Route: { Kind: kind, Interface: { Url: origin + (protocol === 'JSONRPC' ? '/rpc' : '/rest') + (kind !== 'hosted_gateway' ? '?route=kept' : ''),
            ProtocolBinding: protocol, ProtocolVersion: '1.0' }, Capabilities: { Streaming: preparedStreaming } },
          CallPermit: 'private-permit', CallPermitExpiresAt: new Date(Date.now() + (fault === 'expired-permit' ? -1000 : 60000)).toISOString(),
          CredentialHandle: 'private-handle', ...(bound ? { RemoteTask: { RemoteTaskId: task.id, RemoteContextId: task.contextId } } : {}) };
        if (fault === 'prepare-lost') { res.destroy(); return; }
      } else if (action === 'BindA2ARemoteTask') {
        assert.equal(record().managed.remote.phase, 'binding'); assert.equal(record().managed.remote.id, task.id);
        assert.equal(body.A2ATaskId, taskId); assert.equal(body.RemoteTaskId, task.id); bound = true;
        if (fault === 'bind-lost') { res.destroy(); return; }
      } else if (action === 'AppendA2ATaskEvents') {
        assert.equal(body.A2ATaskId, taskId); assert.ok(body.Events.length > 0 && body.Events.length <= 100);
        for (const event of body.Events) {
          assert.equal(event.schema_version, 2); assert.equal(event.source.framework, 'a2a');
          assert.ok(record().managed.events.log.some(value => JSON.stringify(value) === JSON.stringify(event)), 'canonical log is durable before append');
        }
      } else if (action === 'ResolveA2ACredential') {
        assert.ok(Object.values(record().managed.operations).some(value => value.credentialPhase === 'resolving'));
        assert.equal(body.CallPermit, 'private-permit'); assert.equal(body.CredentialHandle, 'private-handle');
        data = { Injection: { Headers: { Authorization: 'Bearer external-key' }, Query: { key: 'external-query' },
          Cookies: { session: 'two words;comma,quote"slash\\' } }, ExpiresAt: new Date(Date.now() + 60000).toISOString() };
        if (fault === 'credential-conflict') data.Injection.Headers.Host = 'substitute.invalid';
        if (fault === 'query-conflict') data.Injection.Query.route = 'substitute';
      } else assert.fail('Unexpected internal Action ' + action);
      if (hook) await hook(call, res);
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ Code: 0, Data: data })); return;
    }
    assert.notEqual(url.pathname, '/discovery-route', 'prepared route, never the stale discovery route');
    assert.ok(Object.values(record().managed.operations).some(value => value.phase === 'transport'));
    assert.equal(record().platformTaskId, taskId);
    if (kind === 'hosted_gateway') {
      assert.equal(req.headers.authorization, 'Bearer ' + readFileSync(join(tokenDirectory, 'a2a-gateway.jwt'), 'utf8'));
      assert.equal(req.headers['x-agentengine-a2a-permit'], 'private-permit');
    } else {
      assert.equal(req.headers.authorization, 'Bearer external-key'); assert.equal(req.headers['x-agentengine-a2a-permit'], undefined);
      assert.equal(url.searchParams.get('route'), 'kept'); assert.equal(url.searchParams.get('key'), 'external-query');
      assert.equal(req.headers.cookie, 'session="two words\\073comma\\054quote\\"slash\\\\"');
    }
    const method = protocol === 'JSONRPC' ? body.method : url.pathname.endsWith(':subscribe') ? 'SubscribeToTask' : req.method === 'GET' ? 'GetTask'
      : url.pathname.endsWith(':cancel') ? 'CancelTask' : url.pathname.endsWith('/message:stream') ? 'SendStreamingMessage' : 'SendMessage';
    call.wireMethod = method;
    const params = protocol === 'JSONRPC' ? body.params : body;
    const wrap = result => protocol === 'JSONRPC' ? { jsonrpc: '2.0', id: body.id, result } : result;
    if (method === 'SubscribeToTask') {
      assert.equal(protocol === 'JSONRPC' ? params.id : decodeURIComponent(url.pathname.split('/').at(-1).replace(/:subscribe$/u, '')), task.id);
      assert.equal(req.method, 'POST'); assert.equal(req.headers.accept, 'text/event-stream');
      assert.ok(Object.values(record().controls).some(value => value.command.kind === 'subscribe' && value.phase === 'watching'));
      assert.equal(calls.filter(value => value.action === 'PrepareA2ATaskOperation').at(-1).body.Operation, 'subscribe_to_task');
      if (hook) await hook(call, res);
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('Content-Type', 'text/event-stream');
      for (const [index, payload] of (subscriptionUpdates ?? [{ task }]).entries())
        res.write(`id: frame-${index}\ndata: ${JSON.stringify(wrap(payload))}\n\n`);
      res.end(); return;
    }
    if (method === 'GetTask' || method === 'CancelTask') {
      assert.equal(protocol === 'JSONRPC' ? params.id : decodeURIComponent(url.pathname.split('/').at(-1).replace(/:cancel$/u, '')), task.id);
      if (method === 'CancelTask') task = { ...task, status: { state: 'TASK_STATE_CANCELED' } };
      if (fault === 'malformed-get') { res.end('private-permit external-key external-query malformed JSON'); return; }
      if (fault === 'get-lost') { res.destroy(); return; }
      if (hook) await hook(call, res);
      if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify(wrap(task))); return;
    }
    if (params.message.taskId) {
      assert.equal(params.message.taskId, task.id); assert.equal(params.message.contextId, task.contextId);
      const entry = Object.values(record().controls).find(value => value.phase === 'sending' && value.command.kind === 'continue');
      assert.ok(entry); assert.deepEqual(params.message.parts, expectedContinuationParts);
      task = pendingContinuationTasks.length ? pendingContinuationTasks.shift() : { ...task, status: { state: 'TASK_STATE_COMPLETED' } };
    }
    if (hook) await hook(call, res);
    if (res.destroyed || res.writableEnded) return;
    if (fault === 'send-lost') { res.destroy(); return; }
    if (fault === 'invalid-task') task = { ...task, status: { state: 'INVALID_STATE' } };
    if (directMessage) { res.end(JSON.stringify(wrap({ message: directMessage }))); return; }
    if (method === 'SendStreamingMessage') {
      res.setHeader('Content-Type', 'text/event-stream');
      if (streamUpdates) {
        for (const [index, payload] of streamUpdates.entries()) res.write(`id: frame-${index}\ndata: ${JSON.stringify(wrap(payload))}\n\n`);
        res.end(); return;
      }
      res.write('id: first\ndata: ' + JSON.stringify(wrap({ task: { ...task, status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n');
      if (fault === 'hold-stream') {
        finishStream = () => res.end('id: late\ndata: ' + JSON.stringify(wrap({ statusUpdate: { taskId: task.id,
          contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } } })) + '\n\n'); return;
      }
      res.end('id: final\ndata: ' + JSON.stringify(wrap({ statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } })) + '\n\n');
    } else res.end(JSON.stringify(wrap({ task })));
  })().catch(error => { errors.push(error); if (!res.destroyed) { res.statusCode = 500; res.end('{}'); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { KSADK_A2A_CONTROL_PLANE_URL: origin, KSADK_A2A_TOKEN_DIR: tokenDirectory,
    KSADK_A2A_ALLOW_PRIVATE: 'true', KSADK_A2A_ENABLE_PUBLIC_EGRESS: String(publicEgress),
    KSADK_A2A_SERVICE_TOKEN: 'public-token-must-not-leak' };
  return { root, workspaceRoot, env, calls, errors, owners, record, rotate, dsh,
    finishStream: () => finishStream?.(),
    setRecordDirectory: value => { recordDirectory = value; },
    setMode: value => { fault = value; }, setHook: value => { hook = value; },
    setTask: value => { task = structuredClone(value); },
    async close() { for (const owner of owners) owner.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true }); assert.deepEqual(errors, []); } };
}
