/** Prepare an installed DSH Host directly from a platform YAML declaration. */
import { copyFile, lstat, link, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadManagedRuntimeDefinition } from './managed-runtime-definition.mjs';
import { managedResourceCredentialNames } from './managed-resource-contract.mjs';
import { managedResourceServerRoot, managedResourcesNeedServer } from './managed-resource-client.mjs';
import { privateRuntimeDirectory, inspectRuntimeInstallation, prepareRuntimeProfile, runtimeProfileArgs,
  RUNTIME_PROFILE } from './runtime-host-installation.mjs';

const fail = (suffix, message) => { throw Object.assign(new Error(message), { code: `MANAGED_HOST_${suffix}` }); };

// DSH's own state (session logs, storages, credentials and Settings) is Agent
// state, not deployment-version state. Every accepted platform update mints a
// new AgentVersion id; a version-scoped DSH_HOME made that version start with
// an empty session store while the previous logs stayed stranded in the old
// version directory. Keep one DSH home per Agent, keep only Studio's immutable
// receipt and model config version-scoped, and adopt the newest legacy
// directory on the first boot after the layout change.
const DSH_HOME_DIRECTORY = 'dsh';
const DSH_ADOPTION_RECEIPT = '.dsh-adopted.json';
const DSH_SETTINGS_PATCH = join('profiles', RUNTIME_PROFILE, 'cordis.patch.yml');

// Platform-managed observability env. Runtime Service rebuilds the Langfuse
// primary route and the Server forwards the trusted CloudMonitor bundle; both
// are already applied to the pod's container env, so the Host only has to stop
// filtering them from its child. DSH_OTEL_CA_PEM_BASE64 carries an optional
// pinned trust anchor for deployments without a publicly trusted endpoint.
const MANAGED_OBSERVABILITY_ENV_NAMES = ['OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES',
  'CLOUD_MONITOR_OTLP_ENDPOINT', 'CLOUD_MONITOR_OTLP_TRACES_ENDPOINT', 'CLOUD_MONITOR_OTLP_HEADERS', 'CLOUD_MONITOR_OTLP_PROTOCOL',
  'CLOUD_MONITOR_OTLP_TRACES_PROTOCOL', 'CLOUD_MONITOR_OTLP_TRACES_HEADERS', 'CLOUD_MONITOR_APP_KEY',
  'DSH_OTEL_CA_PEM_BASE64', 'DSH_OBSERVABILITY_CAPTURE_CONTENT'];
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function immutableJson(path, value) {
  try { await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isFile()) fail('STATE_CONFLICT', '已有状态标识不是普通文件');
  let actual;
  try { actual = JSON.parse(await readFile(path, 'utf8')); } catch { fail('STATE_CONFLICT', '已有状态标识不可读取'); }
  if (!isDeepStrictEqual(actual, value)) fail('STATE_CONFLICT', '状态目录与平台 Agent 或版本配置不符');
}

async function hasDshUserState(home) {
  for (const name of ['sessions', 'storages']) {
    let entries;
    try { entries = await readdir(join(home, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entries.length) return true;
  }
  return false;
}

/**
 * Newest last-write time under the DSH user-state roots. DSH appends session
 * events in place, so a file mtime is the true "last used" signal; the version
 * receipt only records the first boot of that version.
 */
async function newestDshWriteTime(home) {
  let newest = null, visited = 0;
  const pending = [join(home, 'sessions'), join(home, 'storages')];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (++visited > 20000) return newest;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        if (newest === null || info.mtimeMs > newest) newest = info.mtimeMs;
      }
    }
  }
  return newest;
}

/** The pre-fix version directory that was written most recently. */
async function newestLegacyDshHome(versions) {
  const candidates = [];
  for (const name of await readdir(versions)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const home = join(versions, name, DSH_HOME_DIRECTORY), info = await exists(home);
    if (!info?.isDirectory()) continue;
    const state = await hasDshUserState(home);
    const settings = Boolean(await exists(join(home, DSH_SETTINGS_PATCH)));
    if (!state && !settings) continue;
    const receipt = (await exists(join(versions, name, '.managed-version.json')))?.mtimeMs ?? 0;
    // A version rollback keeps writing the older directory while the newer
    // directory only owns a newer first-boot receipt, so rank by real writes.
    const written = state ? await newestDshWriteTime(home) : null;
    candidates.push({ home, name, stamp: Math.max(receipt, written ?? 0), state });
  }
  // A store with real session/storage state always wins over a settings-only
  // directory, which a buggy update created empty on the newest version.
  const ordered = candidates.sort((left, right) => right.stamp - left.stamp);
  return ordered.find(candidate => candidate.state) ?? ordered[0] ?? null;
}

