/** Actual Studio panel/dialog in Chromium with captured production Host status.
 * This is component acceptance, not full application navigation or live RPC. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { browserExecutable } from '../tests/fixtures/browser-executable.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, 'evidence-dir': { type: 'string' } } });
assert.ok(values.source && values['evidence-dir'], 'Use --source <maintained DSH> --evidence-dir <exported production Host status>');
const source = resolve(values.source), root = resolve(values['evidence-dir']);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..'), output = join(root, 'browser');
const samples = await Promise.all(['success', 'budget'].map(async name => ({ name,
  ...JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')) })));
assert.equal(samples[0].status.memoryExtraction.jobs[0].status, 'success');
assert.equal(samples[1].status.memoryExtraction.jobs[0].errorCode, 'native_memory_extraction_budget_exhausted');
await mkdir(output, { recursive: true });
await build({ stdin: { resolveDir: join(source, 'packages/client/ui-chat'), loader: 'js', contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {createNativeChildPanel} from ${JSON.stringify(join(repository, 'src/client/dsh/native-children.mjs'))};
  import {createResourceDialog} from ${JSON.stringify(join(repository, 'src/client/components/resource-dialog.mjs'))};
  const samples=${JSON.stringify(samples)}, h=React.createElement;
  const buttonStyle=()=>({padding:'6px 12px',margin:'6px'});
  const ResourceDialog=createResourceDialog({React,buttonStyle});
  function Sample({sample}) {
    const {status,record}=sample, agentId=record.metadata.id, sessionId=status.sessionId;
    const Panel=React.useMemo(()=>createNativeChildPanel({ui:{React,ResourceDialog,buttonStyle}, hostRemote:{
      agents:async()=>({items:[record]}), nativeRecoveryStatus:async()=>status,
      nativeChildHistory:async()=>({contract:'agentkit.studio-native-child-history/v1',sessionId,runId:status.runId,
        tasks:[],inventoryDigest:'a'.repeat(64),offset:0,nextOffset:0,totalTasks:0,complete:true}),
      dshA2aTaskHistory:async()=>({contract:'agentkit.studio-dsh-a2a-inventory/v1',agentId,sessionId,
        applicable:false,items:[],offset:0,total:0,complete:true}),
      resumeNativeRun:async()=>{throw Error('Read-only acceptance must never resume work')}
    }}),[sample]);
    return h('section',{'data-sample':sample.name},h('h2',null,sample.name==='success'?'已完成的提炼':'预算耗尽的提炼'),
      h(Panel,{sessionId,useSessions:select=>select({byId:{[sessionId]:{projectionValues:{
        agentPreset:'agentkit-studio-agent-'+agentId+'-r1-fixture'}}}})}));
  }
  createRoot(document.getElementById('app')).render(h('main',null,...samples.map(sample=>h(Sample,{sample,key:sample.name}))));
` }, bundle: true, platform: 'browser', format: 'esm', target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(output, 'view.js') });
await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:24px;background:#f4f6f8;color:#172331}</style><div id="app"></div><script type="module" src="/view.js"></script>');
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url?.slice(1);
  if (!['index.html', 'view.js'].includes(name)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'application/javascript' : 'text/html' });
  response.end(await readFile(join(output, name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 740 } }), errors = [];
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const sample of samples) {
    await page.locator(`[data-sample="${sample.name}"]`).getByRole('button', { name: '运行与子任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本会话的运行与子任务', exact: true });
    const memory = dialog.getByRole('region', { name: '自动记忆提炼', exact: true });
    await memory.waitFor({ state: 'visible' });
    const job = sample.status.memoryExtraction.jobs[0], text = await memory.textContent();
    assert.ok(text.includes(`模型 ${job.usage.modelCalls} 次`));
    assert.ok(text.includes(`输入 ${job.usage.inputTokens} / 输出 ${job.usage.outputTokens} tokens`));
    assert.ok((await dialog.getByRole('region', { name: 'Native 运行用量', exact: true }).textContent()).includes('模型 1 次'));
    assert.ok(text.includes(sample.name === 'success' ? '已完成' : '已达到提炼预算上限'));
    assert.ok(!text.includes('native_memory_extraction_'));
    await page.screenshot({ path: join(output, `${sample.name}.png`), fullPage: true });
    await dialog.getByRole('button', { name: '刷新', exact: true }).click();
    await memory.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  const proof = { passed: true, actualStudioPanel: true, actualStudioDialog: true,
    source: 'production Native Host recoveryStatus with real auxiliary execution and SQLite Memory; controlled model responses',
    checks: ['separate-parent-and-extraction-usage', 'successful-extraction', 'budget-exhaustion-in-Chinese', 'refresh-and-close'],
    limitation: 'Isolated production components rendered with captured Host replies; full app navigation and live authenticated RPC remain separate acceptance requirements.' };
  await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
