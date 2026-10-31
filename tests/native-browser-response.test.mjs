import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { resolveNativeBrowserExecutable } from '@kingsoftcloud/agentkit-harness-node/native/browser-availability';

const executablePath = resolveNativeBrowserExecutable();
test('mounted npm UI preserves browser disclosure and reasoning across stream settlement, completion and cold replay',
  { skip: executablePath ? false : 'No installed browser executable', timeout: 30000 }, async t => {
    const result = await build({ entryPoints: ['tests/fixtures/native-browser-response-browser.mjs'], bundle: true,
      platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const js = result.outputFiles[0].text;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
      res.end(req.url === '/fixture.js' ? js : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections();return new Promise(resolve => server.close(resolve)); });
    const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    const group = page.locator('[data-testid="activity-group"][data-family="browser"]');
    await group.waitFor();assert.equal(await group.count(), 1);
    const groupId = await group.getAttribute('data-item-id');
    await group.locator(':scope > details > summary').click();
    await group.locator('[data-testid="thought-toggle"]').click();
    assert.equal(await group.locator('[data-testid="thought-details"]').getAttribute('open'), '');
    assert.equal(await group.locator('[data-testid="tool-block"]').getAttribute('data-uncommitted'), 'true');
    assert.equal(await group.locator('[data-testid="tool-block"]').getAttribute('data-status'), null);
    await page.getByRole('button', { name: '提交工具', exact: true }).click();
    await group.locator('[data-testid="tool-block"][data-status="completed"]').waitFor();
    assert.equal(await group.getAttribute('data-item-id'), groupId);
    assert.equal(await group.locator(':scope > details').getAttribute('open'), '');
    assert.equal(await group.locator('[data-testid="thought-details"]').getAttribute('open'), '');
    assert.equal(await page.getByText('实际浏览器说明', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '完成本轮', exact: true }).click();
    await page.getByText('最终交付答复', { exact: true }).waitFor();
    assert.equal(await group.count(), 0, 'completed process collapses instead of duplicating final prose');
    await page.locator('[data-testid="work-history-toggle"]').click();await group.waitFor();
    assert.equal(await group.getAttribute('data-streaming'), 'false');
    assert.equal(await group.locator(':scope > details').getAttribute('open'), '');
    await page.getByRole('button', { name: '冷回放', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="work-history"]')?.open);
    assert.equal(await group.count(), 0);assert.equal(await page.getByText('最终交付答复', { exact: true }).count(), 1);
    await page.locator('[data-testid="work-history-toggle"]').click();await group.waitFor();
    assert.equal(await group.getAttribute('data-item-id'), groupId);
    assert.equal(await group.locator('[data-testid="tool-block"]').count(), 1);
    assert.deepEqual(errors, []);
  });
