/** Confined command and program execution for a managed cloud assistant. */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const CLOUD_BASH_TOOL = 'cloud_bash';
export const CLOUD_RUN_CODE_TOOL = 'cloud_run_code';
export const CLOUD_EXECUTION_SCHEMA = 'assistant-cloud-execution/v1';
const CODE_LANGUAGES = Object.freeze(['javascript', 'python']);
const DEFAULT_TIMEOUT_MS = 120_000, MAX_TIMEOUT_MS = 300_000;
const MAX_COMMAND_BYTES = 16 * 1024, MAX_CODE_BYTES = 64 * 1024, OUTPUT_BYTES = 64 * 1024;
const SYSTEM_BINDINGS = Object.freeze([
  ['/usr', '/usr'], ['/etc/ssl', '/etc/ssl'], ['/etc/passwd', '/etc/passwd'], ['/etc/group', '/etc/group'],
  ['/etc/hosts', '/etc/hosts'], ['/etc/nsswitch.conf', '/etc/nsswitch.conf'], ['/etc/resolv.conf', '/etc/resolv.conf'],
  ['/etc/ca-certificates', '/etc/ca-certificates'], ['/etc/ca-certificates.conf', '/etc/ca-certificates.conf'],
]);
const fail = (message, code = 'ASSISTANT_CLOUD_EXEC_REFUSED') => Object.assign(new Error(message), { code });

function checkedWorkspace(workspaceRoot) {
  const root = resolve(workspaceRoot);
  let info;
  try { info = statSync(root); } catch { throw fail('云端执行需要可用的专属工作区'); }
  if (!info.isDirectory() || realpathSync(root) !== root) throw fail('云端执行工作区不是规范目录');
  return root;
}

/** Resolve the only supported confiner. A missing bwrap refuses execution; it never degrades to an unconfined child. */
export function resolveCloudSandbox({ platform = process.platform, env = process.env, bwrapPath } = {}) {
  if (platform !== 'linux') return { available: false, reason: '该运行环境没有可用的 Linux 执行沙箱' };
  const path = bwrapPath || env.AGENTKIT_BWRAP || '/usr/bin/bwrap';
  if (!isAbsolute(path) || !existsSync(path)) return { available: false, reason: '运行镜像缺少 bubblewrap，云端执行不可用' };
  return { available: true, kind: 'bwrap', path };
}

function timeoutOf(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) throw fail('超时时间必须在 1 秒到 300 秒之间');
  return value;
}

function boundedText(input, limit, label) {
  if (typeof input !== 'string' || !input.trim()) throw fail(`${label}不能为空`);
  if (Buffer.byteLength(input, 'utf8') > limit) throw fail(`${label}超过云端执行上限`);
  return input;
}

