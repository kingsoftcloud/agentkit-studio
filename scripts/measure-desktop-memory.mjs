// Read-only diagnostic for a running official Electron Desktop. No UI driving,
// forced GC or profile writes. webContents identity is checked at every sample.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function selectDesktopRoles(observation, expectedPid, guestUrl) {
  if (observation.pid !== expectedPid) throw new Error('Electron main PID does not match the requested process');
  const select = (predicate, label) => {
    const matches = observation.pages.filter(predicate);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].pid) || matches[0].pid <= 0) {
      throw new Error(`Expected exactly one ${label} with a live OS PID`);
    }
    return matches[0];
  };
  return {
    app_renderer: select(page => page.type === 'window' && page.url === 'dsh-app://app/', 'DSH application window'),
    browser_guest: select(page => page.type === 'webview' && page.url === guestUrl, 'Browser guest'),
  };
}

export function assertStableRoles(before, after) {
  for (const name of Object.keys(before)) {
    if (['id', 'pid', 'type', 'url'].some(key => before[name][key] !== after[name]?.[key])) {
      throw new Error(`${name} identity changed during measurement`);
    }
  }
}

async function inspector(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  const nodes = targets.filter(target => target.type === 'node');
  if (nodes.length !== 1) throw new Error('Expected exactly one Node inspector target');
  const socket = new WebSocket(nodes[0].webSocketDebuggerUrl);
  await new Promise((yes, no) => {
    const timer = setTimeout(() => { socket.close(); no(new Error('Inspector connection timed out')); }, 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); yes(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); no(new Error('Inspector connection failed')); }, { once: true });
  });
  let sequence = 0;
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((yes, no) => {
        const done = (error, value) => {
          clearTimeout(timer); socket.removeEventListener('message', receive);
          socket.removeEventListener('close', closed);
          error ? no(error) : yes(value);
        };
        const closed = () => done(new Error('Inspector connection closed'));
        const receive = event => {
          const message = JSON.parse(event.data);
          if (message.id === id) done(message.error ? new Error(message.error.message) : null, message.result);
        };
        const timer = setTimeout(() => done(new Error(`${method} timed out`)), 8000);
        socket.addEventListener('message', receive);
        socket.addEventListener('close', closed, { once: true });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

const electron = "process.getBuiltinModule('module').createRequire(process.cwd()+'/diagnostic.cjs')('electron')";
const observe = `(() => ({pid:process.pid,pages:${electron}.webContents.getAllWebContents().map(w => ({id:w.id,type:w.getType(),pid:w.getOSProcessId(),url:w.getURL().split(/[?#]/)[0]}))}))()`;
const mib = bytes => Math.round(bytes / 1048576 * 1000) / 1000;
function rss(pid) {
  const value = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`No RSS for PID ${pid}`);
  return mib(value * 1024);
}

// Use Electron's documented webContents.debugger bridge for guests which are
// absent from the Chromium /json/list. Never detach a debugger owned by someone else.
async function rendererHeap(client, identity) {
  return evaluate(client, `(async () => {
    const expected=${JSON.stringify(identity)};
    const w=${electron}.webContents.fromId(expected.id);
    if(!w || w.getType()!==expected.type || w.getOSProcessId()!==expected.pid || w.getURL().split(/[?#]/)[0]!==expected.url) throw Error('webContents identity changed');
    if(w.debugger.isAttached()) throw Error('webContents debugger already owned');
    w.debugger.attach('1.3');
    try { return await w.debugger.sendCommand('Runtime.getHeapUsage'); }
    finally { w.debugger.detach(); }
  })()`);
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(['main-port', 'main-pid', 'host-port', 'host-pid', 'guest-url', 'samples', 'interval-ms', 'output'].map(name => [name, { type: 'string' }])) });
  for (const key of ['main-port', 'main-pid', 'guest-url', 'output']) if (!values[key]) throw new Error(`Missing --${key}`);
  const positive = (name, fallback) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  const count = positive('samples', 30), interval = positive('interval-ms', 1000);
  const mainPid = positive('main-pid');
  const guestUrl = new URL(values['guest-url']);
  guestUrl.search = ''; guestUrl.hash = '';
  if (!['http:', 'https:'].includes(guestUrl.protocol)) throw new Error('Guest must use HTTP(S)');
  if (Boolean(values['host-pid']) !== Boolean(values['host-port'])) throw new Error('Pass both --host-pid and --host-port');
  const client = await inspector(positive('main-port'));
  let host;
  try {
    if (values['host-port']) host = await inspector(positive('host-port'));
    const initial = await evaluate(client, observe);
    const roles = selectDesktopRoles(initial, mainPid, guestUrl.href);
    const readings = [];
    for (let i = 0; i < count; i++) {
      const current = await evaluate(client, observe);
      assertStableRoles(roles, selectDesktopRoles(current, mainPid, guestUrl.href));
      const reading = { timestamp: new Date().toISOString(), roles: {} };
      const mainHeap = await client.call('Runtime.getHeapUsage');
      reading.roles.electron_main = { pid: mainPid, rss_mib: rss(mainPid), js_used_heap_mib: mib(mainHeap.usedSize) };
      for (const [name, identity] of Object.entries(roles)) {
        const heap = await rendererHeap(client, identity);
        reading.roles[name] = { ...identity, rss_mib: rss(identity.pid), js_used_heap_mib: mib(heap.usedSize) };
      }
      if (host) {
        const hostPid = positive('host-pid');
        if (await evaluate(host, 'process.pid') !== hostPid) throw new Error('Host inspector PID mismatch');
        const heap = await host.call('Runtime.getHeapUsage');
        reading.roles.dsh_node_host = { pid: hostPid, rss_mib: rss(hostPid), js_used_heap_mib: mib(heap.usedSize) };
      }
      readings.push(reading);
      if (i + 1 < count) await new Promise(yes => setTimeout(yes, interval));
    }
    const summary = {};
    for (const name of Object.keys(readings[0].roles)) {
      summary[name] = { pid: readings[0].roles[name].pid, sample_count: count };
      for (const metric of ['rss_mib', 'js_used_heap_mib']) {
        const numbers = readings.map(row => row.roles[name][metric]).sort((a, b) => a - b);
        summary[name][`median_${metric}`] = (numbers[Math.floor(count / 2)] + numbers[Math.floor((count - 1) / 2)]) / 2;
        summary[name][`peak_${metric}`] = numbers.at(-1);
      }
    }
    const report = { schema_version: 1, method: 'Electron webContents identity + ps RSS + Runtime.getHeapUsage; no forced GC', sample_interval_ms: interval, identity: { main_pid: mainPid, ...roles }, summary, readings };
    await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ identity: report.identity, summary, output: resolve(values.output) }, null, 2));
  } finally { client.close(); host?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
