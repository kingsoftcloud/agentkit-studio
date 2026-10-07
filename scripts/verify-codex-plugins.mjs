/** Real CLI install/remove and App Server Skill loading in an isolated home. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createStudioCodexPlugins } from '../src/studio-codex-plugins.mjs';

const executable = process.env.AGENTKIT_CODEX_BIN || 'codex';
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'studio-codex-plugins-'));
const home = join(root, 'home');
const market = join(root, 'market');
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
  await run(executable, ['plugin', 'marketplace', 'add', market, '--json'], { env: { ...process.env, CODEX_HOME: home }, timeout: 10_000 });
  const plugins = createStudioCodexPlugins({ codexHome: home, executable });
  await plugins.installCodex('studio-smoke', 'studio-live-test');
  const installed = (await plugins.listCodex()).items.find(item => item.pluginId === 'studio-smoke@studio-live-test');
  assert.equal(installed?.installed, true);
  assert.equal(installed?.enabled, true);
  assert.ok(JSON.stringify(await loadedSkills()).includes('studio-smoke'), 'App Server must load the installed plugin Skill');
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
