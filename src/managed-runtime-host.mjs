/** Prepare an installed DSH Host directly from a platform YAML declaration. */
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadManagedRuntimeDefinition } from './managed-runtime-definition.mjs';
import { managedResourceCredentialNames } from './managed-resource-contract.mjs';
import { managedResourceServerRoot, managedResourcesNeedServer } from './managed-resource-client.mjs';
import { privateRuntimeDirectory, inspectRuntimeInstallation, prepareRuntimeProfile, runtimeProfileArgs } from './runtime-host-installation.mjs';

const fail = (suffix, message) => { throw Object.assign(new Error(message), { code: `MANAGED_HOST_${suffix}` }); };
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function immutableJson(path, value) {
  try { await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isFile()) fail('STATE_CONFLICT', '已有状态标识不是普通文件');
  let actual;
  try { actual = JSON.parse(await readFile(path, 'utf8')); } catch { fail('STATE_CONFLICT', '已有状态标识不可读取'); }
  if (!isDeepStrictEqual(actual, value)) fail('STATE_CONFLICT', '状态目录与平台 Agent 或版本配置不符');
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
  const userHome = await directory(join(versionRoot, 'home')), dshHome = await directory(join(versionRoot, 'dsh'));
  const cwd = await directory(join(versionRoot, 'workspace'));
  await immutableJson(join(home, 'config.yaml'), { settings: { modelProfiles: runtime.modelProfiles,
    modelName: runtime.declaration.model, modelProvider: 'openai-compatible', modelBaseUrl: runtime.modelProfiles[0].baseUrl } });
  await prepareRuntimeProfile({ dshHome, modules, identity: runtime.identity, dshVersion, prefix: 'MANAGED_HOST' });
  const names = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'AGENTKIT_MODEL_API_KEY', 'OPENAI_BASE_URL', 'AGENTKIT_MANAGED_CODEX_API', 'AGENTKIT_RUNTIME_TOKEN', 'AGENTKIT_RUNTIME_HOST', 'AGENTKIT_RUNTIME_PORT',
    'AGENTENGINE_MANAGED_RUNTIME_NAME', 'AGENTENGINE_MANAGED_RUNTIME_VERSION', 'AGENTENGINE_MANIFEST_PROTOCOL', 'AGENTENGINE_MANIFEST_SHA256',
    'AGENTENGINE_AGENT_ID', 'AGENTENGINE_AGENT_VERSION_ID', 'AGENTENGINE_RESOURCE_SERVER_URL', ...credentialNames];
  const childEnv = Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
  Object.assign(childEnv, { HOME: userHome, DSH_HOME: dshHome, CODEX_HOME: join(userHome, '.codex'),
    XDG_CONFIG_HOME: join(userHome, '.config'), XDG_CACHE_HOME: join(userHome, '.cache'), XDG_STATE_HOME: join(userHome, '.local/state'),
    AGENTKIT_HOME: home, OPENAI_MODEL_NAME: runtime.declaration.model, MODEL_PROVIDER: 'openai-compatible',
    AGENTENGINE_MANIFEST_PATH: resolve(manifest) });
  return { entry, args: runtimeProfileArgs(), cwd, env: childEnv, identity: { ...runtime.identity, dshVersion } };
}
