/** Run the assembled Desktop Host through its production entry and IPC lifecycle. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { createBuildOutputRedactor } from './build-output-redaction.mjs';

/** Own the Host process until the callback and acknowledged shutdown complete. */
export async function withAssembledDesktopHost({ runtime, node, profile, environment, diagnostics }, use) {
  await mkdir(dirname(diagnostics), { recursive: true });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|APPLE|CSC_)/i.test(name)));
  const child = spawn(resolve(node), ['--expose-internals',
    join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), runtime, profile,
    join(runtime, '../runtime/primary-runtime')], {
    cwd: profile, env: { ...inherited, ...environment, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const secrets = Object.entries(process.env).filter(([name, value]) => /(KEY|SECRET|TOKEN|PASSWORD|CERTUM|CSC_)/i.test(name) && value.length >= 4).map(([, value]) => value);
  const streams = [child.stdout, child.stderr].map(stream => {
    const redactor = stream.pipe(createBuildOutputRedactor());
    redactor.setEncoding('utf8');
    redactor.on('data', text => {
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      appendFileSync(diagnostics, text, { mode: 0o600 });
    });
    return finished(redactor, { cleanup: true });
  });
  let acknowledged = false, forced = false;
  child.on('message', message => { if (message?.type === 'shutdown-complete') acknowledged = true; });
  const stopped = new Promise(accept => child.once('close', (code, signal) => accept({ code, signal })));
  let readyTimer;
  const ready = new Promise((accept, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Assembled Desktop Host startup timed out')), 60000);
    child.on('message', message => {
      if (message?.type === 'ready') accept({ url: message.url });
      if (message?.type === 'fatal') reject(new Error('Assembled Desktop Host reported startup failure; see redacted diagnostics'));
    });
    child.once('error', () => reject(new Error('Assembled Desktop Host could not start')));
    child.once('close', () => reject(new Error('Assembled Desktop Host exited before readiness')));
  });
  try {
    const state = await ready;
    clearTimeout(readyTimer);
    return await use(state);
  } finally {
    clearTimeout(readyTimer);
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
    const exit = await stopped;
    clearTimeout(timer);
    await Promise.all(streams);
    assert.equal(forced, false, 'The Desktop Host must stop without forced termination');
    assert.equal(exit.code, 0, 'The Desktop Host must exit successfully');
    assert.equal(acknowledged, true, 'The Desktop Host must acknowledge completed shutdown');
    const log = await readFile(diagnostics, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.doesNotMatch(log, /warning: \d+ entries did not activate/, 'Every enabled profile entry must activate');
  }
}
