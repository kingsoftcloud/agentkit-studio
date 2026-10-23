/** Actual packed Host/preset/DSH ToolRegistry proof, without a model request. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createAgentStore } from '../../src/agent-store.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';

export const name = 'studio-node-builtin-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];
export async function apply(ctx, options) {
  const home = options.directory, workspaceRoot = join(home, 'workspace');
  const fullWebText = '完整网页输出 😀 中文 '.repeat(1200);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  let networkCalls = 0, pendingRequest; const skillRequests = [];
  const web = createServer((req, res) => {
    networkCalls++;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/skills/')) {
      skillRequests.push(req.url); assert.equal(req.headers.authorization, 'Bearer builtin-skill-read-token');
      const action = url.pathname.split('/').at(-1); let data;
      if (action === 'ListSkillSpaces') data = { SkillSpaces: [{ SkillSpaceId: 'packed-space', SkillSpaceName: 'Packed space' }] };
      else if (action === 'ListSkillsBySpaceId') {
        assert.equal(url.searchParams.get('SpaceId'), 'packed-space');
        data = { SkillSpaceId: 'packed-space', TotalCount: 1, Skills: [{ SkillId: 'packed-alpha-id', VersionId: 'v1',
          Name: 'packed-alpha', Description: 'Packed Alpha task', Status: 'active', ContentHash: 'sha256:' + options.skillArchiveHash }] };
      } else {
        assert.equal(action, 'GetSkillDownloadUrl'); assert.equal(url.searchParams.get('SkillId'), 'packed-alpha-id');
        assert.equal(url.searchParams.get('VersionId'), 'v1'); data = { DownloadUrl: options.skillDownloadUrl };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ Code: 0, Data: data })); return;
    }
    if (url.pathname === '/wait') { pendingRequest?.(); return; }
    if (url.pathname === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(fullWebText);
    }
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [{ title: '确定性检索结果', url: 'https://example.com/result', snippet: url.searchParams.get('q') }] }));
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>Never render this</script><p>真实网页 😀</p>');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  ctx.effect(() => () => { web.closeAllConnections(); return new Promise(resolve => web.close(resolve)); }, 'Node web proof server');
  const webOrigin = `http://127.0.0.1:${web.address().port}`;
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(home, 'outside.txt'), 'Outside the workspace.');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'builtin-proof',
    provider: 'openai-compatible', modelName: 'unused', baseUrl: 'http://127.0.0.1:9/v1', default: true,
    credentialName: 'BUILTIN_PROOF_KEY' }], modelProfileKeys: { BUILTIN_PROOF_KEY: 'synthetic-unused' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  const tools = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
    'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
    'search_workspace_files', 'delete_workspace_file', 'web_fetch', 'web_search',
    'sandbox_status', 'run_command', 'read_command_output', 'stop_command', 'component_status',
    'list_skill_spaces', 'list_skills', 'search_skills', 'preview_skill', 'load_skill', 'execute_skills'];
  const records = [];
  for (const runtime of ['dsh-native', 'codex']) records.push(await agents.create({ name: `Node builtin ${runtime}`,
    runtimeType: runtime, spec: { bindings: { tools, modelProfileId: 'builtin-proof' } } }));
  await mountStudioHost(ctx, { configurationHome: home, env: { AGENTKIT_HOME: home, PATH: process.env.PATH,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, KSADK_WEB_SSRF_POLICY_JSON: '{"allowPrivate":true}',
    KSADK_WEB_SEARCH_PROVIDER: 'http', KSADK_WEB_SEARCH_BASE_URL: `${webOrigin}/search`,
    KSADK_SKILL_SPACE_IDS: 'packed-space', KSADK_SKILL_SERVICE_URL: `${webOrigin}/skills/api/v1`,
    KSADK_SKILL_SERVICE_TOKEN: 'builtin-skill-read-token', KSADK_SKILL_RUNTIME_BACKEND: 'local_process',
    KSADK_SKILL_RUNTIME_TIMEOUT: '20' } });
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
        const components = await call('component_status', {});
        // Before any request, SessionController uses the maintained SDK's
        // configured Agent default; the proof deliberately makes no model call.
        assert.equal(agent.options.model, 'deepseek-flash');
        assert.equal(components.ok, true); assert.equal(components.summary.model, agent.options.model);
        assert.equal(components.summary.knowledge_base_bound, false); assert.equal(components.summary.long_term_memory_bound, false);
        assert.equal(components.summary.skill_space_bound, true); assert.equal(components.summary.isolated_execution, 'not_enabled');
        assert.equal(components.sandbox.backend, 'local_process'); assert.equal(components.sandbox.enabled, true);
        assert.deepEqual(components.sandbox.tools, ['sandbox_status', 'run_command', 'read_command_output', 'stop_command']);
        assert.deepEqual([...components.workspace.tools].sort(), tools.filter(name => name.includes('workspace')).sort());
        assert.equal(components.workspace.root, workspaceRoot); assert.equal(components.skill_runtime.enabled, true);
        assert.deepEqual(components.skill_space.user_space_ids, ['packed-space']);
        assert.deepEqual(components.skill_space.tools, ['list_skill_spaces', 'list_skills', 'load_skill', 'preview_skill', 'search_skills', 'execute_skills']);
        setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'never');
        const startSkillRequests = skillRequests.length;
        assert.equal((await call('list_skill_spaces', {})).spaces[0].space_name, 'Packed space');
        assert.equal((await call('list_skills', {})).skills[0].name, 'packed-alpha');
        assert.equal((await call('search_skills', { query: 'packed-alpha' })).results[0].name, 'packed-alpha');
        assert.equal((await call('preview_skill', { skill_name: 'packed-alpha' })).execution_context, 'manifest_preview');
        const loadedSkill = await call('load_skill', { skill_name: 'packed-alpha' });
        assert.equal(loadedSkill.ok, true); assert.equal(loadedSkill.instructions, options.skillBody);
        assert.equal(await readFile(join(loadedSkill.root_dir, 'scripts/run.sh'), 'utf8'), options.skillScript);
        assert.ok(loadedSkill.root_dir.startsWith(await realpath(home) + sep));
        assert.equal(loadedSkill.root_dir.startsWith(await realpath(workspaceRoot) + sep), false);
        assert.equal(existsSync(join(workspaceRoot, 'must-not-execute')), false);
        const beforeDenied = skillRequests.length;
        const removeSkillDeny = agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'load_skill'
          ? { kind: 'deny', reason: 'Skill read policy proof' } : next());
        try {
          const deniedSkill = await registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'load_skill',
            arguments: { skill_name: 'packed-alpha' }, signal: new AbortController().signal });
          assert.equal(deniedSkill.isError, true); assert.equal(skillRequests.length, beforeDenied);
        } finally { removeSkillDeny(); }
        const removeSkillPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'preview_skill'
          ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted Skill preview' }] } : next());
        try {
          const redacted = await registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'preview_skill',
            arguments: { skill_name: 'packed-alpha' }, signal: new AbortController().signal });
          assert.equal(redacted.isError, false); assert.deepEqual(redacted.content, [{ type: 'text', text: 'Host-redacted Skill preview' }]);
        } finally { removeSkillPost(); }
        const skillsProof = { instructionsSha256: sha256(loadedSkill.instructions), rootDir: loadedSkill.root_dir,
          serviceRequests: skillRequests.length - startSkillRequests, policyDeniedWithoutRequest: true,
          postPolicyPreserved: true, scriptsNotExecuted: true };
        assert.equal(skillsProof.serviceRequests, 7);
        const startWorkflowRequests = skillRequests.length;
        const workflowArgs = { workflow_prompt: 'Use packed-alpha', skill_names: ['packed-alpha'] };
        assert.equal((await call('execute_skills', workflowArgs)).ok, false);
        assert.equal(skillRequests.length, startWorkflowRequests, 'denied workflow cannot load packages or execute');
        setApprovalPolicy(agent.session, 'ask');
        let workflowApprovals = 0, workflowResult, workflowId;
        const removeWorkflowApproval = agent.ctx.on('approval/request', async () => ++workflowApprovals === 1 ? 'allowed-once' : 'rejected');
        const invokeWorkflow = () => registry.execute({ agent, callId: workflowId, name: 'execute_skills',
          arguments: workflowArgs, signal: new AbortController().signal });
        try {
          workflowId = `workflow-original-${runtime}`;
          const first = await invokeWorkflow(); assert.equal(first.isError, false); workflowResult = JSON.parse(first.value.result);
          assert.equal(workflowResult.ok, true, JSON.stringify(workflowResult)); assert.equal(workflowResult.command_ids.length, 1);
          assert.equal(workflowResult.backend, 'local_process'); assert.equal(workflowResult.isolated, false);
          const deniedAgain = await call('execute_skills', workflowArgs); assert.equal(deniedAgain.ok, false);
          assert.equal(workflowApprovals, 2);
        } finally { removeWorkflowApproval(); }
        setSandboxMode(agent.session, 'workspace-write');
        const duplicateWorkflow = await invokeWorkflow(); assert.equal(duplicateWorkflow.isError, false);
        assert.deepEqual(JSON.parse(duplicateWorkflow.value.result), workflowResult);
        const artifactBytes = await Promise.all(workflowResult.output_files.map(file => readFile(file)));
        assert.equal(artifactBytes.length, 2);
        assert.ok(artifactBytes.some(bytes => bytes.equals(Buffer.from('Packed workflow 😀'))));
        assert.ok(artifactBytes.some(bytes => bytes.equals(Buffer.from([0, 1, 255]))));
        const workflowRoot = join(home, 'studio/builtin-workspace/skill-workflows');
        const workflowRecords = [];
        for (const path of await readdir(workflowRoot, { recursive: true })) if (path.endsWith('record.json')) {
          const file = join(workflowRoot, path), value = JSON.parse(await readFile(file, 'utf8'));
          if (value.contract === 'agentkit.dsh-local-skill-runtime/v1' && value.request.agentId === record.metadata.id) workflowRecords.push({ file, value });
        }
        assert.equal(workflowRecords.length, 1); const workflowRecord = workflowRecords[0];
        assert.equal(workflowRecord.value.request.sessionId, created.sessionId); assert.equal(workflowRecord.value.request.callId, workflowId);
        assert.equal(workflowRecord.value.runtimeId, workflowResult.runtime_id); assert.equal(workflowRecord.value.phase, 'finished');
        for (const key of ['scope', 'runId', 'turnId', 'buildId', 'executionFence']) assert.equal(key in workflowRecord.value.request, false);
        assert.equal(await readFile(join(dirname(workflowRecord.file), 'work/effect'), 'utf8'), 'x');
        const removeWorkflowPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'execute_skills'
          ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted workflow result' }] } : next());
        try {
          const redacted = await invokeWorkflow(); assert.equal(redacted.isError, false);
          assert.deepEqual(redacted.content, [{ type: 'text', text: 'Host-redacted workflow result' }]);
        } finally { removeWorkflowPost(); }
        assert.equal(skillRequests.length - startWorkflowRequests, 2);
        const workflowProof = { runtimeId: workflowResult.runtime_id, taskId: workflowResult.task_id, executedOnce: true,
          serviceRequests: 2, exactArtifacts: true, originalDshOwner: true, oneShotApprovals: workflowApprovals,
          policyDeniedWithoutRequest: true, postPolicyPreserved: true, record: workflowRecord.file };
        setSandboxMode(agent.session, 'workspace-write');
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
        // Both legacy runtimes must use the production Node web factory inside
        // the actual DSH pre/guard/around/post/output pipeline.
        const phases = []; let preDeny = false, guardDeny = false, redact = false;
        const isWeb = exec => exec.name === 'web_fetch' || exec.name === 'web_search';
        const removeWebPre = agent.ctx.on('tools/pre-execute', async (exec, next) => {
          if (isWeb(exec)) { phases.push('pre'); if (preDeny) return { kind: 'deny', reason: 'test web policy' }; }
          return next();
        });
        const removeWebGuard = registry.guard(exec => {
          if (isWeb(exec)) { phases.push('guard'); if (guardDeny) return 'test web guard'; }
        });
        const removeWebAround = agent.ctx.on('tools/execute', async (exec, next) => {
          if (isWeb(exec)) phases.push('around'); return next();
        });
        const removeWebPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
          if (isWeb(exec)) {
            phases.push('post');
            if (redact) return { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted web content' }] };
          }
          return next();
        });
        const removeWebResult = agent.ctx.on('tools/result', (exec) => { if (isWeb(exec)) phases.push('result'); });
        let webProof;
        try {
          const startCalls = networkCalls;
          const fetched = await call('web_fetch', { url: `${webOrigin}/page` });
          assert.equal(fetched.ok, true); assert.equal(fetched.text, '真实网页 😀');
          assert.equal(phases[0], 'pre'); assert.ok(phases.indexOf('guard') > 0);
          assert.ok(phases.indexOf('around') > phases.indexOf('guard'));
          assert.ok(phases.indexOf('post') > phases.indexOf('around')); assert.equal(phases.at(-1), 'result');
          const normalPhases = [...phases];
          const largeArgs = { url: `${webOrigin}/large`, max_chars: 100 };
          const largeCallId = `builtin-proof-${serial + 1}`;
          const large = await call('web_fetch', largeArgs);
          assert.equal(large.ok, true); assert.equal(large.truncated, true);
          assert.ok(Array.from(large.text).length <= 100);
          const fullOutput = async (result, sessionId, callId) => {
            const path = result.persisted?.path;
            assert.equal(result.persisted?.failed, undefined); assert.ok(isAbsolute(path));
            assert.ok(path.startsWith(await realpath(home) + sep));
            assert.equal(path.startsWith(await realpath(workspaceRoot) + sep), false);
            const bytes = await readFile(path);
            assert.ok(bytes.equals(Buffer.from(fullWebText)), 'The file must contain the entire original UTF-8 output');
            const facts = JSON.parse(await readFile(join(dirname(path), 'metadata.json'), 'utf8'));
            assert.equal(facts.contract, 'agentkit.dsh-node-tool-output/v1');
            assert.equal(facts.sha256, sha256(bytes)); assert.equal(facts.sizeBytes, bytes.length);
            assert.equal(facts.request.agentId, record.metadata.id); assert.equal(facts.request.sessionId, sessionId);
            assert.deepEqual(facts.request.call, { callId, name: 'web_fetch', arguments: largeArgs });
            assert.equal(facts.request.definition.name, 'web_fetch'); assert.equal(facts.request.signal, undefined);
            assert.deepEqual(facts.metadata, { toolName: 'web_fetch', mediaType: 'text/plain; charset=utf-8',
              fullBytes: bytes.length, reachedByteCeiling: false });
            assert.equal(basename(dirname(dirname(path))), sha256(sessionId));
            assert.equal(basename(dirname(dirname(dirname(path)))), sha256(record.metadata.id));
            return { path, sha256: facts.sha256, sizeBytes: bytes.length };
          };
          const firstOutput = await fullOutput(large, created.sessionId, largeCallId);
          const secondCallId = `builtin-proof-${++serial}`;
          const secondLarge = await second.ctx.get('tools').execute({ agent: second, callId: secondCallId,
            name: 'web_fetch', arguments: largeArgs, signal: new AbortController().signal });
          assert.equal(secondLarge.isError, false);
          const otherOutput = await fullOutput(JSON.parse(secondLarge.value.result), other.sessionId, secondCallId);
          assert.notEqual(firstOutput.path, otherOutput.path);
          assert.equal(firstOutput.sha256, otherOutput.sha256);
          const searched = await call('web_search', { query: `${runtime} query`, recency_days: 2 });
          assert.equal(searched.ok, true); assert.equal(searched.results[0].snippet, `${runtime} query`);
          for (const gate of ['pre', 'guard']) {
            phases.length = 0; preDeny = gate === 'pre'; guardDeny = gate === 'guard';
            const beforeDeny = networkCalls;
            const deniedWeb = await registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'web_fetch',
              arguments: { url: `${webOrigin}/forbidden` }, signal: new AbortController().signal });
            assert.equal(deniedWeb.isError, true); assert.equal(networkCalls, beforeDeny);
            assert.equal(phases.includes('around'), false);
          }
          preDeny = false; guardDeny = false; redact = true;
          const redactedWeb = await registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'web_fetch',
            arguments: { url: `${webOrigin}/redacted` }, signal: new AbortController().signal });
          assert.equal(redactedWeb.isError, false);
          assert.deepEqual(redactedWeb.content, [{ type: 'text', text: 'Host-redacted web content' }]);
          redact = false;
          const waiting = new Promise(resolve => { pendingRequest = resolve; }), abort = new AbortController();
          const canceledWeb = registry.execute({ agent, callId: `builtin-proof-${++serial}`, name: 'web_fetch',
            arguments: { url: `${webOrigin}/wait` }, signal: abort.signal });
          await waiting; abort.abort();
          const canceledResult = await canceledWeb;
          assert.ok(canceledResult.isError || JSON.parse(canceledResult.value.result).ok === false);
          assert.equal(networkCalls - startCalls, 6, 'Two policy denials must dispatch zero HTTP requests');
          webProof = { normalPhases, calls: networkCalls - startCalls, searchProvider: searched.provider,
            preAndGuardDeniedWithoutFetch: true, postPolicyPreserved: true, canceled: true,
            fullOutputPersisted: true, crossSessionOutputIsolated: true, outputs: [firstOutput, otherOutput] };
        } finally {
          removeWebPre(); removeWebGuard(); removeWebAround(); removeWebPost(); removeWebResult(); pendingRequest = undefined;
        }
        setSandboxMode(agent.session, 'workspace-write');
        const commandPhases = [], commandNames = new Set(['sandbox_status', 'run_command', 'read_command_output', 'stop_command']);
        let commandDeny = false, commandRedact = false;
        const removeCommandPre = agent.ctx.on('tools/pre-execute', async (exec, next) => {
          if (commandNames.has(exec.name)) commandPhases.push('pre'); return next();
        });
        const removeCommandGuard = registry.guard(exec => {
          if (commandNames.has(exec.name)) {
            commandPhases.push('guard'); if (commandDeny) return 'command denied before Node dispatch';
          }
        });
        const removeCommandAround = agent.ctx.on('tools/execute', async (exec, next) => {
          if (commandNames.has(exec.name)) commandPhases.push('around'); return next();
        });
        const removeCommandPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => {
          if (commandNames.has(exec.name)) {
            commandPhases.push('post');
            if (commandRedact) return { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted command output' }] };
          }
          return next();
        });
        const removeCommandResult = agent.ctx.on('tools/result', exec => { if (commandNames.has(exec.name)) commandPhases.push('result'); });
        let commandProof;
        try {
          const status = await call('sandbox_status', {});
          assert.equal(status.backend, 'local_process'); assert.equal(status.isolated, false);
          commandPhases.length = 0;
          const counter = `${runtime}-command-counter`, command = `printf x >> ${counter}; printf "$PATH:$CI"`;
          const callId = `command-duplicate-${runtime}`;
          const invoke = (args, id = callId) => registry.execute({ agent, callId: id, name: 'run_command',
            arguments: args, signal: new AbortController().signal });
          const first = await invoke({ command }); assert.equal(first.isError, false);
          const foreground = JSON.parse(first.value.result);
          assert.equal(foreground.ok, true); assert.equal(foreground.stdout, `${process.env.PATH}:1`);
          const normalPhases = [...commandPhases]; assert.deepEqual(normalPhases, ['pre', 'guard', 'around', 'post', 'result']);
          const duplicate = await invoke({ command }); assert.equal(duplicate.isError, false);
          assert.deepEqual(JSON.parse(duplicate.value.result), foreground);
          assert.equal(await readFile(join(workspaceRoot, counter), 'utf8'), 'x');
          const conflict = await invoke({ command: `printf wrong >> ${counter}` });
          assert.equal(JSON.parse(conflict.value.result).error_type, 'dsh_node_command_call_identity_conflict');
          assert.equal(await readFile(join(workspaceRoot, counter), 'utf8'), 'x');
          commandDeny = true;
          const deniedCommand = await invoke({ command: `printf no > ${runtime}-command-denied` }, `command-guard-${runtime}`);
          assert.equal(deniedCommand.isError, true); assert.equal(existsSync(join(workspaceRoot, `${runtime}-command-denied`)), false);
          commandDeny = false; commandRedact = true;
          const redacted = await invoke({ command: 'printf original' }, `command-redact-${runtime}`);
          assert.equal(redacted.isError, false); assert.deepEqual(redacted.content, [{ type: 'text', text: 'Host-redacted command output' }]);
          commandRedact = false;
          const large = await call('run_command', { command: "/usr/bin/awk 'BEGIN { for (i=0;i<40000;i++) printf \"界\" }'" });
          assert.equal(large.ok, true); assert.equal(large.output_budget.truncated, true);
          const fullCommand = JSON.parse(await readFile(large.output_budget.artifact_uri, 'utf8'));
          assert.equal(fullCommand.stdout, '界'.repeat(40000));
          const facts = JSON.parse(await readFile(join(dirname(large.output_budget.artifact_uri), 'metadata.json'), 'utf8'));
          assert.equal(facts.request.agentId, record.metadata.id); assert.equal(facts.request.sessionId, created.sessionId);
          assert.equal(facts.request.definition.name, 'run_command');
          for (const key of ['runId', 'turnId', 'scope', 'executionFence']) assert.equal(key in facts.request, false);
          const launched = await call('run_command', { command: 'printf background; /bin/sleep 5', background: true });
          assert.equal(launched.ok, true); const taskId = launched.task_id;
          const foreign = await second.ctx.get('tools').execute({ agent: second, callId: `foreign-command-${runtime}`,
            name: 'read_command_output', arguments: { task_id: taskId }, signal: new AbortController().signal });
          assert.equal(JSON.parse(foreign.value.result).ok, false);
          assert.equal((await call('stop_command', { task_id: taskId })).ok, true);
          const stopped = await call('read_command_output', { task_id: taskId, wait_seconds: 2 });
          assert.equal(stopped.status, 'canceled');
          setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'ask');
          let commandApprovals = 0;
          const removeCommandApproval = agent.ctx.on('approval/request', async () => ++commandApprovals === 1 ? 'allowed-once' : 'rejected');
          try {
            assert.equal((await call('run_command', { command: `printf once > ${runtime}-command-approved` })).ok, true);
            assert.equal((await call('run_command', { command: `printf no > ${runtime}-command-second` })).ok, false);
            assert.equal(commandApprovals, 2); assert.equal(existsSync(join(workspaceRoot, `${runtime}-command-second`)), false);
          } finally { removeCommandApproval(); }
          commandProof = { normalPhases, duplicateCount: (await readFile(join(workspaceRoot, counter), 'utf8')).length,
            fullOutputBytes: Buffer.byteLength(fullCommand.stdout), sessionOwnership: true, policyDenial: true,
            postPolicyPreserved: true, backgroundCanceled: stopped.status === 'canceled', oneShotApprovals: commandApprovals };
        } finally {
          removeCommandPre(); removeCommandGuard(); removeCommandAround(); removeCommandPost(); removeCommandResult();
        }
        assert.deepEqual(before, after, 'Both actual DSH policy phases must observe every admitted call.');
        const audits = agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome);
        assert.deepEqual(audits, ['rejected', 'allowed-once', 'rejected', 'rejected', 'allowed-once', 'rejected', 'cancelled', 'allowed-once', 'rejected']);
        report.runtimes.push({ runtime, agentId: record.metadata.id, sessionId: created.sessionId,
          registeredCalls: before.length, approvals: audits, crossSessionReadStateIsolated: true, parser: lint.syntax_engine.parser });
        report.runtimes.at(-1).web = webProof;
        report.runtimes.at(-1).commands = commandProof;
        report.runtimes.at(-1).components = components;
        report.runtimes.at(-1).skills = skillsProof;
        report.runtimes.at(-1).workflows = workflowProof;
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
