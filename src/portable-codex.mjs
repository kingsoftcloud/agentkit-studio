/** Portable deployments use explicit model/resource bindings, never the operator's Codex login or plugins. */
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { portableError } from './portable-resources.mjs';

export async function portableCodexOptions({ home, manifest, env = process.env }) {
  if (!home || !/^bundle_[a-f0-9]{64}$/.test(manifest?.bundleId || '')) {
    throw portableError('PORTABLE_CODEX_SCOPE_INVALID', 'Codex 运行目录需要已校验的运行包身份');
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
  const scope = await directory(state, manifest.bundleId);
  const isolatedHome = await directory(scope, 'home');
  const codexHome = await directory(isolatedHome, '.codex');
  const cwd = await directory(scope, 'workspace');
  const childEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR']) {
    if (env[key]) childEnv[key] = env[key];
  }
  Object.assign(childEnv, {
    HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: await directory(isolatedHome, '.config'),
    XDG_CACHE_HOME: await directory(isolatedHome, '.cache'),
    XDG_DATA_HOME: await directory(isolatedHome, '.local'),
    TMPDIR: await directory(scope, 'tmp'),
  });
  return { env: childEnv, inheritEnv: false, cwd, sandbox: 'read-only', approvalPolicy: 'never' };
}
