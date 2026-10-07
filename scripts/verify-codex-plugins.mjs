/** Real CLI install/remove and App Server Skill loading in an isolated home. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createStudioCodexPlugins } from '../src/studio-codex-plugins.mjs';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';
import { createCodexModelCatalog } from '../src/providers/codex-models.mjs';

const executable = process.env.AGENTKIT_CODEX_BIN || 'codex';
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'studio-codex-plugins-'));
const home = join(root, 'home');
const market = join(root, 'market');
const execute = process.argv.includes('--execute');
const canary = randomUUID();
const callsPath = join(root, 'mcp-calls.jsonl');
let server;

async function loadedSkills() {
  server = spawn(executable, ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Codex skills/list timed out')), 10_000);
    const finish = (error, result) => { clearTimeout(deadline); if (error) reject(error); else resolve(result); };
    server.once('error', error => finish(error));
    server.once('exit', () => finish(new Error('Codex exited before skills/list completed')));
    server.stderr.resume();
    server.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.error) { finish(new Error(message.error.message)); return; }
          if (message.id === 1) {
            server.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
            server.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [root], forceReload: true } })}\n`);
          }
          if (message.id === 2) finish(null, message.result);
        } catch (error) { finish(error); return; }
      }
    });
    server.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'studio-plugin-verification', version: '1.0.0' }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

try {
  await mkdir(join(market, '.agents/plugins'), { recursive: true });
  await mkdir(join(market, 'plugins/studio-smoke/.codex-plugin'), { recursive: true });
  await mkdir(join(market, 'plugins/studio-smoke/skills/studio-smoke'), { recursive: true });
  await mkdir(home);
  await writeFile(join(market, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'studio-live-test', plugins: [{ name: 'studio-smoke', source: { source: 'local', path: './plugins/studio-smoke' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } }] }));
  await writeFile(join(market, 'plugins/studio-smoke/.codex-plugin/plugin.json'), JSON.stringify({ name: 'studio-smoke', version: '1.0.0', description: 'Studio installation verification', skills: './skills/' }));
  await writeFile(join(market, 'plugins/studio-smoke/skills/studio-smoke/SKILL.md'), '---\nname: studio-smoke\ndescription: Studio plugin verification.\n---\nReply with studio-plugin-loaded.\n');
  if (execute) {
    // The existing Codex account is used only for the explicitly requested live model check.
    // Keep the temporary home private and never copy the personal plugin or MCP configuration.
    await copyFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json'));
    await chmod(join(home, 'auth.json'), 0o600);
    await writeFile(join(market, 'plugins/studio-smoke/.codex-plugin/plugin.json'), JSON.stringify({ name: 'studio-smoke', version: '1.0.0', description: 'Test card lookup', skills: './skills/', mcpServers: './.mcp.json' }));
    await writeFile(join(market, 'plugins/studio-smoke/skills/studio-smoke/SKILL.md'), '---\nname: studio-smoke\ndescription: Look up verification cards and their current state. Use for questions about test cards.\n---\nUse the lookup_card MCP tool to retrieve the requested card. Report its state and verification value exactly.\n');
    const toolServer = join(root, 'card-server.mjs');
    await writeFile(toolServer, `import {createInterface} from 'node:readline'; import {appendFileSync} from 'node:fs';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return; let result;
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'studio-card-check',version:'1.0.0'}};
else if(m.method==='tools/list')result={tools:[{name:'lookup_card',description:'Get the current state of a test card.',inputSchema:{type:'object',properties:{cardId:{type:'string'}},required:['cardId']},annotations:{readOnlyHint:true}}]};
else if(m.method==='tools/call'){appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(m.params)+'\\n');result={content:[{type:'text',text:JSON.stringify({cardId:m.params.arguments.cardId,state:'verified',verification:${JSON.stringify(canary)}})}]};}
else result={}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
    await writeFile(join(market, 'plugins/studio-smoke/.mcp.json'), JSON.stringify({ mcpServers: { 'studio-card-check': { command: process.execPath, args: [toolServer] } } }));
  }
  await run(executable, ['plugin', 'marketplace', 'add', market, '--json'], { env: { ...process.env, CODEX_HOME: home }, timeout: 10_000 });
  const plugins = createStudioCodexPlugins({ codexHome: home, executable });
  await plugins.installCodex('studio-smoke', 'studio-live-test');
  const installed = (await plugins.listCodex()).items.find(item => item.pluginId === 'studio-smoke@studio-live-test');
  assert.equal(installed?.installed, true);
  assert.equal(installed?.enabled, true);
  assert.ok(JSON.stringify(await loadedSkills()).includes('studio-smoke'), 'App Server must load the installed plugin Skill');
  if (execute) {
    const model = process.env.AGENTKIT_CODEX_MODEL || (await createCodexModelCatalog({ executable }).list()).defaultModel;
    const runtime = createCodexRuntime({ executable, cwd: root, model, sandbox: 'read-only', env: { CODEX_HOME: home }, timeoutMs: 180000 });
    const events = [];
    for await (const event of runtime.stream({ input: '请查询测试卡片 P7 的当前状态。', systemPrompt: '准确回答用户问题。' })) events.push(event);
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(calls.some(call => call.name === 'lookup_card' && call.arguments.cardId === 'P7'));
    assert.ok(events.some(event => event.type === 'tool' && event.phase === 'completed' && event.name.endsWith('/lookup_card')));
    assert.ok(events.filter(event => event.type === 'text').map(event => event.text).join('').includes(canary));
    console.log(`Live Codex plugin execution passed: model=${model}, real MCP call recorded, native tool event projected, random result verified.`);
  }
  await plugins.uninstallCodex(installed.pluginId);
  assert.equal((await plugins.listCodex()).items.some(item => item.pluginId === installed.pluginId && item.installed), false);
  console.log('Codex plugin lifecycle: real install, enabled inventory, App Server Skill loading, and removal passed (isolated CODEX_HOME).');
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
