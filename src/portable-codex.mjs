/** Portable deployments use explicit model/resource bindings, never the operator's Codex login or plugins. */
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { portableError } from './portable-resources.mjs';
import { DEFAULT_CLOUD_EXECUTION_MAX, readExecutionMode } from './execution-policy.mjs';

export async function portableCodexOptions({ home, manifest, env = process.env }) {
  if (!home || !/^bundle_[a-f0-9]{64}$/.test(manifest?.bundleId || '')) {
    throw portableError('PORTABLE_CODEX_SCOPE_INVALID', 'Codex 运行目录需要已校验的运行包身份');
  }
  // An exported bundle runs on a foreign machine: keep the read-only default.
  return isolatedRuntimeCodexOptions({ home, scopeId: manifest.bundleId, env, sandbox: 'read-only' });
}

/** Both input forms use the same confined app-server process boundary. */
export async function isolatedRuntimeCodexOptions({ home, scopeId, env = process.env, sandbox, approvalPolicy }) {
  if (!home || !/^(?:bundle|manifest)_[a-f0-9]{64}$/.test(scopeId || '')) {
    throw portableError('PORTABLE_CODEX_SCOPE_INVALID', 'Codex 运行目录需要已校验的固定声明身份');
  }
  // The imported home may itself be reached through an OS alias (e.g. tmp on
  // macOS), but every directory we own below it must be a real private directory.
  const root = await realpath(home);
  async function directory(parent, name) {
    const path = join(parent, name);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(path)).isDirectory()) throw portableError('PORTABLE_CODEX_SCOPE_INVALID', 'Codex 运行目录包含不受支持的链接或文件');
    return path;
  }
  const state = await directory(root, 'runtime-state');
  const scope = await directory(state, scopeId);
  const isolatedHome = await directory(scope, 'home');
  const codexHome = await directory(isolatedHome, '.codex');
  const cwd = await directory(scope, 'workspace');
  const childEnv = {};
  // Only explicit, non-credential Codex transport knobs cross the confinement
  // boundary; the surrounding deployment may raise the model stream budgets
  // without rebuilding the runtime image.
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR',
    'AGENTKIT_CODEX_STREAM_IDLE_TIMEOUT_MS', 'AGENTKIT_CODEX_MODEL_IDLE_TIMEOUT_MS',
    'AGENTKIT_CODEX_REASONING_SUMMARY']) {
    if (env[key]) childEnv[key] = env[key];
  }
  Object.assign(childEnv, {
    HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: await directory(isolatedHome, '.config'),
    XDG_CACHE_HOME: await directory(isolatedHome, '.cache'),
    XDG_DATA_HOME: await directory(isolatedHome, '.local'),
    TMPDIR: await directory(scope, 'tmp'),
  });
  // The managed runtime container is already the confinement boundary (read-only
  // rootfs, dropped capabilities, one Agent per pod) and Codex's bubblewrap
  // sandbox cannot run inside it at all. Default to full access and let a
  // deployment narrow it with AGENTKIT_CODEX_SANDBOX.
  const resolvedSandbox = readExecutionMode(sandbox)
    || readExecutionMode(env.AGENTKIT_CODEX_SANDBOX) || DEFAULT_CLOUD_EXECUTION_MAX;
  const requestedApproval = String(approvalPolicy || env.AGENTKIT_CODEX_APPROVAL_POLICY || '').trim();
  const resolvedApproval = ['untrusted', 'on-failure', 'on-request', 'never'].includes(requestedApproval) ? requestedApproval : 'never';
  return { env: childEnv, inheritEnv: false, cwd, sandbox: resolvedSandbox, approvalPolicy: resolvedApproval };
}
