/** Real DSH Connection/WebServer and Cordis teardown, with controlled upstreams. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.AGENTKIT_DSH_ROOT;
if (!source || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Isolated DSH source and homes are required');
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = join(process.env.DSH_HOME, 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio');
const installedSource = await realpath(installed);
const { registerControlPlaneRoutes } = await import(pathToFileURL(join(installedSource, 'src/host/routes/http.mjs')));
const dshRequire = createRequire(join(source, 'apps/cli/package.json'));
const { loadLayeredEnv } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')));
const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')));
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const scratch = await mkdtemp(join(tmpdir(), 'studio-http-scope-'));
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const report = { evidence: 'real-built-dsh-connection-webserver-scope-with-controlled-upstream', installedSource, auth: [], streams: [], passed: false };
const stdout = process.stdout.write.bind(process.stdout);
let launchUrl, buffer = '', running, browser, fiber, stage = 'startup';
// The launch URL contains an ephemeral token; keep it only in this process.
process.stdout.write = (chunk, ...args) => {
  buffer = (buffer + String(chunk)).slice(-5000);
  const match = buffer.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) launchUrl = match[1];
  args.find(value => typeof value === 'function')?.(); return true;
};
const deadline = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scope verification timeout')), 5000); })]); }
  finally { clearTimeout(timer); }
};
try {
  running = await runProfile({ profile, environment: loadLayeredEnv('dsh', source), patchFiles: [overlay], args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  assert.ok(launchUrl, 'official Host must emit its browser launch URL');
  const origin = new URL(launchUrl).origin;
  browser = await chromium.launch({ executablePath: process.env.STUDIO_VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(launchUrl);
  const baseline = running.ctx.webServer.prefixes.size;
  for (const kind of ['cloud', 'local']) {
    stage = `${kind}-scope`;
    let started, aborted;
    const start = new Promise(resolve => { started = resolve; });
    const abort = new Promise(resolve => { aborted = resolve; });
    async function* stream(signal) {
      yield 'data: fixture\n\n';
      started();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborted(); reject(Object.assign(new Error('controlled scope abort'), { name: 'AbortError' }));
      }, { once: true }));
    }
    const plugin = { name: `studio-http-scope-proof-${kind}`, inject: ['connection', 'webServer'],
      apply: ctx => registerControlPlaneRoutes(ctx, {
        models: {}, dispatch: async () => ({ ok: true, value: 'fixture' }),
        serverClientPromise: Promise.resolve({ streamAction: async (_action, _body, { signal }) => ({ body: stream(signal) }) }),
        getLegacyLocalConversationHandler: async () => async (_request, response, { signal }) => {
          for await (const chunk of stream(signal)) response.write(chunk);
          response.end();
        },
      }),
    };
    fiber = await running.ctx.plugin(plugin);
    assert.equal(fiber.state, 2);
    if (kind === 'cloud') {
      stage = 'real-connection-admission';
      for (const [label, requestOrigin, expected] of [['missing-cookie', origin, 401], ['foreign-origin', 'https://untrusted.invalid', 403]]) {
        const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { Origin: requestOrigin }, body: '{}' });
        assert.equal(response.status, expected); await response.text();
        report.auth.push({ label, status: response.status, passed: true });
      }
      const authenticated = await page.evaluate(async () => {
        const response = await fetch('/agentkit', { method: 'POST', body: JSON.stringify({ method: 'settings/get', rpcId: 'scope-proof' }) });
        return { status: response.status, ok: (await response.json()).result?.ok };
      });
      assert.equal(authenticated.status, 200); assert.equal(authenticated.ok, true);
      report.auth.push({ label: 'official-browser-cookie', status: 200, passed: true });
    }
    stage = `${kind}-active-stream-disposal`;
    const request = page.evaluate(async path => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'fixture', sessionId: 'fixture', input: 'fixture' }) });
      const reader = response.body.getReader(); let chunks = 0;
      try { while (!(await reader.read()).done) chunks++; } catch {}
      return { status: response.status, chunks };
    }, `/agentkit/${kind}-conversation`);
    await deadline(start);
    await fiber.dispose(); await fiber.dispose();
    await deadline(abort);
    const result = await deadline(request);
    assert.equal(result.status, 200); assert.ok(result.chunks >= 1);
    assert.equal(running.ctx.webServer.prefixes.size, baseline);
    report.streams.push({ kind, upstreamCancelledOnScopeDispose: true, registrationsReturnedToBaseline: true, passed: true });
    fiber = undefined;
  }
  report.passed = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFICATION_FAILED' };
  process.exitCode = 1;
} finally {
  await fiber?.dispose();
  await browser?.close();
  await running?.shutdown.shutdown(process.exitCode || 0);
  process.stdout.write = stdout;
}
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-4/http-real-dsh-scope.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
