/** Offline boot preparation over the public DSH profile/package contract. */
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { FROZEN_RUNTIME_READY } from './host/frozen-runtime-lifecycle.mjs';
import { importPortableBundle, loadPortableRuntime, verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256, validatePortableCredentialNames } from './portable-resources.mjs';

const PROFILE = 'agentkit-runtime';
const PROFILE_PATCH = `- id: schedule\n  inject: [${FROZEN_RUNTIME_READY}]\n`;
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'];
const fail = (code, message) => { throw portableError(code, message); };
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) fail('BUNDLE_HOST_STATE_INVALID', '运行状态路径必须是独立目录，不能是符号链接');
  return realpath(path);
}

async function archiveBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) fail('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包必须是大小不超过 20 MiB 的普通文件');
  return readFile(path);
}

// A whole node_modules symlink moves Studio outside the DSH profile resolver.
// Keep its code inside the profile, but share external packages with the fixed
// installation so Host-provided Cordis/LLM services retain their one identity.
async function installedPackages(modules) {
  const packages = [];
  for (const name of (await readdir(modules)).sort()) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const child of (await readdir(join(modules, name))).sort()) packages.push(`${name}/${child}`);
    } else packages.push(name);
  }
  return packages;
}

async function packageDigest(root) {
  const hash = createHash('sha256');
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (name === 'node_modules') continue;
      const path = join(dir, name), info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        hash.update(JSON.stringify([relative(root, path), info.mode & 0o777, info.size]));
        hash.update(await readFile(path));
      } else fail('BUNDLE_HOST_INSTALLATION_INCOMPLETE', 'Studio 安装包必须包含普通代码文件');
    }
  }
  await visit(root);
  return hash.digest('hex');
}

async function linkPackages(source, target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of await installedPackages(source)) {
    const destination = join(target, name);
    if (name.startsWith('@')) await mkdir(join(target, name.split('/')[0]), { recursive: true, mode: 0o700 });
    await symlink(await realpath(join(source, name)), destination, 'dir');
  }
}

async function privateModuleDirectories(root) {
  const paths = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') paths.push(relative(root, path));
      else if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return paths.sort();
}

async function materializeProfileModules(modules, destination) {
  await linkPackages(modules, destination);
  const name = '@kingsoftcloud/agentkit-studio', source = await realpath(join(modules, name)), target = join(destination, name);
  await rm(target); // Only the new staging link, never an existing user's profile.
  await cp(source, target, { recursive: true, preserveTimestamps: true,
    filter: path => !relative(source, path).split(/[\\/]/).includes('node_modules') });
  // Package managers may put private dependencies under Studio itself. Link
  // those dependencies individually too; never copy a second Host service.
  for (const path of await privateModuleDirectories(source)) await linkPackages(await realpath(join(source, path)), join(target, path));
}

