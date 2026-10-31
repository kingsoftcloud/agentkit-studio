import { chromium } from 'playwright-core';
import { createDshNodeBrowserTools } from '../../src/providers/dsh-node-browser-tools.mjs';
process.once('message', async ({ args, waitForNavigation, ...options }) => {
  let launches = 0, server;
  const launchBrowser = async () => {
    launches++; server = await chromium.launchServer({ headless: true, executablePath: options.browserExecutablePath });
    const browser = await chromium.connect(server.wsEndpoint()), create = browser.newContext.bind(browser);
    browser.newContext = async config => { const context = await create(config);
      context.on('page', page => page.once('domcontentloaded', () => {
        if (waitForNavigation) process.send({ kind: 'navigated', browserPid: server.process().pid });
      })); return context;
    };
    return browser;
  };
  const port = createDshNodeBrowserTools({ ...options, launchBrowser,
    ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
  try {
    const result = await port.execute('browser_inspect_workspace', args, { name: 'browser_inspect_workspace', arguments: args,
      callId: 'original-call', agent: { session: { id: 'original-session' } }, signal: new AbortController().signal });
    process.send({ pid: process.pid, launches, result });
  } finally { await port.close(); await server?.close(); process.disconnect(); }
});