/**
 * Rewrite the adoption receipt after the home is published. A boot that died
 * after the provisional write but before the rename can leave provenance that
 * names another directory; the published home must own the final record.
 */
async function publishAdoptionReceipt(root, adopted) {
  const path = join(root, DSH_ADOPTION_RECEIPT), expected = `versions/${adopted}/dsh`;
  const existing = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing !== null) {
    try { if (JSON.parse(existing)?.adoptedFrom === expected) return; }
    catch { /* Replace unreadable provenance with the source actually adopted. */ }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ format: 'agentengine.dsh-state-adoption/v1',
      adoptedFrom: expected, adoptedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** User Settings patch of the directory recorded by the adoption receipt. */
async function adoptedSettings(root) {
  let receipt;
  try { receipt = JSON.parse(await readFile(join(root, DSH_ADOPTION_RECEIPT), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return null; }
  if (receipt?.format !== 'agentengine.dsh-state-adoption/v1' || typeof receipt.adoptedFrom !== 'string'
    || !/^versions\/[a-f0-9]{64}\/dsh$/.test(receipt.adoptedFrom)) return null;
  return readFile(join(root, receipt.adoptedFrom, DSH_SETTINGS_PATCH), 'utf8')
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

// Hard links adopt a potentially multi-GB session log without copying bytes and
// leave the old version directory bootable for a pre-fix image rollback.
async function linkStateEntry(source, target, entry) {
  if (entry.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const child of await readdir(source, { withFileTypes: true })) {
      await linkStateEntry(join(source, child.name), join(target, child.name), child);
    }
  } else if (entry.isFile()) {
    try { await link(source, target); }
    catch (error) {
      if (error.code === 'EEXIST') return;
      // Some volume drivers refuse hard links (or cross a device boundary);
      // a real copy is the lossless fallback.
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
      await copyFile(source, target);
    }
  }
  // Symbolic links are never adopted: DSH writes real files, and the private
  // state guard refuses a linked runtime directory.
}

async function adoptDshHome({ root, versions }) {
  const target = join(root, DSH_HOME_DIRECTORY), current = await exists(target);
  if (current) {
    if (!current.isDirectory()) fail('STATE_INVALID', 'DSH 状态路径必须是独立目录，不能是符号链接');
    // The receipt keeps the adopted Settings readable if a previous boot died
    // after publishing the home but before the profile was prepared.
    return { home: await privateRuntimeDirectory(target, 'MANAGED_HOST'), settings: await adoptedSettings(root) };
  }
  const legacy = await newestLegacyDshHome(versions);
  if (!legacy) return { home: await privateRuntimeDirectory(target, 'MANAGED_HOST'), settings: null };
  const staging = join(root, `.dsh-adopt-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(legacy.home, { withFileTypes: true })) {
      // Profiles are rebuilt for the running image; their Settings are seeded
      // into the new profile instead of copied as stale code.
      if (entry.name === 'profiles') continue;
      await linkStateEntry(join(legacy.home, entry.name), join(staging, entry.name), entry);
    }
    const settings = await readFile(join(legacy.home, DSH_SETTINGS_PATCH), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    // Record provenance before publishing: a crash after the rename must still
    // be able to seed the profile from the legacy directory.
    await writeFile(join(root, DSH_ADOPTION_RECEIPT), JSON.stringify({ format: 'agentengine.dsh-state-adoption/v1',
      adoptedFrom: `versions/${legacy.name}/${DSH_HOME_DIRECTORY}`, adoptedAt: new Date().toISOString() }),
    { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    try { await rename(staging, target); }
    catch (error) {
      // A concurrent prepare may have published the same Agent home first.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      return { home: await privateRuntimeDirectory(target, 'MANAGED_HOST'), settings: await adoptedSettings(root) };
    }
    await publishAdoptionReceipt(root, legacy.name);
    return { home: await privateRuntimeDirectory(target, 'MANAGED_HOST'), settings };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function prepareManagedRuntimeHost({ manifest, state, installation, env = process.env }) {
  if (typeof env.AGENTKIT_RUNTIME_TOKEN !== 'string' || env.AGENTKIT_RUNTIME_TOKEN.length < 24) fail('TOKEN_REQUIRED', '运行入口需要独立访问令牌');
  const runtime = await loadManagedRuntimeDefinition({ manifest: resolve(manifest), env });
  if (managedResourcesNeedServer(runtime.declaration.resources)) managedResourceServerRoot(env);
  const credentialNames = managedResourceCredentialNames(runtime.declaration.resources);
  for (const name of credentialNames) {
    const value = env[name];
    if (typeof value !== 'string' || !value.trim()) fail('MCP_CREDENTIAL_MISSING', '声明的 MCP 部署凭证未注入');
    if (value.length > 8192 || !/^[\x20-\x7e]+$/.test(value) || value.includes('****') || value.includes('\u2022\u2022')) fail('MCP_CREDENTIAL_INVALID', '声明的 MCP 部署凭证不可用');
  }
  const { modules, entry, dshVersion } = await inspectRuntimeInstallation(installation, 'MANAGED_HOST');
  const directory = path => privateRuntimeDirectory(path, 'MANAGED_HOST');
  const root = await directory(resolve(state)), receipt = join(root, '.managed-runtime.json');
  if (!await exists(receipt) && (await readdir(root)).length) fail('STATE_CONFLICT', '首次启动需要空的专用状态目录');
  await immutableJson(receipt, { format: 'agentengine.managed-state/v1', agentId: runtime.identity.agentId });
  const versions = await directory(join(root, 'versions'));
  // A platform VersionId is immutable. Reusing it with different manifest
  // bytes must fail instead of creating a second interpretation of a version.
  const revision = createHash('sha256').update(runtime.identity.versionId).digest('hex');
  const versionRoot = await directory(join(versions, revision));
  const versionReceipt = join(versionRoot, '.managed-version.json');
  if (!await exists(versionReceipt) && (await readdir(versionRoot)).length) fail('STATE_CONFLICT', '版本目录包含未识别状态');
  await immutableJson(versionReceipt, { format: 'agentengine.managed-version/v1', ...runtime.identity });
  const home = await directory(join(versionRoot, 'agentkit'));
  // HOME is the mounted home directory when the platform attaches a disk
  // (default /home/node), so .codex and the workspace survive pod restarts.
  // Studio's receipt and model config stay version-scoped to keep immutable
  // state, but DSH_HOME is Agent-scoped: sessions, storages and Settings are
  // the Agent's own record, so an accepted update must keep reading them.
  const userHome = await directory(resolve(env.AGENTKIT_USER_HOME || '/home/node'));
  const { home: dshHome, settings: dshSettings } = await adoptDshHome({ root, versions });
  const codexHome = await directory(join(userHome, '.codex'));
  const cwd = await directory(resolve(env.AGENTKIT_WORKSPACE_ROOT || join(userHome, 'workspace')));
  await immutableJson(join(home, 'config.yaml'), { settings: { modelProfiles: runtime.modelProfiles,
    modelName: runtime.declaration.model, modelProvider: 'openai-compatible', modelBaseUrl: runtime.modelProfiles[0].baseUrl } });
  await prepareRuntimeProfile({ dshHome, modules, identity: runtime.identity,
    profileIdentity: { agentId: runtime.identity.agentId }, dshVersion, prefix: 'MANAGED_HOST',
    patchContent: dshSettings ?? undefined });
  const names = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'KSADK_SANDBOX_BACKEND',
    'AGENTKIT_MODEL_API_KEY', 'OPENAI_BASE_URL', 'AGENTKIT_MANAGED_CODEX_API', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_RUNTIME_HOST', 'AGENTKIT_RUNTIME_PORT',
    'AGENTENGINE_MANAGED_RUNTIME_NAME', 'AGENTENGINE_MANAGED_RUNTIME_VERSION', 'AGENTENGINE_MANIFEST_PROTOCOL', 'AGENTENGINE_MANIFEST_SHA256',
    'AGENTENGINE_AGENT_ID', 'AGENTENGINE_AGENT_VERSION_ID', 'AGENTENGINE_RESOURCE_SERVER_URL', ...credentialNames,
    ...MANAGED_OBSERVABILITY_ENV_NAMES];
  const childEnv = Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  Object.assign(childEnv, { HOME: userHome, DSH_HOME: dshHome, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_CACHE_HOME: join(userHome, '.cache'), XDG_STATE_HOME: join(userHome, '.local/state'),
    AGENTKIT_HOME: home, OPENAI_MODEL_NAME: runtime.declaration.model, MODEL_PROVIDER: 'openai-compatible',
    AGENTENGINE_MANIFEST_PATH: resolve(manifest) });
  return { entry, args: runtimeProfileArgs(), cwd, env: childEnv, identity: { ...runtime.identity, dshVersion } };
}
