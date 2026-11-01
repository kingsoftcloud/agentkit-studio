/** Actual maintained ReasoningRow in Chromium, using packed Host history. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, 'history-root': { type: 'string' }, chromium: { type: 'string' } } });
assert.ok(values.source && values['history-root'] && values.chromium, 'Use --source <maintained DSH> --history-root <thinking Host evidence> --chromium <executable>');
const source = resolve(values.source), root = resolve(values['history-root']), output = join(root, 'thinking-browser');
const first = JSON.parse(await readFile(join(root, 'thinking-first-turn.json'), 'utf8'));
const second = JSON.parse(await readFile(join(root, 'thinking-second-turn.json'), 'utf8'));
const thought = first.events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content)
  .find(block => block.type === 'reasoning')?.text;
const interrupted = second.events.find(event => event.type === 'assistant/message' && event.data.interrupted)?.data.message.content
  .find(block => block.type === 'reasoning')?.text;
assert.ok(thought && interrupted);
await mkdir(output, { recursive: true });
await build({ stdin: { resolveDir: join(source, 'packages/client/ui-chat'), loader: 'tsx', contents: `
  import React, {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {ReasoningRow} from ${JSON.stringify(join(source, 'packages/client/ui-chat/src/client/chat/ReasoningRow.tsx'))};
  const samples = ${JSON.stringify([{ text: thought, running: false }, { text: interrupted, running: true }])};
  function useDisclosure() { const [expanded, setExpanded] = useState(false); return {expanded, toggle:()=>setExpanded(value=>!value)}; }
  function App() { return <main>{samples.map((sample,index)=><section key={index} data-sample={index}>
    <ReasoningRow {...sample} useDisclosure={useDisclosure} usePresentation={select=>select({settledReasoningPreview:true})}
      renderSlot={(name,props)=><p data-thinking-body={name}>{props.text}</p>}
      t={key=>key==='message.think'?'思考':key==='row.running'?'正在思考':key}/>
  </section>)}</main>; }
  createRoot(document.getElementById('app')).render(<App/>);
` }, bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic', outfile: join(output, 'view.js'),
  alias: { '@deepseek-ai/dsh-client-ui-primitives': join(source, 'packages/client/ui-primitives/src/index.ts') },
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' } });
await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/view.css"><style>body{font:14px system-ui;padding:24px;color:#ddd;background:#181818}section{padding:12px;border:1px solid #555;margin:12px}p{white-space:pre-wrap}</style><div id="app"></div><script type="module" src="/view.js"></script>');
const server = createServer(async (request, response) => {
  const name = request.url === '/' ? 'index.html' : request.url?.slice(1);
  if (!['index.html', 'view.js', 'view.css'].includes(name)) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    response.end(await readFile(join(output, name))); } catch { response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: resolve(values.chromium), headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 } }), errors = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const settled = page.locator('[data-sample="0"]'), running = page.locator('[data-sample="1"]');
  await settled.locator('[data-variant="think"]').waitFor();
  assert.equal(await settled.locator('[data-variant="think"]').getAttribute('data-state'), 'ok');
  assert.equal(await running.locator('[data-variant="think"]').getAttribute('data-state'), 'running');
  assert.equal(await settled.locator('[data-thinking-body]').count(), 0, 'Collapsed by default');
  await settled.locator('[data-disclosure-row][role="button"]').click();
  await settled.locator('[data-thinking-body]').waitFor({ state: 'visible' });
  assert.equal(await settled.locator('[data-thinking-body]').textContent(), thought);
  assert.equal(await settled.locator('[data-variant="think"]').getAttribute('data-expanded'), 'true');
  await running.locator('[data-disclosure-row][role="button"]').click();
  assert.equal(await running.locator('[data-thinking-body]').textContent(), interrupted);
  await page.screenshot({ path: join(output, 'expanded.png'), fullPage: true });
  await settled.locator('[data-disclosure-row][role="button"]').click();
  assert.equal(await settled.locator('[data-thinking-body]').count(), 0, 'Actual click collapses again');
  assert.deepEqual(errors, []);
  const proof = { passed: true, actualReasoningRow: true, actualPrimitives: true, chromium: true, collapsedByDefault: true,
    expandedActualHistory: true, collapsedAgain: true, runningState: true,
    limitation: 'Isolated maintained local reasoning component with actual Host text. Body slot uses text; full application navigation and Markdown formatting are separate checks.' };
  await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
