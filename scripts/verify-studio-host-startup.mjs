/** Start the actual installed Studio profile; keep launch tokens only in memory. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: Object.fromEntries(['source', 'home', 'agentkit-home', 'profile', 'port', 'report'].map(name => [name, { type: 'string' }])) });
if (!values.source || !values.home || !values['agentkit-home']) throw new Error('Specify isolated source, DSH home and AgentKit home');
const source = resolve(values.source);
async function fingerprint(directory) {
  const names = ['dist/client.js', 'studio.plugin.json'];
  async function collect(relative) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (/\.(mjs|js)$/.test(name)) names.push(name);
    }
  }
  await collect('src'); await collect('packages/agentkit-harness/src');
  const hash = createHash('sha256');
  for (const name of names.sort()) hash.update(name).update('\0').update(await readFile(join(directory, name)));
  return hash.digest('hex');
}
const profile = values.profile || 'studio-refactor';
const actual = await fingerprint(join(resolve(values.home), 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
assert.equal(actual, await fingerprint(resolve(import.meta.dirname, '..')), 'installed Studio bytes must match this worktree');
const child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', profile, '--host', '127.0.0.1', '--no-open', '--port', values.port || '3198'], {
  cwd: source, env: { ...process.env, DSH_HOME: resolve(values.home), AGENTKIT_HOME: resolve(values['agentkit-home']) }, stdio: ['ignore', 'pipe', 'pipe'],
});
const stopped = new Promise(resolve => child.once('exit', resolve));
let output = '';
const launch = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('DSH startup did not produce its local launch URL')), 60000);
  child.stdout.on('data', data => {
    output += String(data);
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  child.stderr.on('data', data => { output += String(data); });
  child.once('error', () => { clearTimeout(timer); reject(new Error('DSH process could not start')); });
  child.once('exit', () => { clearTimeout(timer); reject(new Error('DSH exited before startup completed')); });
});
try {
  const url = new URL(await launch);
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  assert.equal(login.status, 303, 'official launch-token exchange');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'official browser authentication cookie');
  const operations = [];
  for (const method of ['models/credential-status', 'settings/get']) {
    const response = await fetch(`${url.origin}/agentkit`, { method: 'POST', headers: { cookie, origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ method, payload: {}, rpcId: method }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, method);
    const message = await response.json();
    assert.equal(message.result?.ok, true, `${method}: ${message.result?.error?.code || 'missing result'}`);
    operations.push({ method, passed: true });
  }
  const report = { evidence: 'real-dsh-web-installed-studio-profile', fullStudioPlugin: true, studioSourceSha256: actual, matchesWorktree: true, officialCookieAuthentication: true, operations };
  const reportPath = resolve(values.report || '.artifacts/refactor/stage-1/studio-host-startup.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  output = '';
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await stopped; clearTimeout(timer);
}
