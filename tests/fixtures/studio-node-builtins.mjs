/** Actual packed Host/preset/DSH ToolRegistry proof, without a model request. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';

export const name = 'studio-node-builtin-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];
export async function apply(ctx, options) {
  const home = options.directory, workspaceRoot = join(home, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(home, 'outside.txt'), 'Outside the workspace.');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'builtin-proof',
    provider: 'openai-compatible', modelName: 'unused', baseUrl: 'http://127.0.0.1:9/v1', default: true,
    credentialName: 'BUILTIN_PROOF_KEY' }], modelProfileKeys: { BUILTIN_PROOF_KEY: 'synthetic-unused' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  const tools = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
    'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
    'search_workspace_files', 'delete_workspace_file'];
  const records = [];
  for (const runtime of ['dsh-native', 'codex']) records.push(await agents.create({ name: `Node builtin ${runtime}`,
    runtimeType: runtime, spec: { bindings: { tools, modelProfileId: 'builtin-proof' } } }));
  await mountStudioHost(ctx, { configurationHome: home, env: { AGENTKIT_HOME: home,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot } });
  ctx.llm.registerAdapter(['agentkit-studio-builtin-proof'], {
    providerInfo: provider => ({ id: provider, name: 'Node builtin registry proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'unused', name: 'unused' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('No model request is permitted in the Node builtin registry proof'); },
  });
  let started = false;
  const timer = setInterval(() => {
    if (started || !existsSync(join(home, 'start-proof'))) return;
    started = true; clearInterval(timer);
    void prove().then(report => writeFile(join(home, 'proof.json'), JSON.stringify(report, null, 2)),
      error => writeFile(join(home, 'proof.json'), JSON.stringify({ passed: false, code: error.code,
        message: error.message, stack: error.stack }, null, 2))).catch(() => {});
  }, 25);
  ctx.effect(() => () => clearInterval(timer), 'Node builtin proof trigger');

  async function prove() {
    const { setSandboxMode } = await import('@deepseek-ai/dsh-sandbox-policy');
    const { setApprovalPolicy } = await import('@deepseek-ai/dsh-user-approval');
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }) });
      const result = (await response.json()).result;
      assert.equal(response.status, 200); assert.equal(result?.ok, true, JSON.stringify(result));
      return result.value;
    };
    const report = { passed: false, node: process.version, path: process.env.PATH, runtimes: [] };
    let serial = 0;
    for (const record of records) {
      const runtime = record.spec.runtime.type;
      const { presetId } = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
      const created = await ctx.sessionController.create({ sessionId: `node-builtins-${runtime}`, cwd: workspaceRoot, agentPreset: presetId });
      const { agent } = await ctx.sessionController.resolveAgent(created.sessionId);
      assert.equal(agent.session.id, created.sessionId);
      // A trusted test turn encloses real approval audits. No model loop or
      // Native Run is fabricated; execution goes through the actual registry.
      agent.session.append('turn/start', { turn: 1 });
      setSandboxMode(agent.session, 'workspace-write');
      const registry = agent.ctx.get('tools');
      const call = async (name, args, signal = new AbortController().signal) => {
        const result = await registry.execute({ agent, callId: `builtin-proof-${++serial}`, name, arguments: args, signal });
        assert.equal(result.isError, false, JSON.stringify(result));
        return JSON.parse(result.value.result);
      };
      const before = [], after = [];
      const removeBefore = agent.ctx.on('tools/pre-execute', async (exec, next) => { before.push(exec.name); return next(); });
      const removeAfter = agent.ctx.on('tools/post-execute', async (exec, result, next) => { after.push(exec.name); return next(result); });
      try {
        const path = `${runtime}.txt`;
        assert.equal((await call('write_workspace_file', { path, content: 'Original bytes.' })).ok, true);
        assert.equal((await call('read_workspace_file', { path })).ok, true);
        assert.equal((await call('edit_workspace_file', { path, old_text: 'Original', new_text: 'Reviewed' })).ok, true);
        assert.equal(await readFile(join(workspaceRoot, path), 'utf8'), 'Reviewed bytes.');
        const other = await ctx.sessionController.create({ sessionId: `node-builtins-${runtime}-other`, cwd: workspaceRoot, agentPreset: presetId });
        const second = (await ctx.sessionController.resolveAgent(other.sessionId)).agent;
        setSandboxMode(second.session, 'workspace-write');
        const unread = await second.ctx.get('tools').execute({ agent: second, callId: `builtin-proof-${++serial}`,
          name: 'edit_workspace_file', arguments: { path, old_text: 'Reviewed', new_text: 'Wrong session' }, signal: new AbortController().signal });
        assert.equal(unread.isError, false);
        assert.equal(JSON.parse(unread.value.result).ok, false);
        assert.equal(await readFile(join(workspaceRoot, path), 'utf8'), 'Reviewed bytes.');
        const escaped = await call('write_workspace_file', { path: '../outside.txt', content: 'Escaped' });
        assert.equal(escaped.ok, false); assert.equal(await readFile(join(home, 'outside.txt'), 'utf8'), 'Outside the workspace.');
        const py = `${runtime}.py`;
        assert.equal((await call('write_workspace_file', { path: py, content: 'x = 1\n' })).ok, true);
        const lint = await call('lint_workspace_file', { path: py });
        assert.equal(lint.ok, true); assert.equal(lint.syntax_engine.parser, 'ruff-wasm');

        setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'never');
        const denied = `${runtime}-denied.txt`;
        assert.equal((await call('write_workspace_file', { path: denied, content: 'Denied.' })).ok, false);
        assert.equal(existsSync(join(workspaceRoot, denied)), false);
        setApprovalPolicy(agent.session, 'ask');
        let asks = 0;
        const removeAnswer = agent.ctx.on('approval/request', async () => ++asks === 1 ? 'allowed-once' : 'rejected');
        try {
          const approved = `${runtime}-approved.txt`, secondPath = `${runtime}-second.txt`;
          assert.equal((await call('write_workspace_file', { path: approved, content: 'One grant.' })).ok, true);
          assert.equal((await call('write_workspace_file', { path: secondPath, content: 'No second grant.' })).ok, false);
          assert.equal(asks, 2); assert.equal(await readFile(join(workspaceRoot, approved), 'utf8'), 'One grant.');
          assert.equal(existsSync(join(workspaceRoot, secondPath)), false);
        } finally { removeAnswer(); }
        const canceledPath = `${runtime}-canceled.txt`, controller = new AbortController();
        let ready, release;
        const waiting = new Promise(resolve => { ready = resolve; });
        const removeWaiting = agent.ctx.on('approval/request', () => { ready(); return new Promise(resolve => { release = resolve; }); });
        try {
          const pending = registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'write_workspace_file',
            arguments: { path: canceledPath, content: 'Late approval.' }, signal: controller.signal });
          await waiting; controller.abort(); release('allowed-once'); await pending;
          assert.equal(existsSync(join(workspaceRoot, canceledPath)), false);
        } finally { removeWaiting(); }
        assert.deepEqual(before, after, 'Both actual DSH policy phases must observe every admitted call.');
        const audits = agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome);
        assert.deepEqual(audits, ['rejected', 'allowed-once', 'rejected', 'cancelled']);
        report.runtimes.push({ runtime, agentId: record.metadata.id, sessionId: created.sessionId,
          registeredCalls: before.length, approvals: audits, crossSessionReadStateIsolated: true, parser: lint.syntax_engine.parser });
      } finally {
        removeBefore(); removeAfter();
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
        assert.equal(await ctx.sessions.flush(agent.session), true);
      }
    }
    await appendFile(join(home, 'verified-runtime.txt'), 'No model request or Python process is needed for the registered Node tools.\n');
    return { ...report, passed: true };
  }
}