/** Build one bwrap invocation. The child sees only the bindings below and the fixed environment. */
export function planCloudExecution({ sandbox, workspaceRoot, argv, timeoutMs }) {
  const root = checkedWorkspace(workspaceRoot);
  if (!sandbox?.available || sandbox.kind !== 'bwrap') throw fail(sandbox?.reason || '云端执行沙箱不可用');
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net'];
  for (const [source, target] of SYSTEM_BINDINGS) args.push('--ro-bind-try', source, target);
  for (const [target, source] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'], ['/lib64', 'usr/lib64']]) {
    args.push('--symlink', source, target);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/tmp');
  args.push('--bind', root, root, '--chdir', root, '--hostname', 'agentkit-cloud-exec', '--clearenv');
  for (const [key, value] of [['PATH', '/usr/local/bin:/usr/bin:/bin'], ['HOME', root], ['TMPDIR', '/tmp'],
    ['LANG', 'C.UTF-8'], ['LC_ALL', 'C.UTF-8'], ['TERM', 'dumb'], ['PYTHONDONTWRITEBYTECODE', '1'],
    ['NODE_OPTIONS', '--max-old-space-size=512'], ['AGENTKIT_CLOUD_EXECUTION', '1']]) args.push('--setenv', key, value);
  args.push('--', ...argv);
  return { file: sandbox.path, args, env: {}, cwd: root, timeoutMs };
}

function appendBounded(chunks, chunk, state, label, cap = OUTPUT_BYTES) {
  if (state.bytes >= cap) { state.truncated = true; return; }
  const room = cap - state.bytes, slice = chunk.subarray(0, room);
  chunks.push(slice); state.bytes += slice.length;
  if (slice.length < chunk.length) state.truncated = true;
  state[label] = true;
}

/**
 * One confined executor per managed Agent. It refuses to start when the image
 * cannot confine the child; no call falls back to the Host shell or environment.
 */
export function createCloudExecutor({ workspaceRoot, sandbox, spawn = spawnChild, limits = {}, platform = process.platform, env = process.env } = {}) {
  const root = checkedWorkspace(workspaceRoot);
  const confiner = sandbox === undefined ? resolveCloudSandbox({ platform, env }) : sandbox;
  const running = new Set();
  let disposed = false;
  const outputCap = limits.outputBytes ?? OUTPUT_BYTES;
  const maxTimeout = limits.maxTimeoutMs ?? MAX_TIMEOUT_MS;

  function plan(argv, timeoutMs) {
    return planCloudExecution({ sandbox: confiner, workspaceRoot: root, argv, timeoutMs });
  }

  async function run(argv, { timeoutMs, signal } = {}) {
    if (disposed) throw fail('云端执行已关闭');
    if (!confiner?.available) throw fail(confiner?.reason || '云端执行沙箱不可用');
    const planned = plan(argv, Math.min(timeoutOf(timeoutMs), maxTimeout));
    return await new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(planned.file, planned.args, { cwd: planned.cwd, env: planned.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { rejectPromise(fail(`云端执行启动失败: ${error.code || 'spawn-error'}`)); return; }
      running.add(child);
      const out = [], err = [];
      const stdoutState = { bytes: 0, truncated: false }, stderrState = { bytes: 0, truncated: false };
      let timedOut = false, aborted = false, settled = false, timer, killTimer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(killTimer); running.delete(child);
        if (signal && removeAbort) signal.removeEventListener('abort', onAbort);
        if (error) rejectPromise(error); else resolvePromise(value);
      };
      const kill = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
        // A killed child normally reports close immediately; this guard keeps a
        // wedged process from hanging the tool call forever.
        if (killTimer === undefined) killTimer = setTimeout(() => {
          if (aborted) finish(fail('云端执行已取消', 'ASSISTANT_CLOUD_EXEC_ABORTED'));
          else if (timedOut) finish(fail(`云端执行超过 ${Math.round(planned.timeoutMs / 1000)} 秒，进程组已终止`, 'ASSISTANT_CLOUD_EXEC_TIMEOUT'));
        }, 3000);
      };
      const onAbort = () => { aborted = true; kill(); };
      const removeAbort = signal ? (signal.addEventListener('abort', onAbort, { once: true }), onAbort) : undefined;
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => { timedOut = true; kill(); }, planned.timeoutMs);
      child.stdout.on('data', chunk => appendBounded(out, chunk, stdoutState, 'stdout', outputCap));
      child.stderr.on('data', chunk => appendBounded(err, chunk, stderrState, 'stderr', outputCap));
      child.on('error', error => finish(fail(`云端执行进程错误: ${error.code || 'spawn-error'}`)));
      child.on('close', (code, signalName) => {
        if (aborted) return finish(fail('云端执行已取消', 'ASSISTANT_CLOUD_EXEC_ABORTED'));
        if (timedOut) return finish(fail(`云端执行超过 ${Math.round(planned.timeoutMs / 1000)} 秒，进程组已终止`, 'ASSISTANT_CLOUD_EXEC_TIMEOUT'));
        const decode = chunks => Buffer.concat(chunks).toString('utf8');
        finish(null, { exitCode: code, signal: signalName, stdout: decode(out), stderr: decode(err),
          stdoutTruncated: stdoutState.truncated || stdoutState.bytes >= outputCap, stderrTruncated: stderrState.truncated,
          timeoutMs: planned.timeoutMs });
      });
    });
  }

  return {
    available: Boolean(confiner?.available),
    reason: confiner?.reason,
    sandbox: confiner,
    runBash({ command, timeoutMs } = {}, options) {
      const text = boundedText(command, MAX_COMMAND_BYTES, '命令');
      return run(['/bin/bash', '-c', text], { ...options, timeoutMs });
    },
    runCode({ language, code, timeoutMs } = {}, options) {
      if (!CODE_LANGUAGES.includes(language)) throw fail('云端脚本仅支持 JavaScript 或 Python');
      const text = boundedText(code, MAX_CODE_BYTES, '脚本');
      return language === 'javascript'
        ? run(['/usr/local/bin/node', '--input-type=module', '-e', text], { ...options, timeoutMs })
        : run(['/usr/bin/python3', '-c', text], { ...options, timeoutMs });
    },
    dispose() { disposed = true; for (const child of running) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } running.clear(); },
  };
}

function outputSchema() {
  return { type: 'object', properties: {
    exitCode: { type: ['number', 'null'] }, signal: { type: ['string', 'null'] },
    stdout: { type: 'string' }, stderr: { type: 'string' },
    stdoutTruncated: { type: 'boolean' }, stderrTruncated: { type: 'boolean' },
  }, required: ['exitCode', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated'], additionalProperties: false };
}

const renderOutput = (_args, value) => [{ type: 'text', text: `exit ${value.exitCode ?? value.signal}\n${value.stdout}${value.stderr}` }];

/** Register the confined tools for one managed Agent. Names are admitted only while the grant is active. */
export function registerAssistantCloudExecutionTools({ agent, workspaceRoot, executor = createCloudExecutor({ workspaceRoot }), previous }) {
  const tools = agent.ctx.get('tools');
  if (!tools?.register) throw fail('云端执行需要原生工具注册表');
  if (previous) { previous.executor.dispose(); for (const dispose of previous.disposers) dispose(); }
  if (!executor.available) throw fail(executor.reason || '云端执行沙箱不可用', 'ASSISTANT_CLOUD_EXECUTION_UNAVAILABLE');
  const bash = {
    name: CLOUD_BASH_TOOL, description: 'Run one shell command inside this assistant\'s confined cloud workspace. No network, no host credentials, no paths outside the workspace.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false },
    output: { schema: outputSchema(), render: renderOutput },
    execute: (args, exec) => executor.runBash(args, { signal: exec.signal }),
  };
  const code = {
    name: CLOUD_RUN_CODE_TOOL, description: 'Run one bounded JavaScript or Python program inside this assistant\'s confined cloud workspace. No network, no host credentials, no paths outside the workspace.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: [...CODE_LANGUAGES] }, code: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['language', 'code'], additionalProperties: false },
    output: { schema: outputSchema(), render: renderOutput },
    execute: (args, exec) => executor.runCode(args, { signal: exec.signal }),
  };
  const disposers = [tools.register(bash), tools.register(code)].filter(Boolean);
  return { names: [CLOUD_BASH_TOOL, CLOUD_RUN_CODE_TOOL], definitions: [bash, code], executor, disposers };
}
