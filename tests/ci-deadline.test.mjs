import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { runWithDeadline } from '../ci/run-with-deadline.mjs';

const options = { skip: process.platform === 'win32' ? 'Ezone uses POSIX process groups' : false };
function fixture(t, leader) {
  const root = mkdtempSync(join(tmpdir(), 'ci-deadline-'));
  const worker = join(root, 'worker.mjs'), parent = join(root, 'parent.mjs'), heartbeat = join(root, 'heartbeat');
  // A worker can be killed mid-write. Publish complete heartbeats atomically.
  writeFileSync(worker, `import{renameSync,writeFileSync}from'node:fs';
    process.on('SIGTERM',()=>{});
    const heartbeat=process.argv[2], staging=heartbeat+'.next';
    let n=0;
    setInterval(()=>{writeFileSync(staging,process.pid+':'+(++n));renameSync(staging,heartbeat);},10);`);
  writeFileSync(parent, `import{spawn}from'node:child_process';import{existsSync}from'node:fs';
    process.on('SIGTERM',()=>{});spawn(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(heartbeat)}],{stdio:'ignore'});${leader}`);
  t.after(() => {
    if (existsSync(heartbeat)) {
      const pid = Number(readFileSync(heartbeat, 'utf8').split(':')[0]);
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { parent, heartbeat };
}

async function waitForHeartbeat(path) {
  const deadline = performance.now() + 6000;
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() >= deadline) {
        clearInterval(timer);
        reject(new Error('Installer descendant did not publish its readiness heartbeat'));
      }
    }, 15);
  });
}

test('deadline kills a package-manager leader and its TERM-ignoring descendant before retry', options, async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = runWithDeadline(process.execPath, [f.parent], { timeoutMs: 800, graceMs: 100, stdio: 'ignore' });
  // Exercise the deadline and grace only after there is a real descendant
  // to retire, regardless of how long the CI worker took to spawn it.
  try {
    await waitForHeartbeat(f.heartbeat);
  } finally {
    t.mock.timers.tick(800);
    t.mock.timers.tick(100);
    t.mock.timers.reset();
  }
  assert.equal(await run, 124);
  const settled = readFileSync(f.heartbeat, 'utf8');
  await sleep(120);
  assert.equal(readFileSync(f.heartbeat, 'utf8'), settled, 'the old installer cannot keep running while a retry starts');
});

test('an early successful wrapper exit also retires its background installer', options, async t => {
  const f = fixture(t, `setInterval(()=>{if(existsSync(${JSON.stringify('HEARTBEAT')}))process.exit(0)},20);`);
  writeFileSync(f.parent, readFileSync(f.parent, 'utf8').replace(JSON.stringify('HEARTBEAT'), JSON.stringify(f.heartbeat)));
  assert.equal(await runWithDeadline(process.execPath, [f.parent], { timeoutMs: 3000, graceMs: 100, stdio: 'ignore' }), 0);
  const settled = readFileSync(f.heartbeat, 'utf8'); await sleep(120);
  assert.equal(readFileSync(f.heartbeat, 'utf8'), settled);
});

test('a real command failure is preserved and invalid deadlines never spawn', options, async () => {
  assert.equal(await runWithDeadline(process.execPath, ['-e', 'process.exit(73)'], { timeoutMs: 3000, stdio: 'ignore' }), 73);
  assert.throws(() => runWithDeadline('must-not-run', [], { timeoutMs: 0 }), /Invalid CI deadline/);
});

test('cancelling CI retires the installer group without reporting an installation timeout', options, async t => {
  const f = fixture(t, 'setInterval(()=>{},1000);'), controller = new AbortController();
  const run = runWithDeadline(process.execPath, [f.parent], { timeoutMs: 10000, graceMs: 100, stdio: 'ignore', signal: controller.signal });
  try { await waitForHeartbeat(f.heartbeat); }
  finally { controller.abort('SIGTERM'); }
  assert.equal(await run, 143);
  const settled = readFileSync(f.heartbeat, 'utf8'); await sleep(120);
  assert.equal(readFileSync(f.heartbeat, 'utf8'), settled);
});
