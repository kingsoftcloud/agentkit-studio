import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { resolveNativeBrowserExecutable } from '@kingsoftcloud/agentkit-harness-node/native/browser-availability';

const executablePath = resolveNativeBrowserExecutable();
test('real mounted React never paints the transport footer before Native hydration or after polling/session changes',
  { skip: executablePath ? false : 'No installed browser executable', timeout: 30000 }, async t => {
    const result = await build({ entryPoints: ['tests/fixtures/native-timeline-hydration-browser.mjs'],
      bundle: true, platform: 'browser', format: 'iife', write: false,
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const js = result.outputFiles.find(f => f.path.endsWith('.js'))?.text ?? result.outputFiles[0].text;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
      res.end(req.url === '/fixture.js' ? js : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections();return new Promise(resolve => server.close(resolve)); });
    const browser = await chromium.launch({ executablePath, headless: true });t.after(() => browser.close());
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);await page.locator('[data-testid="task-observation-loading"]').waitFor();
    assert.equal(await page.locator('[data-testid="studio-task-timeline"]').count(), 0);
    await page.getByRole('button', { name: '释放运行状态', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-testid="studio-task-timeline"]').count(), 0, 'status alone cannot paint a partial frame');
    await page.getByRole('button', { name: '释放子任务目录', exact: true }).click();
    await page.getByText('模型响应未通过协议校验：alpha', { exact: false }).waitFor();
    assert.equal(await page.locator('#legacy-paints').textContent(), '0');
    await page.getByRole('button', { name: '模拟同步失败', exact: true }).click();
    await page.getByText('任务过程同步失败，请重试。', { exact: true }).waitFor();
    assert.match(await page.locator('#presentation').textContent(), /模型响应未通过协议校验：alpha/);
    assert.equal(await page.locator('[data-testid="task-observation-loading"]').count(), 0);
    await page.getByRole('button', { name: '恢复同步', exact: true }).click();
    await page.getByText('任务过程同步失败，请重试。', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '切换会话', exact: true }).click();
    await page.locator('[data-testid="task-observation-loading"]').waitFor();
    assert.doesNotMatch(await page.locator('#presentation').textContent(), /alpha/);
    await page.getByRole('button', { name: '释放旧会话', exact: true }).click();
    await page.waitForTimeout(100);assert.equal(await page.locator('[data-testid="studio-task-timeline"]').count(), 0);
    await page.getByRole('button', { name: '释放运行状态', exact: true }).click();
    await page.getByRole('button', { name: '释放子任务目录', exact: true }).click();
    await page.getByText('模型响应未通过协议校验：beta', { exact: false }).waitFor();
    assert.equal(await page.locator('#legacy-paints').textContent(), '0');assert.deepEqual(errors, []);
  });