async function verifyPackageLinks(source, target, verifyStudio) {
  if (!(await exists(target))?.isDirectory() || await realpath(target) !== resolve(target)) fail('BUNDLE_HOST_PROFILE_CONFLICT', 'Profile 依赖目录必须由当前 Profile 持有');
  const names = await installedPackages(source);
  if (JSON.stringify(await installedPackages(target)) !== JSON.stringify(names)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 依赖与固定安装不一致');
  for (const name of names) {
    const path = join(target, name);
    if (name.startsWith('@')) {
      const scope = join(target, name.split('/')[0]);
      if (!(await lstat(scope)).isDirectory() || await realpath(scope) !== resolve(scope)) fail('BUNDLE_HOST_PROFILE_CONFLICT', 'Profile scope 必须由当前 Profile 持有');
    }
    if (verifyStudio && name === '@kingsoftcloud/agentkit-studio') await verifyStudio(path);
    else if (!(await lstat(path)).isSymbolicLink() || await realpath(path) !== await realpath(join(source, name))) {
      fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 依赖与固定安装不一致');
    }
  }
}

async function verifyProfileModules(modules, profileModules, studioDigest) {
  const info = await exists(profileModules);
  if (info?.isSymbolicLink() && await realpath(profileModules) === modules) {
    fail('BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED', '旧运行 Profile 使用整目录链接；请保留状态并按迁移说明处理，不能重置会话');
  }
  await verifyPackageLinks(modules, profileModules, async path => {
    if (!(await lstat(path)).isDirectory() || await packageDigest(path) !== studioDigest) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 的 Studio 代码与固定安装不一致');
    const source = await realpath(join(modules, '@kingsoftcloud/agentkit-studio')), directories = await privateModuleDirectories(source);
    if (JSON.stringify(await privateModuleDirectories(path)) !== JSON.stringify(directories)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 的私有依赖与固定安装不一致');
    for (const directory of directories) await verifyPackageLinks(await realpath(join(source, directory)), join(path, directory));
  });
}

/** A deployment owns one persistent state directory and one immutable bundle. */
export async function prepareBundleHost({ archive, state, installation, env = process.env, expectedSha256, versionedState = false }) {
  const zip = await archiveBytes(resolve(archive)), hash = sha256(zip);
  if (expectedSha256 && (!/^[a-f0-9]{64}$/.test(expectedSha256) || expectedSha256 !== hash)) fail('BUNDLE_HOST_DIGEST_MISMATCH', '运行包与部署指定的 SHA256 不一致');
  const { manifest, definition } = verifyPortableBundle(zip);
  if (!['dsh-native', 'harness', 'codex'].includes(definition.spec?.runtime?.type)) fail('PORTABLE_RUNTIME_UNSUPPORTED', '此运行包的运行时不受支持');
  validatePortableCredentialNames(manifest.requirements);
  if (typeof env.AGENTKIT_RUNTIME_TOKEN !== 'string' || env.AGENTKIT_RUNTIME_TOKEN.length < 24) fail('BUNDLE_HOST_TOKEN_REQUIRED', '运行入口需要至少 24 字符的独立访问令牌');
  for (const [key, value] of [['AGENTKIT_RUNTIME_AGENT_ID', manifest.agentId], ['AGENTKIT_RUNTIME_BUILD_ID', manifest.buildId]]) {
    if (env[key] && env[key] !== value) fail('PORTABLE_RUNTIME_MISMATCH', '部署标识与运行包不一致');
  }
  const missing = manifest.requirements.filter(item => !String(env[item.name] || '').trim());
  if (missing.length) fail('PORTABLE_CREDENTIAL_MISSING', `目标 Host 缺少环境凭证：${missing.map(item => item.name).join(', ')}`);

  const modules = await realpath(join(resolve(installation), 'node_modules'));
  const dshRoot = join(modules, '@deepseek-ai/dsh'), studioRoot = join(modules, '@kingsoftcloud/agentkit-studio');
  const dsh = await json(join(dshRoot, 'package.json')), studio = await json(join(studioRoot, 'studio.plugin.json'));
  if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== studio.requiredDsh) fail('BUNDLE_HOST_VERSION_MISMATCH', '安装的 DSH 与 Studio 固定版本不一致');
  const entry = join(dshRoot, 'lib/bin.js');
  if (!(await exists(entry))?.isFile()) fail('BUNDLE_HOST_INSTALLATION_INCOMPLETE', '镜像未包含已构建的 DSH CLI');

  const parent = await directory(resolve(state));
  const root = versionedState ? await directory(join(await directory(join(parent, 'versions')), hash)) : parent;
  if (await exists(join(root, '.assistant-closed.json'))) fail('BUNDLE_HOST_ASSISTANT_CLOSED', '此专属助理已关闭；重新启用需要创建新部署');
  const receiptPath = join(root, '.agentkit-runtime.json');
  const receipt = { format: 'agentkit.runtime-state/v1', bundleSha256: hash };
  if (!await exists(receiptPath)) {
    if ((await readdir(root)).length) fail('BUNDLE_HOST_STATE_CONFLICT', '首次启动需要空的独立状态目录');
    await writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  }
  if (!(await lstat(receiptPath)).isFile() || JSON.stringify(await json(receiptPath)) !== JSON.stringify(receipt)) fail('BUNDLE_HOST_STATE_CONFLICT', '此状态目录属于另一运行包或不是此 Host 创建的目录');
  const home = join(root, 'agentkit'), dshHome = await directory(join(root, 'dsh'));
  const userHome = await directory(join(root, 'home')), cwd = await directory(join(root, 'workspace'));
  // Only declared resource credentials enter the Host; NODE_OPTIONS, personal
  // profile paths, cloud credentials and proxy configuration are not inherited.
  const childEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'AGENTKIT_DEPLOYMENT_VERSION', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_RUNTIME_HOST', 'AGENTKIT_RUNTIME_PORT', ...manifest.requirements.map(item => item.name)]
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  Object.assign(childEnv, { HOME: userHome, DSH_HOME: dshHome, CODEX_HOME: join(userHome, '.codex'),
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_CACHE_HOME: join(userHome, '.cache'), XDG_STATE_HOME: join(userHome, '.local/state'),
    AGENTKIT_HOME: home, AGENTKIT_BUNDLE_SHA256: hash, AGENTKIT_RUNTIME_AGENT_ID: manifest.agentId, AGENTKIT_RUNTIME_BUILD_ID: manifest.buildId });
  if (await exists(home)) {
    if (!(await lstat(home)).isDirectory()) fail('BUNDLE_HOST_STATE_INVALID', '已有运行目录不能是符号链接');
    if (sha256(await archiveBytes(join(home, 'portable-bundle.zip'))) !== hash) fail('BUNDLE_HOST_STATE_CONFLICT', '此状态目录属于另一运行包，请为新部署分配独立目录');
  } else {
    // Never publish half an import. A killed bootstrap leaves only an unused
    // staging directory; existing session state is never reset or overwritten.
    const staging = join(root, `.import-${randomUUID()}`);
    try { await importPortableBundle(zip, staging); await rename(staging, home); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  await loadPortableRuntime(home, childEnv);
  const profiles = await directory(join(dshHome, 'profiles')), profile = join(profiles, PROFILE);
  const expected = { name: `dsh-profile-${PROFILE}`, private: true, dsh: { profile: { bundles: BUNDLES } } };
  const studioDigest = await packageDigest(await realpath(studioRoot));
  if (!await exists(profile)) {
    const staging = join(profiles, `.preparing-${randomUUID()}`);
    try {
      await directory(staging);
      await writeFile(join(staging, 'package.json'), JSON.stringify(expected, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(join(staging, 'cordis.patch.yml'), PROFILE_PATCH, { flag: 'wx', mode: 0o600 });
      await materializeProfileModules(modules, join(staging, 'node_modules'));
      await verifyProfileModules(modules, join(staging, 'node_modules'), studioDigest);
      await rename(staging, profile);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  if (!(await lstat(profile)).isDirectory() || JSON.stringify(await json(join(profile, 'package.json'))) !== JSON.stringify(expected)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 不属于此固定运行安装');
  await verifyProfileModules(modules, join(profile, 'node_modules'), studioDigest);
  const patch = parseYaml(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'));
  const schedules = Array.isArray(patch) ? patch.filter(row => row?.id === 'schedule') : [];
  const schedule = schedules[0];
  if (schedules.length !== 1 || Object.keys(schedule).some(key => !['id', 'inject'].includes(key))
    || JSON.stringify(schedule.inject) !== JSON.stringify([FROZEN_RUNTIME_READY])) {
    fail('BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED', '运行 Profile 缺少冻结运行时就绪依赖；请保留状态并按迁移说明处理');
  }
  // The official launcher owns the session store, runner, loop and shutdown.
  return { entry, args: ['--profile', PROFILE, '--host', '127.0.0.1', '--no-open', '--port', '0'], cwd, env: childEnv,
    identity: { agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId, sha256: hash, dshVersion: dsh.version } };
}
