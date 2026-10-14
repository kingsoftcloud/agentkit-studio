/** Seed isolated, real DSH history using the installed Studio and configured model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { dshModelRoute } from '../src/agent-preset-admission.mjs';
if (!process.env.AGENTKIT_DSH_ROOT || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated DSH root and homes');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const require = createRequire(join(root, 'apps/cli/package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { loadLayeredEnv } = await load('dsh-app-boot');
const { createUserMessage } = await load('dsh-llm');
const { runProfile } = await import(pathToFileURL(join(root, 'apps/cli/lib/profile-boot.js')).href);
const studioRequire = createRequire(import.meta.url);
const { chromium } = studioRequire(studioRequire.resolve('playwright', { paths: [dirname(studioRequire.resolve('@playwright/test/package.json'))] }));
const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async () => null } });
const profile = await models.profile('');
const settings = await models.settings();
const provider = dshModelRoute(settings.modelProfiles?.length ? profile : { ...profile, id: undefined });
const scratch = await mkdtemp(join(tmpdir(), 'studio-native-sidebar-'));
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-2/sidebar-seed.json');
const report = { evidence: 'full-studio-profile-real-dsh-persistence-and-configured-model', sessions: [], passed: false };
let launch, running, browser, stage = 'profile-boot';
const stdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const match = String(chunk).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) launch = match[1];
  args.find(value => typeof value === 'function')?.(); return true;
};
try {
  running = await runProfile({ profile: process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor', environment: loadLayeredEnv('dsh', root), patchFiles: [], args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  assert.ok(launch, 'official local launch URL');
  stage = 'real-browser-model-sync';
  browser = await chromium.launch({ executablePath: process.env.STUDIO_VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(launch);
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  // The existing product publishes the native model directory through the
  // browser's official settings Remote. Exercise that path before admission.
  const readyBy = Date.now() + 30000;
  let nativeModel;
  while (!nativeModel && Date.now() < readyBy) {
    nativeModel = await running.ctx.llm.resolveModelInfo(provider, profile.modelName).catch(() => null);
    if (!nativeModel) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(nativeModel, 'real browser must synchronize the configured native model');
  const origin = new URL(launch).origin;
  const login = await fetch(launch, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  launch = null;
  const call = async (method, payload) => {
    const response = await fetch(`${origin}/agentkit`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ method, payload, rpcId: method }) });
    const result = (await response.json()).result;
    if (!result?.ok) throw Object.assign(new Error('Studio operation refused'), { code: result?.error?.code });
    return result.value;
  };
  for (const label of ['ALPHA', 'BETA']) {
    stage = `create-${label}`;
    const agentName = `SIDEBAR_${label}_AGENT_${basename(scratch).slice(-6)}`;
    const record = await call('agents/create-local', { name: agentName, runtimeType: 'harness', spec: { instructions: { system: 'Reply SIDEBAR_SEED_OK only. Do not use tools.' } } });
    const agentId = record.metadata.id;
    const admission = await call('agents/ensure-preset', { agentId });
    const { sessionId } = await running.ctx.sessionController.create({ cwd: scratch, agentPreset: admission.presetId });
    await running.ctx.sessionController.selectModel({ sessionId, provider, model: profile.modelName, saveDefault: false });
    const result = await running.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in result) throw result.error;
    stage = `turn-${label}`;
    result.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Reply SIDEBAR_${label}_CONTEXT_OK_${agentId.slice(-6)} only.` }], source: { kind: 'user' } }));
    await result.agent.whenIdle();
    const end = result.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
    assert.equal(end?.data.reason.kind, 'completed', `seed turn ${label}: ${end?.data.reason.error?.code || end?.data.reason.kind}`);
    const title = `SIDEBAR_${label}_HISTORY_${agentId.slice(-6)}`;
    await running.ctx.sessionController.rename({ sessionId, title });
    report.sessions.push({ label, agentId, agentName, sessionId, title, presetId: admission.presetId, completed: true });
  }
  stage = 'durable-list';
  const list = await running.ctx.sessionController.list({}, AbortSignal.timeout(15000));
  assert.ok(report.sessions.every(row => list.items.some(item => item.sessionId === row.sessionId && item.blank === false)));
  report.passed = true;
} catch (error) {
  report.failure = { stage, code: String(error.code || 'ASSERTION_FAILED') };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await running?.shutdown.shutdown(process.exitCode || 0);
  process.stdout.write = stdout;
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
