/** Actual packed Host/preset/DSH ToolRegistry proof, without a model request. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createAgentStore } from '../../src/agent-store.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';
import { bindDshInvocationContext } from '../../src/providers/dsh-invocation-context.mjs';
import { DatabaseSync } from 'node:sqlite';

export const name = 'studio-node-builtin-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer', 'sessionController'];
export async function apply(ctx, options) {
  const home = options.directory, workspaceRoot = join(home, 'workspace');
  const skillBackend = options.skillBackend ?? 'local_process', e2b = skillBackend === 'e2b';
  const commandBackend = options.commandBackend ?? 'local_process', e2bCommands = commandBackend === 'e2b';
  const previous = existsSync(join(home, 'proof.json')) ? JSON.parse(await readFile(join(home, 'proof.json'), 'utf8')) : null;
  const fullWebText = '完整网页输出 😀 中文 '.repeat(1200);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  let networkCalls = 0, pendingRequest; const skillRequests = [], a2aRequests = [];
  const githubRequests = [], knowledgeRequests = [], githubCommit = 'c'.repeat(40), githubTree = 'd'.repeat(40);
  const memoryRequests = [], memoryRows = () => {
    const db = new DatabaseSync(join(home, 'studio/legacy-memory/effects/effects.sqlite'));
    try { return db.prepare('SELECT * FROM legacy_memory_effects ORDER BY identity').all(); } finally { db.close(); }
  };
  const githubFiles = [['SKILL.md', Buffer.from('---\nname: packed-github-skill\ndescription: GitHub immutable 技能\nversion: 1.2.3\n---\nInstructions')],
    ['assets/.binary', Buffer.from([0, 255, 128, 13, 10])]];
  const githubBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const githubFetch = async (input, init) => {
    assert.equal(previous, null, 'cold original management receipts must not fetch GitHub again');
    const url = new URL(input); assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, undefined);
    init.signal.throwIfAborted(); githubRequests.push(url.pathname + url.search);
    let data;
    if (url.pathname === '/search/repositories') data = { items: [{ full_name: 'packed/repository', html_url: 'https://github.com/packed/repository',
      description: 'Packed GitHub source', default_branch: 'main', stargazers_count: 1, archived: false }] };
    else if (url.pathname === '/repos/packed/repository/commits/main') data = { sha: githubCommit };
    else if (url.pathname === `/repos/packed/repository/git/commits/${githubCommit}`) data = { sha: githubCommit, tree: { sha: githubTree } };
    else if (url.pathname === `/repos/packed/repository/git/trees/${githubTree}`) data = { sha: githubTree, truncated: false, tree: [
      { path: 'assets', mode: '040000', type: 'tree', sha: 'e'.repeat(40) },
      ...githubFiles.map(([path, bytes]) => ({ path, mode: '100644', type: 'blob', sha: githubBlob(bytes), size: bytes.length }))] };
    else if (url.pathname.startsWith('/repos/packed/repository/git/blobs/')) {
      const file = githubFiles.find(([, bytes]) => url.pathname.endsWith('/' + githubBlob(bytes))); assert.ok(file, url.pathname);
      data = { sha: githubBlob(file[1]), size: file[1].length, encoding: 'base64', content: file[1].toString('base64') + '\n' };
    } else assert.fail(`Unexpected GitHub endpoint: ${url.pathname}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const a2aSpec = { local_name: 'research', binding_id: 'packed-a2a', space_id: 'packed-a2a-space',
    target_agent_id: 'a2a-agent-packed', expected_version_id: 'packed-v1', exposure: 'tool' };
  const web = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/agentengine/api/v1/ListAToASpaceAgents' || url.pathname === '/a2a/rpc') {
      a2aRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
        const body = JSON.parse(raw); a2aRequests.at(-1).body = body;
        assert.equal(req.headers.authorization, 'Bearer packed-a2a-synthetic-token');
        if (url.pathname.startsWith('/agentengine/')) {
          assert.equal(body.A2ASpaceId, a2aSpec.space_id);
          res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Code: 0, Data: { Agents: [{
            A2AAgentId: a2aSpec.target_agent_id, VersionId: a2aSpec.expected_version_id, Source: 'hosted', AgentCard: {
              name: 'research', description: 'Packed remote', capabilities: { streaming: true }, supportedInterfaces: [{
                url: webOrigin + '/a2a/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] } }] } })); return;
        }
        assert.equal(body.method, 'SendStreamingMessage'); assert.equal(body.params.message.parts[0].text, 'Packed remote 😀');
        res.setHeader('Content-Type', 'text/event-stream');
        const task = { id: 'packed-remote-task', contextId: 'packed-context', status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'result', parts: [{ text: 'Packed A2A reply 😀' }] }] };
        res.end('id: 1\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task } }) + '\r\n\r\n');
      }); return;
    }
    if (url.pathname === '/ltm/memories' || url.pathname === '/ltm/memories/search') {
      assert.equal(previous, null, 'cold Memory receipt must not issue another request');
      const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); memoryRequests.push({ path: url.pathname, payload });
        assert.equal(payload.user_id, 'packed-user');
        if (url.pathname.endsWith('/search')) { assert.equal(payload.query, 'Packed Memory 😀'); res.end(JSON.stringify({ memories: ['Packed Memory 😀'] })); }
        else { assert.equal(JSON.parse(payload.events[0]).parts[0].text, 'Packed Memory 😀'); assert.equal(payload.flush, true); res.end('{}'); }
      }); return;
    }
    if (url.pathname === '/agentengine/api/v1/RetrieveKnowledge') {
      let raw = ''; req.on('data', bytes => { raw += bytes; }); req.on('end', () => {
        assert.equal(previous, null, 'cold knowledge receipt must not issue another request');
        const payload = JSON.parse(raw); assert.equal(payload.DatasetId, 'packed-kb'); assert.equal(payload.Query, '完整知识查询😀'.repeat(60));
        assert.deepEqual(payload.RetrievalModel, { SearchMethod: 'intelligence_search', TopK: 5, RerankingEnable: false });
        knowledgeRequests.push(payload);
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Records: [{ Segment: {
          Content: 'Packed Knowledge 😀', Answer: '实际回答', Document: { Name: '来源文档' } } }] }));
      }); return;
    }
    networkCalls++;
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
  await new Promise(resolve => web.listen(previous ? Number(new URL(previous.webOrigin).port) : 0, '127.0.0.1', resolve));
  ctx.effect(() => () => { web.closeAllConnections(); return new Promise(resolve => web.close(resolve)); }, 'Node web proof server');
  const webOrigin = `http://127.0.0.1:${web.address().port}`;
  await mkdir(workspaceRoot, { recursive: true });
  if (!previous) await writeFile(join(workspaceRoot, 'browser-proof.html'), `<!doctype html><title>Packed Browser 😀</title>
    <button id="count" onclick="this.textContent='clicked:'+ ++window.count">Start</button>
    <canvas width="1000" height="400" style="background:#112233"></canvas><div style="position:absolute;top:150px;left:50px">HUD</div>
    <script>window.count=0;</script>`);
  await writeFile(join(home, 'outside.txt'), 'Outside the workspace.');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'builtin-proof',
    provider: 'openai-compatible', modelName: 'unused', baseUrl: 'http://127.0.0.1:9/v1', default: true,
    credentialName: 'BUILTIN_PROOF_KEY' }], modelProfileKeys: { BUILTIN_PROOF_KEY: 'synthetic-unused' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  const tools = ['workspace_status', 'list_workspace_files', 'read_workspace_file', 'write_workspace_file',
    'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'lint_workspace_file',
    'search_workspace_files', 'delete_workspace_file', 'web_fetch', 'web_search',
    'sandbox_status', 'run_command', 'read_command_output', 'stop_command', 'run_code', 'component_status', 'browser_inspect_workspace',
    'list_skill_spaces', 'list_skills', 'search_skills', 'preview_skill', 'load_skill', 'execute_skills', 'list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent',
    'skill_discover_github', 'skill_install', 'skill_bind_agent', 'search_knowledge_base', 'load_memory', 'save_memory'];
  const records = [];
  if (previous) for (const row of previous.runtimes) { const record = await agents.get(row.agentId); assert.ok(record); records.push(record); }
  else for (const runtime of ['dsh-native', 'codex']) records.push(await agents.create({ name: `Node builtin ${runtime}`,
    runtimeType: runtime, spec: { bindings: { tools, modelProfileId: 'builtin-proof', a2a: [a2aSpec],
      plugins: [{ config: { binding: { resource: { kind: 'knowledge-base', id: 'packed-kb' } } } }] } } }));
  await mountStudioHost(ctx, { configurationHome: home, githubSkillSourceFetch: githubFetch, env: { AGENTKIT_HOME: home, PATH: process.env.PATH,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, KSADK_WEB_SSRF_POLICY_JSON: '{"allowPrivate":true}',
    KSADK_KB_ENDPOINT: webOrigin,
    KSADK_LTM_BACKEND: 'http', KSADK_LTM_HTTP_URL: `${webOrigin}/ltm`,
    AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE: options.browserExecutablePath,
    KSADK_WEB_SEARCH_PROVIDER: 'http', KSADK_WEB_SEARCH_BASE_URL: `${webOrigin}/search`,
    KSADK_SKILL_SPACE_IDS: 'packed-space', KSADK_SKILL_SERVICE_URL: `${webOrigin}/skills/api/v1`,
    KSADK_SKILL_SERVICE_TOKEN: 'builtin-skill-read-token', KSADK_SKILL_RUNTIME_BACKEND: skillBackend,
    KSADK_SANDBOX_BACKEND: commandBackend, KSADK_SANDBOX_TIMEOUT: '20',
    KSADK_A2A_SERVICE_URL: webOrigin, KSADK_A2A_SERVICE_TOKEN: 'packed-a2a-synthetic-token', KSADK_A2A_ALLOW_PRIVATE: 'true',
    KSADK_SKILL_RUNTIME_TIMEOUT: '20', ...(e2b || e2bCommands ? { KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'node-skill-proof-template',
      E2B_API_URL: 'https://127.0.0.1:9', E2B_DOMAIN: 'e2b-proof.synthetic', E2B_API_KEY: 'e2b-proof-not-a-real-key' } : {}) } });
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
    const proofFile = previous ? 'cold-proof.json' : 'proof.json';
    void prove().then(report => writeFile(join(home, proofFile), JSON.stringify(report, null, 2)),
      error => writeFile(join(home, proofFile), JSON.stringify({ passed: false, code: error.code,
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
    if (previous) {
      const restored = [], restoredCommands = [], restoredCodes = [], restoredA2a = [], restoredBrowsers = [], restoredManagement = [], restoredKnowledge = [], restoredMemory = [];
      for (const row of previous.runtimes) {
        const found = await ctx.sessionController.resolveAgent(row.sessionId); assert.ok(found.agent, found.error?.message || JSON.stringify(found.error));
        const agent = found.agent; assert.equal(agent.session.id, row.sessionId); setSandboxMode(agent.session, 'workspace-write');
        bindDshInvocationContext(agent, { userId: 'packed-user', runnerType: row.runtime });
        agent.session.append('turn/start', { turn: 2 });
        try {
          const beforeMemory = memoryRows();
          for (const saved of row.memory.rows) {
            const original = JSON.parse(saved.request), content = JSON.parse(saved.result).content;
            const recovered = await agent.ctx.get('tools').execute({ agent, callId: original.owner.identity.callId,
              name: original.request.name, arguments: original.request.arguments, signal: new AbortController().signal });
            assert.equal(recovered.isError, false, JSON.stringify(recovered));
            assert.deepEqual(typeof content === 'string' ? recovered.value.result : JSON.parse(recovered.value.result), content);
          }
          assert.deepEqual(memoryRows(), beforeMemory);
          restoredMemory.push({ runtime: row.runtime, unchanged: true });
          const knowledgeBytes = await readFile(row.knowledge.record), knowledgeSaved = JSON.parse(knowledgeBytes);
          const knowledgeRecovered = await agent.ctx.get('tools').execute({ agent, callId: knowledgeSaved.request.call.callId,
            name: 'search_knowledge_base', arguments: knowledgeSaved.request.call.arguments, signal: new AbortController().signal });
          assert.equal(knowledgeRecovered.isError, false); assert.equal(knowledgeRecovered.value.result, knowledgeSaved.result.content);
          assert.ok((await readFile(row.knowledge.record)).equals(knowledgeBytes));
          restoredKnowledge.push({ runtime: row.runtime, unchanged: true });
          for (const file of [row.management.installRecord, row.management.bindRecord]) {
            const bytes = await readFile(file), saved = JSON.parse(bytes);
            const recovered = await agent.ctx.get('tools').execute({ agent, callId: saved.request.call.callId,
              name: saved.request.call.name, arguments: saved.request.call.arguments, signal: new AbortController().signal });
            assert.equal(recovered.isError, false, JSON.stringify(recovered));
            assert.deepEqual(JSON.parse(recovered.value.result), saved.result.content);
            assert.ok((await readFile(file)).equals(bytes));
          }
          assert.equal((await agents.get(row.agentId)).metadata.revision, 2);
          restoredManagement.push({ runtime: row.runtime, resourceId: row.management.resourceId, revision: 2, unchanged: true });
          if (row.browser.enabled) {
            const recordBytes = await readFile(row.browser.record), saved = JSON.parse(recordBytes);
            const image = await readFile(join(workspaceRoot, saved.result.content.screenshot_path));
            const recovered = await agent.ctx.get('tools').execute({ agent, callId: saved.request.call.callId,
              name: 'browser_inspect_workspace', arguments: saved.request.call.arguments, signal: new AbortController().signal });
            assert.equal(recovered.isError, false); assert.deepEqual(JSON.parse(recovered.value.result), saved.result.content);
            assert.equal(saved.result.content.title, 'Packed Browser 😀');
            assert.ok((await readFile(row.browser.record)).equals(recordBytes));
            assert.ok((await readFile(join(workspaceRoot, saved.result.content.screenshot_path))).equals(image));
            restoredBrowsers.push({ runtime: row.runtime, recordSha256: sha256(recordBytes), imageSha256: sha256(image), unchanged: true });
          }
          const a2aBytes = await readFile(row.a2a.record), a2aRecord = JSON.parse(a2aBytes), remoteBytes = await readFile(row.a2a.remoteRecord);
          const a2aCold = await agent.ctx.get('tools').execute({ agent, callId: a2aRecord.request.call.callId, name: 'call_a2a_agent',
            arguments: a2aRecord.request.call.arguments, signal: new AbortController().signal });
          assert.equal(a2aCold.isError, false); assert.deepEqual(JSON.parse(a2aCold.value.result), a2aRecord.result.content);
          assert.ok((await readFile(row.a2a.record)).equals(a2aBytes)); assert.ok((await readFile(row.a2a.remoteRecord)).equals(remoteBytes));
          restoredA2a.push({ runtime: row.runtime, agentId: row.agentId, sessionId: row.sessionId, taskId: row.a2a.taskId,
            recordSha256: sha256(a2aBytes), remoteSha256: sha256(remoteBytes), unchanged: true });
          if (e2b) {
            const recordBytes = await readFile(row.workflows.record), record = JSON.parse(recordBytes);
            const ownerRoot = join(dirname(row.workflows.record), 'sandbox'), owners = await readdir(ownerRoot); assert.equal(owners.length, 1);
            const ownerPath = join(ownerRoot, owners[0], 'owner.json'), ownerBytes = await readFile(ownerPath);
            assert.equal(record.request.call.callId, `workflow-original-${row.runtime}`);
            const cold = await agent.ctx.get('tools').execute({ agent, callId: record.request.call.callId, name: 'execute_skills',
              arguments: record.request.call.arguments, signal: new AbortController().signal });
            assert.equal(cold.isError, false); assert.deepEqual(JSON.parse(cold.value.result), record.result);
            assert.ok((await readFile(row.workflows.record)).equals(recordBytes)); assert.ok((await readFile(ownerPath)).equals(ownerBytes));
            restored.push({ runtime: row.runtime, agentId: row.agentId, sessionId: row.sessionId, runtimeId: record.runtimeId,
              taskId: record.taskId, recordSha256: sha256(recordBytes), ownerSha256: sha256(ownerBytes), unchanged: true });
          }
          if (e2bCommands) {
            const bytes = await readFile(row.commands.record), record = JSON.parse(bytes);
            const ownerRoot = join(dirname(dirname(row.commands.record)), 'e2b-sandbox'), names = await readdir(ownerRoot);
            assert.equal(names.length, 1); const ownerPath = join(ownerRoot, names[0], 'owner.json'), ownerBytes = await readFile(ownerPath);
            const cold = await agent.ctx.get('tools').execute({ agent, callId: record.request.call.callId, name: 'run_command',
              arguments: record.request.call.arguments, signal: new AbortController().signal });
            assert.equal(cold.isError, false); assert.deepEqual(JSON.parse(cold.value.result), record.result.content);
            assert.ok((await readFile(row.commands.record)).equals(bytes)); assert.ok((await readFile(ownerPath)).equals(ownerBytes));
            restoredCommands.push({ runtime: row.runtime, agentId: row.agentId, sessionId: row.sessionId, taskId: record.taskId,
              recordSha256: sha256(bytes), ownerSha256: sha256(ownerBytes), unchanged: true });
            const codeBytes = await readFile(row.code.record), code = JSON.parse(codeBytes);
            const codeOwnerRoot = join(dirname(dirname(row.code.record)), 'code-sandbox'), codeNames = await readdir(codeOwnerRoot);
            assert.equal(codeNames.length, 1); const codeOwnerPath = join(codeOwnerRoot, codeNames[0], 'owner.json'), codeOwnerBytes = await readFile(codeOwnerPath);
            const coldCode = await agent.ctx.get('tools').execute({ agent, callId: code.request.call.callId, name: 'sandbox_run_code',
              arguments: code.request.call.arguments, signal: new AbortController().signal });
            assert.equal(coldCode.isError, false); assert.deepEqual(JSON.parse(coldCode.value.result), code.result.content);
            assert.ok((await readFile(row.code.record)).equals(codeBytes)); assert.ok((await readFile(codeOwnerPath)).equals(codeOwnerBytes));
            restoredCodes.push({ runtime: row.runtime, agentId: row.agentId, sessionId: row.sessionId, taskId: code.taskId,
              recordSha256: sha256(codeBytes), ownerSha256: sha256(codeOwnerBytes), unchanged: true });
          }
        } finally { agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } }); assert.equal(await ctx.sessions.flush(agent.session), true); }
      }
      assert.equal(networkCalls, 0); assert.equal(skillRequests.length, 0); assert.equal(a2aRequests.length, 0);
      assert.equal(githubRequests.length, 0);
      return { passed: true, pid: process.pid, previousPid: previous.pid, node: process.version, restored, restoredCommands, restoredCodes, restoredA2a, restoredBrowsers,
        restoredManagement, restoredKnowledge, restoredMemory, memoryRequests: memoryRequests.length, knowledgeRequests: knowledgeRequests.length, githubRequests: 0, networkCalls, skillRequests: 0, a2aRequests: 0 };
    }
    const report = { passed: false, pid: process.pid, webOrigin, node: process.version, path: process.env.PATH, runtimes: [] };
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
        assert.equal(components.summary.knowledge_base_bound, true); assert.equal(components.summary.long_term_memory_bound, false);
        assert.equal(components.summary.skill_space_bound, true); assert.equal(components.summary.isolated_execution, e2b || e2bCommands ? 'enabled' : 'not_enabled');
        assert.equal(components.skill_runtime.backend, skillBackend); assert.equal(components.skill_runtime.template_bound, e2b);
        assert.equal(components.sandbox.backend, commandBackend); assert.equal(components.sandbox.enabled, true);
        assert.equal(components.sandbox.template_bound, e2bCommands);
        assert.deepEqual(components.sandbox.tools, ['sandbox_status', 'run_command', 'read_command_output', 'stop_command', ...(e2bCommands ? ['sandbox_run_code'] : [])]);
        assert.deepEqual([...components.workspace.tools].sort(), tools.filter(name => name.includes('workspace') && name !== 'browser_inspect_workspace').sort());
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
          assert.equal(workflowResult.backend, skillBackend); assert.equal(workflowResult.isolated, e2b);
          if (e2b) {
            assert.equal(workflowResult.ok, false); assert.equal(workflowResult.status, 'uncertain');
            assert.equal(workflowResult.error_type, 'e2b_sandbox_outcome_unknown'); assert.deepEqual(workflowResult.command_ids, []);
          } else { assert.equal(workflowResult.ok, true, JSON.stringify(workflowResult)); assert.equal(workflowResult.command_ids.length, 1); }
          const deniedAgain = await call('execute_skills', workflowArgs); assert.equal(deniedAgain.ok, false);
          assert.equal(workflowApprovals, 2);
        } finally { removeWorkflowApproval(); }
        setSandboxMode(agent.session, 'workspace-write');
        const duplicateWorkflow = await invokeWorkflow(); assert.equal(duplicateWorkflow.isError, false);
        assert.deepEqual(JSON.parse(duplicateWorkflow.value.result), workflowResult);
        if (e2b) { assert.equal(workflowResult.output_files, undefined); assert.equal(workflowResult.sandbox.creation_status, 'unknown'); }
        else {
          const artifactBytes = await Promise.all(workflowResult.output_files.map(file => readFile(file)));
          assert.equal(artifactBytes.length, 2);
          assert.ok(artifactBytes.some(bytes => bytes.equals(Buffer.from('Packed workflow 😀'))));
          assert.ok(artifactBytes.some(bytes => bytes.equals(Buffer.from([0, 1, 255]))));
        }
        const workflowRoot = join(home, 'studio/builtin-workspace/skill-workflows');
        const workflowRecords = [];
        for (const path of await readdir(workflowRoot, { recursive: true })) if (path.endsWith('record.json')) {
          const file = join(workflowRoot, path), value = JSON.parse(await readFile(file, 'utf8'));
          if (value.contract === (e2b ? 'agentkit.dsh-skill-e2b-runtime/v1' : 'agentkit.dsh-local-skill-runtime/v1')
            && value.request.agentId === record.metadata.id) workflowRecords.push({ file, value });
        }
        assert.equal(workflowRecords.length, 1); const workflowRecord = workflowRecords[0];
        assert.equal(workflowRecord.value.request.sessionId, created.sessionId); assert.equal(workflowRecord.value.request.callId, workflowId);
        assert.equal(workflowRecord.value.runtimeId, workflowResult.runtime_id); assert.equal(workflowRecord.value.phase, 'finished');
        for (const key of ['scope', 'runId', 'turnId', 'buildId', 'executionFence']) assert.equal(key in workflowRecord.value.request, false);
        if (e2b) {
          assert.equal(existsSync(join(dirname(workflowRecord.file), 'work/effect')), false);
          const owners = join(dirname(workflowRecord.file), 'sandbox'), names = await readdir(owners);
          assert.equal(names.length, 1); const owner = JSON.parse(await readFile(join(owners, names[0], 'owner.json'), 'utf8'));
          assert.equal(owner.schemaVersion, 'agentkit.dsh-e2b-sandbox-owner/v1'); assert.equal(owner.phase, 'unknown');
          assert.equal(owner.agentId, record.metadata.id); assert.equal(owner.sessionId, created.sessionId);
          assert.equal(owner.createIdentity.callId, workflowId); assert.equal(owner.sandboxId, null);
          assert.equal(owner.scope, undefined); assert.equal(owner.createIdentity.executionFence, undefined);
        } else assert.equal(await readFile(join(dirname(workflowRecord.file), 'work/effect'), 'utf8'), 'x');
        const removeWorkflowPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'execute_skills'
          ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted workflow result' }] } : next());
        try {
          const redacted = await invokeWorkflow(); assert.equal(redacted.isError, false);
          assert.deepEqual(redacted.content, [{ type: 'text', text: 'Host-redacted workflow result' }]);
        } finally { removeWorkflowPost(); }
        assert.equal(skillRequests.length - startWorkflowRequests, 2);
        const workflowProof = { runtimeId: workflowResult.runtime_id, taskId: workflowResult.task_id, backend: skillBackend,
          ...(e2b ? { refusedSdkCreation: true, commands: 0, outcomeUnknown: true } : { executedOnce: true, exactArtifacts: true }),
          serviceRequests: 2, originalDshOwner: true, oneShotApprovals: workflowApprovals,
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
          if (e2bCommands) {
            const status = await call('sandbox_status', {}); assert.equal(status.backend, 'e2b'); assert.equal(status.isolated, true);
            assert.equal(status.sandbox_phase, 'absent'); commandPhases.length = 0;
            const command = `printf forbidden > ${runtime}-must-not-run-locally`, callId = `command-original-${runtime}`;
            const invoke = (args = { command }, id = callId) => registry.execute({ agent, callId: id, name: 'run_command',
              arguments: args, signal: new AbortController().signal });
            const first = await invoke(); assert.equal(first.isError, false); const result = JSON.parse(first.value.result);
            assert.equal(result.ok, false); assert.equal(result.error_type, 'e2b_sandbox_outcome_unknown');
            assert.equal(result.agentId, record.metadata.id); assert.equal(result.sessionId, created.sessionId);
            assert.match(result.task_id, /^[a-f0-9]{64}$/u); assert.equal(result.executionFence, undefined);
            const normalPhases = [...commandPhases]; assert.deepEqual(normalPhases, ['pre', 'guard', 'around', 'post', 'result']);
            assert.deepEqual(JSON.parse((await invoke()).value.result), result);
            assert.equal(JSON.parse((await invoke({ command: 'changed' })).value.result).error_type, 'dsh_node_command_call_identity_conflict');
            const commandRoot = join(home, 'studio/builtin-workspace/commands'), records = [];
            for (const path of await readdir(commandRoot, { recursive: true })) if (/^[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/record\.json$/u.test(path.split(sep).join('/'))) {
              const file = join(commandRoot, path), value = JSON.parse(await readFile(file, 'utf8'));
              if (value.request.agentId === record.metadata.id && value.request.call.callId === callId) records.push({ file, value });
            }
            assert.equal(records.length, 1); const original = records[0];
            assert.equal(original.value.phase, 'finished'); assert.equal(original.value.taskId, result.task_id);
            assert.equal(original.value.binding.backend, 'e2b'); assert.deepEqual(original.value.result.content, result);
            for (const key of ['scope', 'runId', 'turnId', 'buildId', 'executionFence']) assert.equal(key in original.value.request, false);
            const ownerRoot = join(dirname(dirname(original.file)), 'e2b-sandbox'), names = await readdir(ownerRoot); assert.equal(names.length, 1);
            const owner = JSON.parse(await readFile(join(ownerRoot, names[0], 'owner.json'), 'utf8'));
            assert.equal(owner.schemaVersion, 'agentkit.dsh-e2b-sandbox-owner/v1'); assert.equal(owner.agentId, record.metadata.id);
            assert.equal(owner.sessionId, created.sessionId); assert.equal(owner.phase, 'unknown'); assert.equal(owner.sandboxId, null);
            commandDeny = true;
            assert.equal((await invoke({ command }, `command-guard-${runtime}`)).isError, true); commandDeny = false;
            commandRedact = true; const redacted = await invoke(); assert.equal(redacted.isError, false);
            assert.deepEqual(redacted.content, [{ type: 'text', text: 'Host-redacted command output' }]); commandRedact = false;
            const foreign = await second.ctx.get('tools').execute({ agent: second, callId: `foreign-command-${runtime}`,
              name: 'read_command_output', arguments: { task_id: result.task_id }, signal: new AbortController().signal });
            assert.equal(JSON.parse(foreign.value.result).ok, false);
            assert.equal((await call('stop_command', { task_id: result.task_id })).ok, false, 'unknown creation is not a granted command');
            setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'ask'); let commandApprovals = 0;
            const removeApproval = agent.ctx.on('approval/request', async () => ++commandApprovals === 1 ? 'allowed-once' : 'rejected');
            try {
              const approved = await call('run_command', { command: 'printf approved' }); assert.equal(approved.ok, false);
              assert.equal(approved.error_type, 'e2b_sandbox_outcome_unknown');
              assert.equal((await call('run_command', { command: 'printf denied' })).ok, false); assert.equal(commandApprovals, 2);
            } finally { removeApproval(); }
            assert.equal(existsSync(join(workspaceRoot, `${runtime}-must-not-run-locally`)), false);
            commandProof = { backend: 'e2b', normalPhases, taskId: result.task_id, record: original.file,
              creationUnknown: true, duplicateSuppressed: true, noLocalEffect: true, originalDshOwner: true,
              sessionOwnership: true, policyDenial: true, postPolicyPreserved: true, oneShotApprovals: commandApprovals };
          } else {
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
          commandProof.backend = 'local_process';
          }
        } finally {
          removeCommandPre(); removeCommandGuard(); removeCommandAround(); removeCommandPost(); removeCommandResult();
        }
        let codeProof;
        setSandboxMode(agent.session, 'workspace-write');
        const snippet = { code: 'printf must-not-run-locally', language: 'bash' }, codeCallId = `code-original-${runtime}`;
        const invokeCode = () => registry.execute({ agent, callId: codeCallId, name: 'sandbox_run_code', arguments: snippet, signal: new AbortController().signal });
        const codeResult = await invokeCode(); assert.equal(codeResult.isError, false);
        const code = JSON.parse(codeResult.value.result); assert.equal(code.ok, false);
        if (e2bCommands) {
          assert.equal(code.status, 'uncertain'); assert.match(code.task_id, /^[a-f0-9]{64}$/u);
          const base = join(home, 'studio/builtin-workspace/commands');
          const records = (await readdir(base, { recursive: true })).filter(path => /^[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/record\.json$/u.test(path));
          const found = [];
          for (const path of records) { const file = join(base, path), saved = JSON.parse(await readFile(file, 'utf8'));
            if (saved.owner.agentId === record.metadata.id && saved.request.call.callId === codeCallId) found.push({ file, saved }); }
          assert.equal(found.length, 1); const original = found[0]; assert.equal(original.saved.request.call.name, 'sandbox_run_code');
          assert.equal(original.saved.taskId, code.task_id); assert.equal(original.saved.binding.contract, 'agentkit.dsh-node-e2b-code-tools/v1');
          assert.deepEqual(JSON.parse((await invokeCode()).value.result), code);
          assert.equal(original.saved.request.agentId, record.metadata.id); assert.equal(original.saved.request.scope, undefined);
          const ownerRoot = join(dirname(dirname(original.file)), 'code-sandbox'), ownerNames = await readdir(ownerRoot); assert.equal(ownerNames.length, 1);
          const owner = JSON.parse(await readFile(join(ownerRoot, ownerNames[0], 'owner.json'), 'utf8'));
          assert.equal(owner.phase, 'unknown'); assert.equal(owner.sandboxId, null);
          codeProof = { backend: 'e2b', record: original.file, taskId: code.task_id, creationUnknown: true, duplicateSuppressed: true, originalDshOwner: true };
        } else {
          assert.equal(code.error_type, 'isolated_sandbox_required'); assert.equal(code.executed, false);
          codeProof = { backend: 'local_process', isolatedSandboxRequired: true, executed: false };
        }
        setSandboxMode(agent.session, 'workspace-write');
        const startA2a = a2aRequests.length;
        assert.equal((await call('list_a2a_agents', {})).agents[0].agent_id, a2aSpec.target_agent_id);
        assert.equal((await call('get_a2a_agent_card', { agent: 'research' })).agent.agent_id, a2aSpec.target_agent_id);
        const a2aArgs = { agent: 'research', message: 'Packed remote 😀' }, a2aCallId = 'a2a-original-' + runtime;
        const invokeA2a = () => registry.execute({ agent, callId: a2aCallId, name: 'call_a2a_agent', arguments: a2aArgs, signal: new AbortController().signal });
        const a2aFirst = await invokeA2a(); assert.equal(a2aFirst.isError, false);
        const a2aResult = JSON.parse(a2aFirst.value.result); assert.equal(a2aResult.ok, true, JSON.stringify(a2aResult));
        assert.equal(a2aResult.reply, 'Packed A2A reply 😀'); assert.equal(a2aRequests.length - startA2a, 4);
        assert.deepEqual(JSON.parse((await invokeA2a()).value.result), a2aResult); assert.equal(a2aRequests.length - startA2a, 4);
        const a2aFiles = [];
        const a2aRoot = join(home, 'studio/builtin-workspace/a2a');
        for (const path of await readdir(a2aRoot, { recursive: true })) if (path.endsWith('.json')) {
          const file = join(a2aRoot, path), value = JSON.parse(await readFile(file, 'utf8'));
          if (value.owner?.agentId === record.metadata.id) a2aFiles.push({ file, value });
        }
        const dshA2a = a2aFiles.find(row => row.value.request?.call?.callId === a2aCallId);
        const remoteA2a = a2aFiles.find(row => row.value.contract === 'agentkit.studio-dsh-a2a-host/v1');
        assert.ok(dshA2a); assert.ok(remoteA2a); assert.equal(dshA2a.value.phase, 'finished'); assert.equal(remoteA2a.value.phase, 'terminal');
        assert.equal(dshA2a.value.binding.contract, 'agentkit.dsh-node-a2a-tools/v1');
        assert.equal(dshA2a.value.request.sessionId, created.sessionId); assert.equal(dshA2a.value.request.agentRevision, record.metadata.revision);
        assert.equal(remoteA2a.value.request.dsh.call.callId, a2aCallId); assert.equal(remoteA2a.value.request.native, undefined);
        assert.equal(remoteA2a.value.platformTaskId, a2aResult.task_id);
        const a2aDenied = agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'call_a2a_agent' ? { kind: 'deny', reason: 'A2A policy proof' } : next());
        try { assert.equal((await invokeA2a()).isError, true); } finally { a2aDenied(); }
        assert.equal(a2aRequests.length - startA2a, 4);
        const a2aPost = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'call_a2a_agent'
          ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted A2A result' }] } : next());
        try { assert.deepEqual((await invokeA2a()).content, [{ type: 'text', text: 'Host-redacted A2A result' }]); } finally { a2aPost(); }
        setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'ask'); let a2aApprovals = 0;
        const a2aApproval = agent.ctx.on('approval/request', async () => ++a2aApprovals === 1 ? 'allowed-once' : 'rejected');
        try {
          assert.deepEqual(JSON.parse((await invokeA2a()).value.result), a2aResult);
          assert.equal((await call('call_a2a_agent', a2aArgs)).ok, false); assert.equal(a2aApprovals, 2);
        } finally { a2aApproval(); }
        assert.equal(a2aRequests.length - startA2a, 4);
        const a2aProof = { taskId: a2aResult.task_id, reply: a2aResult.reply, record: dshA2a.file, remoteRecord: remoteA2a.file,
          serviceRequests: 3, sends: 1, originalDshOwner: true, duplicateSuppressed: true, policyDeniedWithoutRequest: true,
          postPolicyPreserved: true, oneShotApprovals: a2aApprovals };
        setSandboxMode(agent.session, 'workspace-write');
        let browserProof;
        const browserArgs = { path: 'browser-proof.html', wait_ms: 0, screenshot_path: `.artifacts/browser-${runtime}.png`,
          actions: [{ type: 'click', selector: '#count', button: 'left', duration_ms: 10 }] };
        if (e2bCommands) {
          const disabled = await call('browser_inspect_workspace', browserArgs);
          assert.equal(disabled.error_type, 'BROWSER_LOCAL_BACKEND_REQUIRED'); browserProof = { enabled: false, disabledUnderE2b: true };
        } else {
          const browserCall = `browser-original-${runtime}`;
          const inspect = () => registry.execute({ agent, callId: browserCall, name: 'browser_inspect_workspace',
            arguments: browserArgs, signal: new AbortController().signal });
          const first = await inspect(); assert.equal(first.isError, false);
          const value = JSON.parse(first.value.result); assert.equal(value.ok, true, JSON.stringify(value));
          assert.equal(value.title, 'Packed Browser 😀'); assert.match(value.body_text_preview, /clicked:1/);
          assert.equal(value.canvas_metrics[0].visually_uniform, true); assert.equal(value.visual_warnings.length, 1);
          const image = await readFile(join(workspaceRoot, value.screenshot_path)); assert.equal(image.subarray(1, 4).toString(), 'PNG');
          assert.deepEqual(JSON.parse((await inspect()).value.result), value);
          assert.ok((await readFile(join(workspaceRoot, value.screenshot_path))).equals(image));
          const paths = await readdir(join(home, 'studio/builtin-workspace/browser'), { recursive: true });
          let saved;
          for (const path of paths.filter(path => path.endsWith('record.json'))) {
            const file = join(home, 'studio/builtin-workspace/browser', path), record = JSON.parse(await readFile(file));
            if (record.request.call.callId === browserCall) saved = { file, record };
          }
          assert.ok(saved); assert.equal(saved.record.binding.contract, 'agentkit.dsh-node-browser/v1');
          assert.equal(saved.record.owner.sessionId, created.sessionId); assert.equal(saved.record.request.runId, undefined);
          const denyBrowser = agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'browser_inspect_workspace'
            ? { kind: 'deny', reason: 'Browser policy proof' } : next());
          try { assert.equal((await inspect()).isError, true); } finally { denyBrowser(); }
          const postBrowser = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'browser_inspect_workspace'
            ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted Browser result' }] } : next());
          try { assert.deepEqual((await inspect()).content, [{ type: 'text', text: 'Host-redacted Browser result' }]); } finally { postBrowser(); }
          setSandboxMode(agent.session, 'read-only'); setApprovalPolicy(agent.session, 'ask'); let approvals = 0;
          const approveBrowser = agent.ctx.on('approval/request', async () => ++approvals === 1 ? 'allowed-once' : 'rejected');
          try { assert.deepEqual(JSON.parse((await inspect()).value.result), value);
            assert.equal((await call('browser_inspect_workspace', browserArgs)).ok, false); assert.equal(approvals, 2);
          } finally { approveBrowser(); }
          browserProof = { enabled: true, record: saved.file, imageSha256: sha256(image), duplicateSuppressed: true,
            canvasUniform: true, policyDenied: true, postPolicyPreserved: true, oneShotApprovals: approvals };
        }
        setSandboxMode(agent.session, 'workspace-write');
        bindDshInvocationContext(agent, { userId: 'packed-user', runnerType: runtime });
        const memoryStart = memoryRequests.length, memoryIds = [];
        for (const [memoryName, memoryArgs] of [['save_memory', { content: 'Packed Memory 😀' }], ['load_memory', { query: 'Packed Memory 😀' }]]) {
          const callId = `builtin-proof-${memoryName}-${runtime}`; memoryIds.push(callId);
          const invoke = () => registry.execute({ agent, callId, name: memoryName, arguments: memoryArgs, signal: new AbortController().signal });
          const result = await invoke(); assert.equal(result.isError, false, JSON.stringify(result));
          if (memoryName === 'save_memory') assert.equal(JSON.parse(result.value.result).status, 'persisted');
          else assert.equal(result.value.result, '[1] Packed Memory 😀');
          assert.deepEqual(await invoke(), result);
          const deny = agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === memoryName ? { kind: 'deny', reason: 'Memory policy proof' } : next());
          try { assert.equal((await invoke()).isError, true); } finally { deny(); }
          const post = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === memoryName
            ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted Memory' }] } : next());
          try { assert.deepEqual((await invoke()).content, [{ type: 'text', text: 'Host-redacted Memory' }]); } finally { post(); }
        }
        assert.equal(memoryRequests.length - memoryStart, 2);
        const ownedMemoryRows = memoryRows().filter(row => memoryIds.includes(JSON.parse(row.request).owner.identity.callId));
        assert.equal(ownedMemoryRows.length, 2);
        for (const saved of ownedMemoryRows) {
          const original = JSON.parse(saved.request);
          assert.equal(original.owner.kind, 'dsh'); assert.equal(original.owner.identity.agentId, record.metadata.id);
          assert.equal(original.owner.identity.sessionId, agent.session.id); assert.equal(original.request.context.userId, 'packed-user');
          assert.equal(original.owner.request.binding.contract, 'agentkit.dsh-node-legacy-memory/v1');
        }
        const memoryProof = { rows: ownedMemoryRows, actualRequests: 2, originalDshOwner: true,
          duplicateSuppressed: true, policyDenied: true, postPolicyPreserved: true };
        const knowledgeId = `builtin-proof-knowledge-${runtime}`, knowledgeArgs = { query: '完整知识查询😀'.repeat(60) };
        const lookup = () => registry.execute({ agent, callId: knowledgeId, name: 'search_knowledge_base', arguments: knowledgeArgs, signal: new AbortController().signal });
        const knowledgeStart = knowledgeRequests.length, knowledgeResult = await lookup(); assert.equal(knowledgeResult.isError, false);
        assert.equal(knowledgeResult.value.result, '[1] (来源: 来源文档) Packed Knowledge 😀\n    答案: 实际回答');
        assert.deepEqual(await lookup(), knowledgeResult);
        const denyKnowledge = agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'search_knowledge_base'
          ? { kind: 'deny', reason: 'Knowledge policy proof' } : next());
        try { assert.equal((await lookup()).isError, true); } finally { denyKnowledge(); }
        const postKnowledge = agent.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'search_knowledge_base'
          ? { kind: 'accept', content: [{ type: 'text', text: 'Host-redacted knowledge' }] } : next());
        try { assert.deepEqual((await lookup()).content, [{ type: 'text', text: 'Host-redacted knowledge' }]); } finally { postKnowledge(); }
        assert.equal(knowledgeRequests.length - knowledgeStart, 1);
        let knowledgeRecord;
        const knowledgeRoot = join(home, 'studio/builtin-workspace/knowledge-calls');
        for (const relative of await readdir(knowledgeRoot, { recursive: true })) if (relative.endsWith('record.json')) {
          const file = join(knowledgeRoot, relative), value = JSON.parse(await readFile(file, 'utf8'));
          if (value.request.call.callId === knowledgeId) {
            assert.equal(value.binding.contract, 'agentkit.dsh-node-knowledge/v1'); assert.equal(value.owner.agentId, record.metadata.id);
            assert.equal(value.owner.sessionId, created.sessionId); assert.equal(value.request.runId, undefined);
            assert.equal(value.result.content, knowledgeResult.value.result); knowledgeRecord = file;
          }
        }
        assert.ok(knowledgeRecord);
        const knowledgeProof = { record: knowledgeRecord, actualRequests: 1, originalDshOwner: true,
          duplicateSuppressed: true, policyDenied: true, postPolicyPreserved: true };
        const githubStart = githubRequests.length;
        const searched = await call('skill_discover_github', { source: 'packed skill' });
        assert.equal(searched.mode, 'search'); assert.equal(searched.repositories[0].url, 'https://github.com/packed/repository');
        const inspection = await call('skill_discover_github', { source: 'https://github.com/packed/repository' });
        assert.equal(inspection.commit, githubCommit); assert.equal(inspection.candidates.length, 1);
        const installArgs = { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId };
        const installId = `builtin-proof-${++serial}`, install = () => registry.execute({ agent, callId: installId, name: 'skill_install',
          arguments: installArgs, signal: new AbortController().signal });
        const installedResult = await install(); assert.equal(installedResult.isError, false, JSON.stringify(installedResult));
        const installedSkill = JSON.parse(installedResult.value.result).installed_resource; assert.equal(installedSkill.name, 'packed-github-skill');
        assert.deepEqual(JSON.parse((await install()).value.result), JSON.parse(installedResult.value.result));
        const resource = await rpc('skills/list', {});
        assert.ok(resource.items.some(item => item.resourceId === installedSkill.resourceId));
        const bindArgs = { resource_id: installedSkill.resourceId }, bindId = `builtin-proof-${++serial}`;
        const bind = () => registry.execute({ agent, callId: bindId, name: 'skill_bind_agent', arguments: bindArgs, signal: new AbortController().signal });
        const boundResult = await bind(); assert.equal(boundResult.isError, false, JSON.stringify(boundResult));
        const boundSkill = JSON.parse(boundResult.value.result); assert.equal(boundSkill.revision, 2); assert.equal(boundSkill.effective_from, 'next_run');
        assert.deepEqual(JSON.parse((await bind()).value.result), boundSkill);
        assert.deepEqual(await agents.getRevision(record.metadata.id, 1), record);
        assert.equal((await agents.get(record.metadata.id)).metadata.revision, 2);
        const nextPreset = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
        assert.notEqual(nextPreset.presetId, presetId);
        const nextSession = await ctx.sessionController.create({ sessionId: `node-managed-next-${runtime}`, cwd: workspaceRoot, agentPreset: nextPreset.presetId });
        const nextAgent = (await ctx.sessionController.resolveAgent(nextSession.sessionId)).agent; assert.ok(nextAgent);
        const nextSkill = await nextAgent.ctx.get('skills').get('packed-github-skill', { cwd: workspaceRoot, scope: nextAgent });
        assert.ok(nextSkill, 'new Agent revision must admit the installed Skill into the actual DSH SkillRegistry');
        assert.match(nextSkill.content, /Instructions/);
        const managementRoot = join(home, 'studio/builtin-workspace/skill-management-calls'), managementRecords = [];
        for (const relative of await readdir(managementRoot, { recursive: true })) if (relative.endsWith('record.json')) {
          const file = join(managementRoot, relative), value = JSON.parse(await readFile(file, 'utf8'));
          if (value.owner.agentId === record.metadata.id) managementRecords.push({ file, value });
        }
        assert.equal(managementRecords.length, 4);
        for (const { value } of managementRecords) {
          assert.equal(value.request.sessionId, created.sessionId); assert.equal(value.request.agentId, record.metadata.id);
          assert.equal(value.request.scope, undefined); assert.equal(value.request.runId, undefined); assert.equal(value.phase, 'finished');
          assert.equal(value.binding.contract, 'agentkit.dsh-skill-management/v1');
        }
        const privateRoot = join(home, 'studio/builtin-workspace/skill-management'), installedFiles = await readdir(privateRoot, { recursive: true });
        const binary = installedFiles.filter(path => path.endsWith('/assets/.binary'));
        assert.ok(binary.length >= 1);
        for (const path of binary) assert.deepEqual(await readFile(join(privateRoot, path)), githubFiles[1][1]);
        assert.equal(githubRequests.length - githubStart, 6);
        const managementProof = { commit: githubCommit, resourceId: installedSkill.resourceId, revision: 2, githubRequests: 6,
          exactBinary: true, originalDshOwner: true, duplicateSuppressed: true, oldRevisionPreserved: true, nextRevisionAdmitted: true,
          installRecord: managementRecords.find(item => item.value.request.call.callId === installId).file,
          bindRecord: managementRecords.find(item => item.value.request.call.callId === bindId).file };
        assert.deepEqual(before, after, 'Both actual DSH policy phases must observe every admitted call.');
        const audits = agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome);
        assert.deepEqual(audits, ['rejected', 'allowed-once', 'rejected', 'rejected', 'allowed-once', 'rejected', 'cancelled', 'allowed-once', 'rejected', 'allowed-once', 'rejected', ...(!e2bCommands ? ['allowed-once', 'rejected'] : [])]);
        report.runtimes.push({ runtime, agentId: record.metadata.id, sessionId: created.sessionId,
          registeredCalls: before.length, approvals: audits, crossSessionReadStateIsolated: true, parser: lint.syntax_engine.parser });
        report.runtimes.at(-1).web = webProof;
        report.runtimes.at(-1).commands = commandProof;
        report.runtimes.at(-1).code = codeProof;
        report.runtimes.at(-1).components = components;
        report.runtimes.at(-1).skills = skillsProof;
        report.runtimes.at(-1).workflows = workflowProof;
        report.runtimes.at(-1).a2a = a2aProof;
        report.runtimes.at(-1).browser = browserProof;
        report.runtimes.at(-1).management = managementProof;
        report.runtimes.at(-1).knowledge = knowledgeProof;
        report.runtimes.at(-1).memory = memoryProof;
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
