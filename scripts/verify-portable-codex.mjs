/** Opt-in real model + official DSH Host proof. Fixture MCP, no cloud deployment claim. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles, importPortableBundle, verifyPortableBundle } from '../src/portable-bundle.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => accept(server.address().port)); });
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(r => server.close(r)); return port; }

if (!process.argv.includes('--execute') || !option('--dsh-root')) {
  console.log('Usage: node scripts/verify-portable-codex.mjs --execute --dsh-root DSH_CHECKOUT [--model glm-5.3-flash] [--keep]. Uses configured model credentials and consumes inference usage.');
} else {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'agentkit-codex-portable-'));
  const log = await open(join(root, 'host.log'), 'w', 0o600);
  const children = new Set(), calls = [], nonce = randomUUID();
  const token = randomBytes(32).toString('hex'), mcpToken = randomBytes(32).toString('hex');
  const mcp = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${mcpToken}`) { res.writeHead(401).end(); return; }
    const server = new Server({ name: 'portable-card-proof', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'lookup_card', description: 'Read a card status and verification code.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      assert.equal(request.params.name, 'lookup_card'); assert.equal(request.params.arguments.id, 'Q7');
      calls.push('lookup_card');
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'ready', verification: nonce }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      res.on('close', () => { void transport.close(); void server.close(); });
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      await transport.handleRequest(req, res, buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  function command(executable, args, cwd, env, timeoutMs = 0) {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    children.add(child);
    const timer = timeoutMs ? setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, timeoutMs) : null;
    const done = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => { children.delete(child); code === 0 ? accept() : reject(Object.assign(new Error('Host command failed; inspect private log'), { code: 'HOST_COMMAND_FAILED' })); }); }).finally(() => clearTimeout(timer));
    // Long-lived Host rejection is checked by health probing and retained for cleanup.
    void done.catch(() => {});
    return { child, done };
  }
  try {
    const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async name => ({ value: process.env[name] }) } });
    const selected = await models.profile(option('--model') || 'glm-5.3-flash');
    const port = await listen(mcp), source = join(root, 'source'), skillRoot = join(source, 'skill');
    await mkdir(skillRoot, { recursive: true });
    const skillText = '---\nname: card-format\ndescription: Format card lookup answers\n---\nCard answers must include skill_tag: PEBBLE-42.\n';
    await writeFile(join(skillRoot, 'SKILL.md'), skillText);
    const agentId = `ar-local-${randomBytes(8).toString('hex')}`;
    const bindings = { modelProfileId: 'portable-model', mcpServers: ['card-mcp'], skills: ['card-format'] };
    const build = createStudioBuild({ storeDir: source });
    const built = await build.build({ agentId, agentName: 'Codex portable proof', revision: 1, metadata: { id: agentId, name: 'Codex portable proof', local: true, revision: 1 }, bindings,
      spec: { runtime: { type: 'codex' }, bindings, instructions: { system: '查询卡片必须使用绑定的 lookup_card 工具，按 Skill 格式回答。最终回答还须包含 route_tag: CLOUD-CODEX-71 及工具返回的核验码。' } } });
    const bundles = createPortableBundles({ storeDir: source, build,
      models: { profile: async () => ({ ...selected, credentialName: 'PORTABLE_MODEL_KEY', codexApi: 'chat-completions' }) },
      adapters: { describeMcp: async () => ({ resourceId: 'card-mcp', endpoint: `http://127.0.0.1:${port}/mcp`, envRefs: { Authorization: 'PORTABLE_MCP_AUTH' } }),
        loadSkill: async () => ({ definitions: [runtimeSkill({ name: 'card-format', content: skillText, path: join(skillRoot, 'SKILL.md') })] }) },
      configuration: { resolve: async () => ({ values: {} }) } });
    const exported = await bundles.prepare(agentId, built.id);
    const zip = Buffer.from((await bundles.download(agentId, built.id, exported.bundleId)).base64, 'base64');
    assert.equal(zip.includes(Buffer.from(selected.apiKey)), false);
    const home = join(root, 'target'), imported = await importPortableBundle(zip, home);
    assert.equal(verifyPortableBundle(zip).manifest.resources.profiles[0].codexApi, 'chat-completions');
    await rm(source, { recursive: true });
    const runtimePort = await freePort(), webPort = await freePort();
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { DSH_HOME: join(root, 'dsh'), AGENTKIT_HOME: home, AGENTKIT_RUNTIME_AGENT_ID: agentId,
      AGENTKIT_RUNTIME_BUILD_ID: imported.buildId, AGENTKIT_RUNTIME_TOKEN: token, AGENTKIT_RUNTIME_PORT: String(runtimePort),
      PORTABLE_MODEL_KEY: selected.apiKey, PORTABLE_MCP_AUTH: `Bearer ${mcpToken}` });
    const dshRoot = resolve(option('--dsh-root'));
    console.log(JSON.stringify({ phase: 'installing-fresh-profile', root }));
    await command('make', ['profile-install', `DSH_ROOT=${dshRoot}`, 'DSH_PROFILE=portable-codex-proof'], project, env, 300000).done;
    const host = command('node', ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'portable-codex-proof', '--host', '127.0.0.1', '--no-open', '--port', String(webPort)], dshRoot, env);
    const origin = `http://127.0.0.1:${runtimePort}`;
    let ready = false;
    for (let i = 0; i < 90; i++) {
      try { ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready || host.child.exitCode !== null) break;
      await sleep(1000);
    }
    assert.ok(ready, 'imported Host never became ready; inspect private host.log');
    console.log(JSON.stringify({ phase: 'running-blind-prompt', model: selected.modelName }));
    const started = Date.now();
    const response = await fetch(`${origin}/runs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '查询 Q7 卡片的状态，给我结论。', requestId: randomUUID(), sessionId: 'blind-card', stream: true }), signal: AbortSignal.timeout(180000) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const frames = stream.split('\n\n').filter(block => block.startsWith('event:')).map(block => ({ event: block.split('\n')[0].slice(7), data: JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6)) }));
    const completed = frames.find(frame => frame.event === 'run.completed');
    assert.ok(completed, `run failed: ${frames.find(frame => frame.event === 'run.failed')?.data?.code || 'missing completion'}`);
    for (const marker of ['CLOUD-CODEX-71', 'PEBBLE-42', nonce]) assert.ok(completed.data.output.includes(marker), 'system, Skill or live MCP result missing');
    assert.ok(calls.length > 0);
    const proof = { passed: true, scope: 'local-fresh-DSH-Host-real-Codex-model-fixture-MCP', model: selected.modelName, api: 'chat-completions',
      sourceRemoved: true, agentId, buildId: imported.buildId, bundleId: imported.bundleId, milliseconds: Date.now() - started,
      toolCalls: calls.length, assistantFrames: frames.filter(frame => frame.event === 'dsh.assistant').length,
      systemInstructionVerified: true, skillVerified: true, liveMcpResultVerified: true, tokenUsage: completed.data.tokenUsage };
    assert.ok(proof.assistantFrames > 1, 'streaming frames missing');
    await writeFile(join(root, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(proof));
  } catch (error) {
    console.error(JSON.stringify({ failed: true, code: error.code || 'E2E_FAILED', message: error instanceof assert.AssertionError ? error.message : 'Inspect the private proof directory', root }));
    process.exitCode = 1;
  } finally {
    for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    mcp.closeAllConnections(); await new Promise(r => mcp.close(r));
    await log.close();
    if (!process.argv.includes('--keep') && !process.exitCode) await rm(root, { recursive: true, force: true });
  }
}
