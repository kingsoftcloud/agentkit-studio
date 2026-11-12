/** Offline boot preparation over the public DSH profile/package contract. */
import { link, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importPortableBundle, loadPortableRuntime, verifyPortableBundle } from './portable-bundle.mjs';
import { portableError, sha256, validatePortableCredentialNames } from './portable-resources.mjs';
import { privateRuntimeDirectory as directory, inspectRuntimeInstallation, prepareRuntimeProfile, runtimeProfileArgs } from './runtime-host-installation.mjs';
export { acquireBundleProfileLock } from './runtime-host-installation.mjs';

const fail = (code, message) => { throw portableError(code, message); };
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function archiveBytes(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) fail('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包必须是大小不超过 20 MiB 的普通文件');
  return readFile(path);
}

/** Hard-link a version-scoped directory into the Agent-scoped state root. */
async function linkStateEntry(source, target, entry) {
  if (entry.isDirectory()) {
    await directory(target);
    for (const child of await readdir(source, { withFileTypes: true })) {
      await linkStateEntry(join(source, child.name), join(target, child.name), child);
    }
  } else if (entry.isFile()) {
    try { await link(source, target); }
    catch (error) {
      if (error.code === 'EEXIST') return;
      // Some volume drivers refuse hard links (or cross a device boundary); a
      // real copy is the lossless fallback.
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
      await copyFile(source, target);
    }
  }
}

async function stateSource(root, names) {
  const entries = [];
  let mtimeMs = 0;
  for (const name of names) {
    const source = join(root, name), info = await exists(source);
    if (!info) continue;
    if (!info.isDirectory()) continue;
    entries.push(name);
    mtimeMs = Math.max(mtimeMs, info.mtimeMs);
  }
  return entries.length ? { root, names: entries, mtimeMs } : null;
}

/** Find the newest legacy version directory that still contains Agent state. */
async function findVersionedAgentState({ parent, root, hash }) {
  const versions = join(parent, 'versions'), candidates = [];
  const current = await stateSource(root, ['dsh', 'home', 'workspace']);
  if (current) candidates.push({ ...current, adoptedFrom: `versions/${hash}` });
  const entries = await readdir(versions, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === hash) continue;
    const candidate = await stateSource(join(versions, entry.name), ['dsh', 'home', 'workspace']);
    if (candidate) candidates.push({ ...candidate, adoptedFrom: `versions/${entry.name}` });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function stageStateDirectory(source, staging) {
  await directory(staging);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await linkStateEntry(join(source, entry.name), join(staging, entry.name), entry);
  }
}

/**
 * Versioned state made every directory of the deployment version-scoped, so an
 * accepted update started the new bundle with an empty DSH home while the
 * previous sessions stayed stranded under `versions/<sha256>/dsh`. Only the
 * immutable receipt and the imported运行包 belong to a version; the DSH home,
 * the user home and the workspace belong to the Agent.
 *
 * The newest versioned directory that actually holds session state is taken over
 * once with hard links (the source directory is left untouched, so a rollback to
 * a version-scoped bundle still reads it) and every later boot reuses the
 * Agent-scoped directory directly.
 */
async function adoptVersionedAgentState({ parent, root, hash }) {
  const receiptPath = join(parent, '.agentkit-agent-state.json');
  if (await exists(receiptPath)) return;
  const source = await findVersionedAgentState({ parent, root, hash });
  if (source) {
    for (const name of source.names) {
      const target = join(parent, name);
      if (await exists(target)) continue;
      const stagingRoot = join(parent, `.agent-state-${randomUUID()}`), staging = join(stagingRoot, name);
      try {
        await stageStateDirectory(join(source.root, name), staging);
        try { await rename(staging, target); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        }
      } finally { await rm(stagingRoot, { recursive: true, force: true }); }
    }
  }
  // Publish the completion receipt only after every state directory has been
  // moved into place. If the process dies between directory renames, the next
  // boot sees no receipt and resumes the missing directories without replacing
  // any state that was already published.
  try {
    await writeFile(receiptPath, JSON.stringify({
      format: 'agentkit.bundle-agent-state-adoption/v1',
      adoptedFrom: source?.adoptedFrom || null, adoptedAt: new Date().toISOString(),
    }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
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

  const { modules, entry, dshVersion } = await inspectRuntimeInstallation(installation);

  const parent = await directory(resolve(state));
  const root = versionedState ? await directory(join(await directory(join(parent, 'versions')), hash)) : parent;
  const receiptPath = join(root, '.agentkit-runtime.json');
  const receipt = { format: 'agentkit.runtime-state/v1', bundleSha256: hash };
  if (!await exists(receiptPath)) {
    if ((await readdir(root)).length) fail('BUNDLE_HOST_STATE_CONFLICT', '首次启动需要空的独立状态目录');
    await writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  }
  if (!(await lstat(receiptPath)).isFile() || JSON.stringify(await json(receiptPath)) !== JSON.stringify(receipt)) fail('BUNDLE_HOST_STATE_CONFLICT', '此状态目录属于另一运行包或不是此 Host 创建的目录');
  // The receipt and the imported bundle are version state; the DSH home, user
  // home and workspace are Agent state and must survive an accepted update.
  if (versionedState) await adoptVersionedAgentState({ parent, root, hash });
  const agentRoot = versionedState ? parent : root;
  const home = join(root, 'agentkit'), dshHome = await directory(join(agentRoot, 'dsh'));
  const userHome = await directory(join(agentRoot, 'home')), cwd = await directory(join(agentRoot, 'workspace'));
  // Only declared resource credentials enter the Host; NODE_OPTIONS, personal
  // profile paths, cloud credentials and proxy configuration are not inherited.
  const childEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'AGENTKIT_DEPLOYMENT_VERSION', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_RUNTIME_HOST', 'AGENTKIT_RUNTIME_PORT', 'AGENTKIT_RUNTIME_TIMEOUT_MS', ...manifest.requirements.map(item => item.name)]
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
  // One Agent-scoped DSH home is reused across versions, so the profile marker
  // must carry the Agent identity rather than the per-version bundle digest;
  // otherwise an accepted update rejects the existing profile as foreign. The
  // installed code is still pinned by `dshVersion` and the Studio digest.
  await prepareRuntimeProfile({ dshHome, modules, dshVersion,
    identity: { bundleSha256: hash, agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId },
    ...(versionedState ? { profileIdentity: { agentId: manifest.agentId } } : {}) });
  // The official launcher owns the session store, runner, loop and shutdown.
  return { entry, args: runtimeProfileArgs(), cwd, env: childEnv,
    identity: { agentId: manifest.agentId, buildId: manifest.buildId, bundleId: manifest.bundleId, sha256: hash, dshVersion } };
}
