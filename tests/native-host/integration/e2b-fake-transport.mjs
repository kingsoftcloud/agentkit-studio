/** Deterministic detached-supervisor fixture; local subprocesses, not real E2B. */
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

export function factory(config = {}) {
  const sandboxId = config.sandboxId || 'fake-sandbox';
  const checkpoint = boundary => {
    if (config.boundary !== boundary) return;
    writeFileSync(config.checkpoint, JSON.stringify({ pid: process.pid, boundary }), { mode: 0o600 });
    const fd = openSync(config.checkpoint, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  return {
    start(command, { cwd, env }) {
      checkpoint('before-start');
      const child = spawn('/bin/sh', ['-c', command], { cwd: cwd || undefined, env: env || undefined,
        stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      child.stdout.on('data', bytes => stdout.push(bytes));
      child.stderr.on('data', bytes => stderr.push(bytes));
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve({ exitCode: code }));
      });
      result.catch(() => {});
      checkpoint('after-start');
      const handle = { result, disconnect() {}, async *[Symbol.asyncIterator]() {
        await result;
        yield { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      } };
      return { pid: child.pid, sandboxId, handle };
    },
    reconnect() { return { async *[Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid) {
      if (config.killSucceeds === 'raise') throw Error('injected kill failure');
      if (config.killSucceeds === false) return false;
      try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
    },
  };
}
