/**
 * Real-browser acceptance for the model settings surface.
 *
 * `public-gate` builds the browser bundle, which proves the module graph is
 * sound — it does not prove a control renders or that its button reaches the
 * Host. #201 shipped a「探测接口」button that answered「无效 Server Action」
 * because the endpoint was never registered; every unit test was green.
 *
 * This drives a real browser against a real isolated Studio web and asserts the
 * things a unit test cannot see:
 *
 *   1. the「思考等级」selector renders every level the provider table declares;
 *   2. the「探测接口」button exists, is enabled, and reaches the Host;
 *   3. the verdict renders and offers the matching apply action.
 *
 * The gateway is a local stub, so the run is deterministic and needs no
 * credential. Prints a JSON report and exits non-zero on any failed check.
 *
 * Usage:
 *   # 1. boot an isolated Studio web and copy the printed URL
 *   DSH_HOME=$(mktemp -d) AGENTKIT_HOME=$(mktemp -d) dsh --profile <profile> --port 0 --no-open
 *   # 2. verify
 *   node scripts/verify-studio-model-settings-web.mjs "http://127.0.0.1:PORT/?token=…"
 *
 *   # or point it at the stub gateway and let it boot nothing:
 *   node scripts/verify-studio-model-settings-web.mjs --url "…" --base-url http://127.0.0.1:PORT/v1
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

const HELP = `Real-browser acceptance for the model settings surface.

  --url <url>        the isolated Studio web launch URL (required)
  --base-url <url>   gateway base URL the profile points at (default: a local stub)
  --report <path>    write the JSON report here
  --headed           run with a visible window
  --help             show this message
`;

function parseArgs(argv) {
  const options = { levels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (flag === '--headed') { options.headed = true; continue; }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`缺少 ${flag} 的取值`);
    index += 1;
    if (flag === '--url') options.url = value;
    else if (flag === '--base-url') options.baseUrl = value;
    else if (flag === '--report') options.report = value;
    else throw new Error(`未知参数 ${flag}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { process.stdout.write(HELP); process.exit(0); }
if (!options.url) { process.stderr.write('缺少 --url（隔离 Studio web 的启动地址）\n'); process.exit(2); }

/** Levels the provider table declares for a 星流-backed profile. */
const EXPECTED_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A stub gateway: it answers `/v1/responses` 200 so the probe has a verdict. */
async function stubGateway() {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp_stub', status: 'completed', output: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

const gateway = options.baseUrl ? null : await stubGateway();
const baseUrl = options.baseUrl || gateway.baseUrl;

const { chromium } = require(require.resolve('playwright', {
  paths: [dirname(require.resolve('@playwright/test/package.json'))],
}));

const report = { evidence: 'real-browser-model-settings-surface', url: options.url.replace(/token=[^&]+/, 'token=***'), baseUrl, checks: [], console: [], passed: false };
const consoleErrors = [];

const record = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}\n`);
};

// The bundled Chromium is not always available; the system browser is a real one.
async function launch() {
  for (const attempt of [{ headless: !options.headed }, { headless: !options.headed, channel: 'chrome' }]) {
    try { return await chromium.launch(attempt); } catch { /* try the next browser */ }
  }
  throw new Error('没有可用的浏览器：安装 playwright 的 Chromium，或用系统 Chrome');
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => consoleErrors.push(String(error?.message || error).slice(0, 300)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });

try {
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  record('app title', (await page.title()).includes('AgentKit Studio'), await page.title());

  for (const label of ['设置', '模型与凭证']) {
    await page.evaluate(text => {
      const hit = [...document.querySelectorAll('button,[role="button"],[role="tab"],a')]
        .find(node => String(node.textContent || '').trim() === text);
      if (hit) hit.click();
    }, label);
    await page.waitForTimeout(2500);
  }

  const surface = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-studio-model-settings]'),
    probeButton: document.querySelector('[data-wire-probe-button]')?.textContent.trim() || null,
    probeDisabled: document.querySelector('[data-wire-probe-button]')?.disabled ?? null,
    levels: [...(document.querySelector('[data-model-reasoning]')?.options || [])].map(option => option.value).filter(Boolean),
  }));
  record('model settings surface mounts', surface.panel === true);
  record('reasoning selector renders every declared level', JSON.stringify(surface.levels) === JSON.stringify(EXPECTED_LEVELS), surface.levels);
  record('wire probe button is present and enabled', surface.probeButton !== null && surface.probeDisabled === false, {
    text: surface.probeButton, disabled: surface.probeDisabled,
  });

  if (surface.probeButton && surface.probeDisabled === false) {
    // The probe lives inside the collapsed「连接与思考模式」disclosure.
    await page.evaluate(() => {
      const summary = [...document.querySelectorAll('summary')]
        .find(node => String(node.textContent || '').includes('连接与思考模式'));
      if (summary) summary.click();
    });
    await page.waitForTimeout(1200);
    await page.click('[data-wire-probe-button]');
    await page.waitForFunction(() => {
      const state = document.querySelector('[data-wire-probe]')?.getAttribute('data-wire-probe');
      return state && state !== 'probing' && state !== 'idle';
    }, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const verdict = await page.evaluate(() => ({
      state: document.querySelector('[data-wire-probe]')?.getAttribute('data-wire-probe') || null,
      wire: document.querySelector('[data-wire-probe-result]')?.getAttribute('data-wire-probe-result') || null,
      text: document.querySelector('[data-wire-probe]')?.textContent.replace(/\s+/g, ' ').trim() || null,
      applyOffered: !!document.querySelector('[data-wire-probe-apply]'),
    }));
    record('probe reaches the Host and returns a verdict', verdict.state === 'done', verdict);
    record('verdict offers the matching apply action', verdict.applyOffered === true);
  }
} catch (error) {
  record('run', false, String(error?.message || error).slice(0, 400));
} finally {
  await browser.close();
  await gateway?.close();
}

report.console = consoleErrors;
record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
report.passed = report.checks.every(check => check.ok);

if (options.report) {
  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`\n${report.passed ? 'PASSED' : 'FAILED'} — ${report.checks.filter(check => check.ok).length}/${report.checks.length} checks\n`);
process.exitCode = report.passed ? 0 : 1;
