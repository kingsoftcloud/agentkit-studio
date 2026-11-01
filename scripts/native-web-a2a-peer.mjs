/** Deterministic HTTP peer for real Studio question/approval UI acceptance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function createNativeWebA2aPeer({ directory, port = 0 }) {
  const spec = { local_name: 'research', binding_id: 'a2a-binding-0000000000000000000000000001',
    space_id: 'a2a-space-00000000000040008000000000000001', target_agent_id: 'a2a-agent-00000000000040008000000000000002',
    expected_version_id: 'a2a-version-00000000000040008000000000000003', exposure: 'tool', timeout_seconds: 600 };
  const statePath = join(directory, 'a2a-peer-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { platforms: {}, tasks: {}, requests: [] };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  const tokens = Object.fromEntries(['a2a-registry', 'a2a-task-sink', 'a2a-gateway'].map(aud => [aud,
    'e30.' + Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url') + '.c2ln']));
  const tokenDirectory = join(directory, 'a2a-workload-tokens'); mkdirSync(tokenDirectory, { recursive: true, mode: 0o700 });
  for (const [aud, token] of Object.entries(tokens)) {
    const path = join(tokenDirectory, aud + '.jwt');
    writeFileSync(path + '.new', token, { mode: 0o400 }); renameSync(path + '.new', path);
  }
  const question = { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'browser-remote-question', role: 'ROLE_AGENT',
    parts: [{ text: 'BROWSER_REMOTE_QUESTION：请选择需要研究的城市。' }], metadata: { input_schema: { type: 'string' } } } };
  const taskView = task => ({ id: task.id, contextId: task.contextId, status: task.completed ? { state: 'TASK_STATE_COMPLETED' } : question,
    ...(task.completed ? { artifacts: [{ artifactId: 'browser-remote-result', parts: [{ text: 'BROWSER_REMOTE_ANSWER_RECEIVED' }] }] } : {}) });
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const method = body.method ?? req.url.split('/').at(-1);
      state.requests.push({ method, at: Date.now(), platformTaskId: body.A2ATaskId ?? null,
        remoteTaskId: body.params?.id ?? body.params?.message?.taskId ?? null }); save();
      const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (req.url.startsWith('/agentengine/internal/v1/a2a/')) {
        const sink = ['BindA2ARemoteTask', 'AppendA2ATaskEvents'].includes(method);
        assert.equal(req.headers.authorization, 'Bearer ' + tokens[sink ? 'a2a-task-sink' : 'a2a-registry']);
        let data = {};
        if (method === 'ListA2ASpaceAgents') data = { Agents: [{ A2AAgentId: spec.target_agent_id,
          VersionId: spec.expected_version_id, Source: 'hosted', RouteKind: 'hosted_gateway', Callable: true, CardSha256: 'c'.repeat(64),
          AgentCard: { name: 'research', description: 'Isolated browser proof peer', capabilities: { streaming: true },
            supportedInterfaces: [{ url: origin + '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] } }] };
        else if (['PrepareA2ACall', 'PrepareA2ATaskOperation'].includes(method)) {
          const hash = method === 'PrepareA2ACall' ? createHash('sha256').update(body.MessageId).digest('hex') : null;
          const id = hash ? `a2a-task-${hash.slice(0, 12)}4${hash.slice(13, 16)}8${hash.slice(17, 32)}` : body.A2ATaskId;
          if (method === 'PrepareA2ACall') state.platforms[id] ??= { id };
          const platform = state.platforms[id]; assert(platform, 'Original platform task required');
          data = { A2ATaskId: id, Target: { A2AAgentId: spec.target_agent_id, VersionId: spec.expected_version_id, CardSha256: 'c'.repeat(64) },
            Route: { Kind: 'hosted_gateway', Interface: { Url: origin + '/rpc', ProtocolVersion: '1.0', ProtocolBinding: 'JSONRPC' },
              Capabilities: { Streaming: true } }, CallPermit: 'local-browser-fixture-permit', CallPermitExpiresAt: new Date(Date.now() + 60000).toISOString(),
            ...(method === 'PrepareA2ATaskOperation' ? { RemoteTask: { RemoteTaskId: platform.remoteTaskId, RemoteContextId: platform.remoteContextId } } : {}) };
        } else if (method === 'BindA2ARemoteTask') {
          const platform = state.platforms[body.A2ATaskId]; assert(platform);
          platform.remoteTaskId = body.RemoteTaskId; platform.remoteContextId = body.RemoteContextId;
        } else { assert.equal(method, 'AppendA2ATaskEvents'); data = { AcceptedCount: body.Events.length }; }
        save(); json({ Code: 0, Data: data }); return;
      }
      assert.equal(req.url, '/rpc'); assert.equal(req.headers.authorization, 'Bearer ' + tokens['a2a-gateway']);
      const wrap = result => ({ jsonrpc: '2.0', id: body.id, result });
      if (method === 'SendStreamingMessage') {
        const id = 'browser-remote-' + body.params.message.messageId;
        assert(!state.tasks[id], 'The original send must not be repeated');
        const task = state.tasks[id] = { id, contextId: 'context-' + id, completed: false }; save();
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end('id: 1\ndata: ' + JSON.stringify(wrap({ task: taskView(task) })) + '\n\n'); return;
      }
      const task = state.tasks[body.params.id ?? body.params.message?.taskId]; assert(task, 'Original remote task required');
      if (method === 'SendMessage') {
        assert.equal(task.completed, false); assert.deepEqual(body.params.message.parts, [{ data: 'BROWSER_CITY' }]);
        task.completed = true; task.answer = 'BROWSER_CITY'; save(); json(wrap({ task: taskView(task) }));
      } else { assert.equal(method, 'GetTask'); json(wrap(taskView(task))); }
    } catch (error) {
      appendFileSync(join(directory, 'a2a-peer-errors.log'), error.stack + '\n');
      if (!res.headersSent) res.writeHead(500); res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { spec, port: server.address().port, env: { KSADK_A2A_ALLOW_PRIVATE: 'true',
    KSADK_A2A_CONTROL_PLANE_URL: origin, KSADK_A2A_TOKEN_DIR: tokenDirectory },
    close() { server.closeAllConnections(); server.close(); } };
}
