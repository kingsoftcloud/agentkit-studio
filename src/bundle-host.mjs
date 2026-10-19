/** Offline boot preparation over the public DSH profile/package contract. */
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FROZEN_RUNTIME_READY } from './host/frozen-runtime-lifecycle.mjs';
import { importPortableBundle, loadPortableRuntime, verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256, validatePortableCredentialNames } from './portable-resources.mjs';

const PROFILE = 'agentkit-runtime';
const PROFILE_OWNER = '.agentkit-runtime-profile.json';
const PROFILE_TRANSACTION = '.agentkit-runtime-profile-transaction.json';
const windowsProfileLocks = new Set();
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
  await verifyPackageLinks(modules, profileModules, async path => {
    if (!(await lstat(path)).isDirectory() || await packageDigest(path) !== studioDigest) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 的 Studio 代码与固定安装不一致');
    const source = await realpath(join(modules, '@kingsoftcloud/agentkit-studio')), directories = await privateModuleDirectories(source);
    if (JSON.stringify(await privateModuleDirectories(path)) !== JSON.stringify(directories)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 的私有依赖与固定安装不一致');
    for (const directory of directories) await verifyPackageLinks(await realpath(join(source, directory)), join(path, directory));
  });
}

async function verifyProfileConfiguration(profile, expected, { allowMissingSchedule = false } = {}) {
  if (!(await lstat(profile)).isDirectory() || await realpath(profile) !== resolve(profile)
    || !(await lstat(join(profile, 'package.json'))).isFile()
    || JSON.stringify(await json(join(profile, 'package.json'))) !== JSON.stringify(expected)) {
    fail('BUNDLE_HOST_PROFILE_CONFLICT', '已有 Profile 不属于此固定运行安装');
  }
  if (!(await lstat(join(profile, 'cordis.patch.yml'))).isFile()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的 Settings 必须是普通文件');
  const patch = parseYaml(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'));
  const schedules = Array.isArray(patch) ? patch.filter(row => row?.id === 'schedule') : [];
  const schedule = schedules[0];
  if (schedules.length > 1 || (!schedule && !allowMissingSchedule)
    || (schedule && (Object.keys(schedule).some(key => !['id', 'name', 'disabled', 'inject', 'config'].includes(key))
      || (schedule.name !== undefined && schedule.name !== '@deepseek-ai/dsh-schedule')
      || (schedule.disabled !== undefined && schedule.disabled !== false)
      || (schedule.config !== undefined && (!schedule.config || typeof schedule.config !== 'object' || Array.isArray(schedule.config)))
      || !(schedule.inject === undefined && allowMissingSchedule) && JSON.stringify(schedule.inject) !== JSON.stringify([FROZEN_RUNTIME_READY])))) {
    fail('BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED', '运行 Profile 的冻结就绪依赖存在冲突；请保留状态并检查 Settings');
  }
  if (!Array.isArray(patch)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的 Settings 形状无效');
  return Boolean(schedule?.inject);
}

async function addLegacyScheduleReadiness(profile) {
  const path = join(profile, 'cordis.patch.yml'), rows = parseYaml(await readFile(path, 'utf8'));
  const schedule = rows.find(row => row?.id === 'schedule');
  if (schedule?.inject) return;
  if (schedule) schedule.inject = [FROZEN_RUNTIME_READY];
  else rows.push({ id: 'schedule', inject: [FROZEN_RUNTIME_READY] });
  await writeFile(path, stringifyYaml(rows), { mode: 0o600 });
}

// Record link text rather than resolving old targets: image replacement can
// remove a prior package-manager path. Only newly staged links must resolve.
async function profileCode(modules) {
  const studio = join(modules, '@kingsoftcloud/agentkit-studio');
  if (!(await lstat(modules)).isDirectory() || await realpath(modules) !== resolve(modules)
    || !(await lstat(studio)).isDirectory()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的代码目录必须由启动器持有');
  const privateDirectories = await privateModuleDirectories(studio), links = [];
  for (const directory of ['', ...privateDirectories.map(path => join('@kingsoftcloud/agentkit-studio', path))]) {
    const root = join(modules, directory);
    if (!(await lstat(root)).isDirectory()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的依赖目录必须由启动器持有');
    for (const entry of await readdir(root)) if (entry.startsWith('.')) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 包含未知依赖目录');
    for (const name of await installedPackages(root)) {
      if (name.startsWith('@') && !(await lstat(join(root, name.split('/')[0]))).isDirectory()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的 scope 不能是链接');
      if (!directory && name === '@kingsoftcloud/agentkit-studio') continue;
      const path = join(root, name);
      if (!(await lstat(path)).isSymbolicLink()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 包含未知依赖代码');
      links.push({ path: relative(modules, path), target: await readlink(path) });
    }
  }
  return { studioDigest: await packageDigest(studio), privateDirectories, links };
}

async function profileMarker(profile, identity) {
  const path = join(profile, PROFILE_OWNER), info = await exists(path);
  if (!info) return null;
  if (!info.isFile()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 归属记录无效');
  const marker = await json(path).catch(() => fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 归属记录无效'));
  if (marker.format !== 'agentkit.runtime-profile/v1' || marker.owner !== 'agentkit-bundle-host'
    || JSON.stringify(marker.identity) !== JSON.stringify(identity)
    || typeof marker.dshVersion !== 'string'
    || JSON.stringify(marker.code) !== JSON.stringify(await profileCode(join(profile, 'node_modules')))) {
    fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的保留代码或归属已被修改');
  }
  return marker;
}

async function writeProfileMarker(profile, identity, dshVersion) {
  const value = { format: 'agentkit.runtime-profile/v1', owner: 'agentkit-bundle-host', identity, dshVersion,
    code: await profileCode(join(profile, 'node_modules')) };
  const temporary = join(profile, `.owner-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, join(profile, PROFILE_OWNER));
}

async function recoverProfile(profiles, profile, expected, identity) {
  const path = join(profiles, PROFILE_TRANSACTION), info = await exists(path);
  if (!info) return;
  if (!info.isFile()) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 切换记录无效');
  const transaction = await json(path);
  if (transaction.format !== 'agentkit.runtime-profile-transaction/v1' || JSON.stringify(transaction.identity) !== JSON.stringify(identity)
    || !/^\.preparing-[a-f0-9-]{36}$/.test(transaction.staging) || !/^\.previous-[a-f0-9-]{36}$/.test(transaction.backup)) {
    fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 切换记录不属于此部署');
  }
  const staging = join(profiles, transaction.staging), backup = join(profiles, transaction.backup);
  if (!await exists(profile)) {
    if (!await exists(backup)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 回滚副本缺失');
    await verifyProfileConfiguration(backup, expected, { allowMissingSchedule: true });
    await rename(backup, profile); // Interrupted before publish: restore the prior complete profile.
  } else if (await exists(backup)) {
    await verifyProfileConfiguration(profile, expected);
    if (!await profileMarker(profile, identity)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 切换未完成');
  }
  if (await exists(staging)) {
    await verifyProfileConfiguration(staging, expected);
    if (!await profileMarker(staging, identity)) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 暂存归属无效');
    await rm(staging, { recursive: true });
  }
  await rm(path);
}

// Use the fixed DSH installation's public native primitive. A kernel lease
// survives stalls and is released on process death; a journal is not a lock.
export async function acquireBundleProfileLock(profiles, modules, platform = process.platform) {
  const installation = createRequire(join(dirname(modules), 'package.json'));
  const persistence = createRequire(installation.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
  if (platform === 'win32') {
    // The fixed persistence package declares public Koffi; use its public FFI
    // API, not the backend's private Session lease or timer-based ownership.
    const koffi = (await import(pathToFileURL(persistence.resolve('koffi')))).default;
    const kernel = koffi.load('kernel32.dll');
    const create = kernel.func('__stdcall', 'CreateMutexW', 'intptr', ['void*', 'int', 'str16']);
    const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']);
    const release = kernel.func('__stdcall', 'ReleaseMutex', 'int', ['intptr']);
    const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
    const name = 'Local\\agentkit-profile-mutex-' + sha256(resolve(profiles, '.agentkit-runtime-profile.lock').toLowerCase());
    // Synchronous FFI acquire/release stay on this Node JS thread. A dead
    // owner is abandoned by the kernel even while another handle exists.
    // Win32 mutexes are recursive for an owning thread; different async
    // prepares on this same JS thread must still contend, never re-enter.
    if (windowsProfileLocks.has(name)) fail('BUNDLE_HOST_PROFILE_BUSY', '另一调用正在准备此运行 Profile，请稍后重试');
    const handle = create(null, 0, name);
    if (!handle) fail('BUNDLE_HOST_PROFILE_LOCK_FAILED', '无法建立运行 Profile 的内核排他锁');
    const result = wait(handle, 0);
    if (result !== 0 && result !== 0x80) { // WAIT_ABANDONED also transfers mutex ownership.
      close(handle);
      fail(result === 0x102 ? 'BUNDLE_HOST_PROFILE_BUSY' : 'BUNDLE_HOST_PROFILE_LOCK_FAILED', '无法取得运行 Profile 的内核排他锁');
    }
    windowsProfileLocks.add(name);
    let released = false;
    return () => {
      if (released) return; released = true;
      try {
        const ok = release(handle), closed = close(handle);
        if (!ok || !closed) fail('BUNDLE_HOST_PROFILE_LOCK_FAILED', '无法释放运行 Profile 的内核排他锁');
      } finally { windowsProfileLocks.delete(name); }
    };
  }
  const { tryLockExclusive } = await import(pathToFileURL(persistence.resolve('@deepseek-ai/node-addon-system/flock')));
  const path = join(profiles, '.agentkit-runtime-profile.lock');
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try {
    await tryLockExclusive(handle.fd);
    const held = await handle.stat(), current = await lstat(path);
    if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) fail('BUNDLE_HOST_PROFILE_CONFLICT', '运行 Profile 的排他锁已被替换');
    return () => handle.close(); // Never unlink a live/reusable lock inode.
  } catch (error) {
    await handle.close();
    if (['EAGAIN', 'EWOULDBLOCK', 'EBUSY'].includes(error.code)) fail('BUNDLE_HOST_PROFILE_BUSY', '另一进程正在准备此运行 Profile，请稍后重试');
    throw error;
  }
}

async function prepareProfile(options) {
  const release = await acquireBundleProfileLock(options.profiles, options.modules);
  try { return await prepareLockedProfile(options); }
  finally { await release(); }
}

async function prepareLockedProfile({ profiles, profile, modules, studioDigest, expected, identity, dshVersion }) {
  await recoverProfile(profiles, profile, expected, identity);
  let legacy = false;
  if (await exists(profile)) {
    await verifyProfileConfiguration(profile, expected, { allowMissingSchedule: true });
    const target = join(profile, 'node_modules'), info = await lstat(target);
    if (info.isSymbolicLink()) {
      // This is the sole supported unmarked legacy layout; never follow an
      // arbitrary external profile or infer ownership from similar file names.
      if (await exists(join(profile, PROFILE_OWNER)) || await realpath(target) !== modules) fail('BUNDLE_HOST_PROFILE_CONFLICT', '旧运行 Profile 依赖链接不属于当前固定安装');
      legacy = true;
    } else {
      await verifyProfileConfiguration(profile, expected);
      const marker = await profileMarker(profile, identity);
      if (!marker) {
        // Bridge an exact copy from the pre-marker launcher only. Unknown old
        // code cannot become trusted merely by being placed in this directory.
        await verifyProfileModules(modules, target, studioDigest);
        await writeProfileMarker(profile, identity, dshVersion);
        return;
      }
      if (marker.dshVersion === dshVersion && marker.code.studioDigest === studioDigest) {
        try { await verifyProfileModules(modules, target, studioDigest); return; }
        catch (error) { if (error.code !== 'BUNDLE_HOST_PROFILE_CONFLICT' && error.code !== 'ENOENT') throw error; }
      }
    }
  }
  const staging = join(profiles, `.preparing-${randomUUID()}`), backup = join(profiles, `.previous-${randomUUID()}`);
  const journal = join(profiles, PROFILE_TRANSACTION);
  let previous = false;
  try {
    if (await exists(profile)) {
      await cp(profile, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        filter: path => ![join(profile, 'node_modules'), join(profile, PROFILE_OWNER)].includes(path) });
    } else {
      await directory(staging);
      await writeFile(join(staging, 'package.json'), JSON.stringify(expected, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(join(staging, 'cordis.patch.yml'), PROFILE_PATCH, { flag: 'wx', mode: 0o600 });
    }
    if (legacy) await addLegacyScheduleReadiness(staging);
    await materializeProfileModules(modules, join(staging, 'node_modules'));
    await verifyProfileModules(modules, join(staging, 'node_modules'), studioDigest);
    await verifyProfileConfiguration(staging, expected);
    await writeProfileMarker(staging, identity, dshVersion);
    if (await exists(profile)) {
      const pendingJournal = join(profiles, `.transaction-${randomUUID()}`);
      try {
        await writeFile(pendingJournal, JSON.stringify({ format: 'agentkit.runtime-profile-transaction/v1', identity,
          staging: relative(profiles, staging), backup: relative(profiles, backup) }), { flag: 'wx', mode: 0o600 });
        await rename(pendingJournal, journal); // A killed write cannot publish partial JSON.
      } finally { await rm(pendingJournal, { force: true }); }
      await rename(profile, backup); previous = true;
    }
    await rename(staging, profile);
    if (previous) await rm(journal);
    // Keep the entire previous profile (code and Settings) for explicit rollback.
  } catch (error) {
    if (previous && !await exists(profile)) { await rename(backup, profile); await rm(journal); }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** A deployment owns one persistent state directory and one immutable bundle. */
export async function prepareBundleHost({ archive, state, installation, env = process.env, expectedSha256, versionedState = false }) {
  const zip = await archiveBytes(resolve(archive)), hash = sha256(zip);
  if (expectedSha256 && (!/^[a-f0-9]{64}$/.test(expectedSha256) || expectedSha256 !== hash)) fail('BUNDLE_HOST_DIGEST_MISMATCH', '运行包与部署指定的 SHA256 不一致');
  const { manifest, definition, files } = verifyPortableBundle(zip);
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
  const importedBuild = join(home, 'studio/dist', manifest.agentId, manifest.buildId, 'agent-bundle.zip');
  if (!(await lstat(importedBuild)).isFile() || !(await readFile(importedBuild)).equals(files.find(file => file.name === 'agent-bundle.zip').data)) {
    fail('BUNDLE_HOST_STATE_CONFLICT', '保留的 Agent Build 与已验证的运行包不一致');
  }
  await loadPortableRuntime(home, childEnv);
  const profiles = await directory(join(dshHome, 'profiles')), profile = join(profiles, PROFILE);
  const expected = { name: `dsh-profile-${PROFILE}`, private: true, dsh: { profile: { bundles: BUNDLES } } };
  const studioDigest = await packageDigest(await realpath(studioRoot));
  await prepareProfile({ profiles, profile, modules, studioDigest, expected, dshVersion: dsh.version,
    identity: { bundleSha256: hash, agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId } });
  // The official launcher owns the session store, runner, loop and shutdown.
  return { entry, args: ['--profile', PROFILE, '--host', '127.0.0.1', '--no-open', '--port', '0'], cwd, env: childEnv,
    identity: { agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId, sha256: hash, dshVersion: dsh.version } };
}
