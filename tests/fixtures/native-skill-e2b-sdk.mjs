/** Explicit E2B SDK peer double. Commands are real bash processes and files are
 * real bytes; the network/control plane is simulated, with no OS sandbox claim.
 * No production runtime or supervisor is replaced. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export function skillE2BSdk(t, { root, before = () => {}, killResult = true, createGate, commandGate, afterCommand, corruptFile } = {}) {
  const calls = [], sandboxes = new Map(), processes = new Map();
  class CommandExitError extends Error { constructor(exitCode) { super('command failed'); this.exitCode = exitCode; } }
  t.after(() => { for (const child of processes.values()) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
  const sdk = { CommandExitError, Sandbox: {
    async create(template, options) {
      before('create'); calls.push({ method: 'create', template, options });
      if (createGate) await createGate.promise;
      const id = `skill-peer-${sandboxes.size + 1}`, local = join(root, id);
      mkdirSync(join(local, 'tmp'), { recursive: true });
      sandboxes.set(id, { local, metadata: options.metadata }); return { sandboxId: id };
    },
    async connect(id, options) {
      before('connect'); calls.push({ method: 'connect', id, options });
      const peer = sandboxes.get(id); assert.ok(peer, 'the original sandbox must already exist');
      const localPath = path => {
        assert.equal(typeof path, 'string'); assert.equal(posix.normalize(path), path); assert.ok(path.startsWith('/'));
        assert.ok(!path.split('/').includes('..')); return join(peer.local, path.slice(1));
      };
      const remotePath = path => path.replaceAll(peer.local, '');
      const mapValue = text => text.replaceAll(/\/tmp\/agentkit-skill-[a-f0-9]{64}/gu, match => localPath(match));
      const info = path => {
        const st = lstatSync(localPath(path));
        return { path, name: posix.basename(path), type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file',
          size: st.size, mode: st.mode & 0o777, modifiedTime: st.mtime };
      };
      return { sandboxId: id, files: {
        async getInfo(path, opts) { before('getInfo'); calls.push({ method: 'getInfo', path, opts }); return info(path); },
        async makeDir(path, opts) { before('makeDir'); calls.push({ method: 'makeDir', path, opts });
          if (existsSync(localPath(path))) return false; mkdirSync(localPath(path), { recursive: true, mode: 0o700 }); return true; },
        async write(path, bytes, opts) {
          before('write'); calls.push({ method: 'write', path, opts, size: bytes.byteLength });
          mkdirSync(dirname(localPath(path)), { recursive: true }); writeFileSync(localPath(path), Buffer.from(bytes)); return info(path);
        },
        async read(path, opts) {
          before('read'); calls.push({ method: 'read', path, opts }); assert.equal(opts.format, 'stream');
          const bytes = readFileSync(localPath(path));
          return new ReadableStream({ start(controller) { controller.enqueue(corruptFile ? corruptFile(bytes) : bytes); controller.close(); } });
        },
        async list(path, opts) {
          before('list'); calls.push({ method: 'list', path, opts }); assert.equal(opts.depth, 1);
          return readdirSync(localPath(path)).map(name => info(posix.join(path, name)));
        },
      }, commands: {
        async run(command, opts) {
          before('run'); calls.push({ method: 'run', id, command, opts });
          if (commandGate) await commandGate(command, opts);
          const env = { PATH: '/usr/bin:/bin', ...Object.fromEntries(Object.entries(opts.envs ?? {}).map(([key, value]) => [key, mapValue(value)])) };
          const child = spawn('/bin/bash', ['-c', mapValue(command)], { cwd: localPath(opts.cwd ?? '/tmp'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          processes.set(child.pid, child);
          const done = new Promise((resolve, reject) => {
            child.stdout.on('data', bytes => opts.onStdout(remotePath(bytes.toString())));
            child.stderr.on('data', bytes => opts.onStderr(remotePath(bytes.toString())));
            child.on('error', reject); child.on('exit', (code, signal) => { processes.delete(child.pid);
              afterCommand?.(command, code);
              if (Number.isInteger(code)) resolve({ exitCode: code }); else reject(new Error(`peer command signal ${signal}`)); });
          });
          void done.catch(() => {});
          return { pid: child.pid, async wait() { const result = await done; if (result.exitCode) throw new CommandExitError(result.exitCode); return result; },
            async disconnect() {} };
        },
        async connect() { assert.fail('this workflow must not reconnect implicitly'); },
        async kill(pid) { before('kill-command'); calls.push({ method: 'kill-command', pid });
          try { process.kill(-pid, 'SIGTERM'); return true; } catch { return false; } },
      } };
    },
    async kill(id, options) { before('kill'); calls.push({ method: 'kill', id, options }); return killResult; },
    async getInfo(id) { const peer = sandboxes.get(id); return { sandboxId: id, state: 'running', metadata: peer.metadata }; },
  } };
  return { sdk, calls, sandboxes, processes };
}
