/** Resource-bearing export/import for a fixed Build, consumed by the existing DSH Host. */
import { mkdir, readFile, writeFile, rm, lstat, link } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { createZip, readZipFiles, readZipEntry, buildIdFor } from './zip.mjs';
import { createStudioBuild } from './studio-build.mjs';
import { validateBuildEngineManifest } from './build-engine.mjs';
import { createAgentStore } from './agent-store.mjs';
import { materializeCloudSkill } from './skill-files.mjs';
import { capturePortableResources, portableError, sha256, rejectInlineSecrets } from './portable-resources.mjs';

const FORMAT = 'agentkit.portable-bundle/v1';
const validBundleId = id => /^bundle_[0-9a-f]{64}$/.test(id || '');
const json = value => JSON.stringify(value, null, 2);

export function verifyPortableBundle(zip) {
  try {
    const files = readZipFiles(zip), byName = new Map(files.map(file => [file.name, file]));
    const manifest = JSON.parse(byName.get('portable.json').data.toString('utf8'));
    const { bundleId, createdAt, ...identity } = manifest;
    if (identity.format !== FORMAT || bundleId !== `bundle_${sha256(JSON.stringify(identity))}` || !/^ar-local-[a-f0-9]{16}$/.test(identity.agentId)
      || !/^build_[0-9a-f]{20}$/.test(identity.buildId) || !Array.isArray(identity.files) || !identity.resources || !Array.isArray(identity.requirements)) throw new Error('invalid manifest');
    if (files.length !== identity.files.length + 1 || new Set(identity.files.map(file => file.name)).size !== identity.files.length) throw new Error('unexpected files');
    for (const entry of identity.files) {
      const file = byName.get(entry.name);
      if (entry.name === 'portable.json' || !file || sha256(file.data) !== entry.sha256 || file.data.length !== entry.bytes || file.executable !== entry.executable) throw new Error('file changed');
      if (file.name !== 'agent-bundle.zip' && !/^skills\/[0-9a-f]{24}\/\d+\/.+/.test(file.name)) throw new Error('unexpected file');
    }
    const definition = JSON.parse(readZipEntry(byName.get('agent-bundle.zip').data, 'agent-bundle/manifest.json'));
    const { createdAt: builtAt, ...definitionIdentity } = definition;
    if (definition.agentId !== identity.agentId || buildIdFor(definitionIdentity) !== identity.buildId) throw new Error('build identity mismatch');
    validateBuildEngineManifest(definition);
    if (JSON.stringify(JSON.parse(readZipEntry(byName.get('agent-bundle.zip').data, 'agent-bundle/spec.json'))) !== JSON.stringify({ spec: definition.spec, bindings: definition.bindings })) throw new Error('build spec mismatch');
    rejectInlineSecrets(definition.spec); rejectInlineSecrets(definition.metadata);
    for (const item of identity.requirements) if (!/^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(item.name)) throw new Error('invalid credential reference');
    for (const skill of identity.resources.skills) for (const root of skill.roots) {
      if (!/^skills\/[0-9a-f]{24}\/\d+$/.test(root) || !byName.has(`${root}/SKILL.md`)) throw new Error('invalid skill root');
    }
    return { manifest, files, definition };
  } catch (error) {
    if (error.code === 'PORTABLE_INLINE_SECRET') throw error;
    throw portableError('PORTABLE_BUNDLE_INVALID', '运行包校验失败，文件或资源清单已损坏');
  }
}

export function createPortableBundles({ storeDir, build, models, adapters, configuration }) {
  async function archivePath(bundleId) {
    if (!validBundleId(bundleId)) throw portableError('PORTABLE_ID_INVALID', '运行包标识无效');
    return join(storeDir, 'portable-exports', `${bundleId}.zip`);
  }
  async function prepare(agentId, buildId) {
    const record = await build.resolve(agentId, buildId);
    if (!/^ar-local-[a-f0-9]{16}$/.test(agentId) || record.metadata.local === false) throw portableError('PORTABLE_AGENT_UNSUPPORTED', '运行包目前只支持本地 Agent Build');
    const { resources, requirements, files } = await capturePortableResources({ record, models, adapters, configuration });
    files.unshift({ name: 'agent-bundle.zip', data: Buffer.from((await build.download(agentId, buildId)).base64, 'base64'), executable: false });
    const identity = { format: FORMAT, agentId, buildId, resources, requirements,
      files: files.map(file => ({ name: file.name, bytes: file.data.length, sha256: sha256(file.data), executable: Boolean(file.executable) })) };
    const bundleId = `bundle_${sha256(JSON.stringify(identity))}`;
    const manifest = { ...identity, bundleId, createdAt: new Date().toISOString() };
    const zip = createZip([{ name: 'portable.json', data: json(manifest) }, ...files]);
    verifyPortableBundle(zip);
    const path = await archivePath(bundleId), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, zip, { flag: 'wx', mode: 0o600 });
      try { await link(temporary, path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; verifyPortableBundle(await readFile(path)); }
    }
    finally { await rm(temporary, { force: true }); }
    return { bundleId, agentId, buildId, bytes: (await lstat(path)).size, requirements, skillCount: resources.skills.length, mcpCount: resources.mcps.length, modelCount: resources.profiles.length };
  }
  async function download(agentId, buildId, bundleId) {
    const zip = await readFile(await archivePath(bundleId)), { manifest } = verifyPortableBundle(zip);
    if (manifest.agentId !== agentId || manifest.buildId !== buildId) throw portableError('PORTABLE_ID_INVALID', '运行包与所选 Build 不一致');
    return { filename: `${bundleId}.zip`, contentType: 'application/zip', bytes: zip.length, base64: zip.toString('base64') };
  }
  return { prepare, download };
}

/** Refuse any existing destination: importing never overwrites local resources or credentials. */
export async function importPortableBundle(zip, destination) {
  const { manifest, files } = verifyPortableBundle(zip), home = resolve(destination);
  await mkdir(dirname(home), { recursive: true, mode: 0o700 });
  try { await mkdir(home, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw portableError('PORTABLE_HOME_EXISTS', '目标目录已存在，请选择新的独立 AGENTKIT_HOME'); throw error; }
  try {
    await writeFile(join(home, '.portable-importing'), '', { flag: 'wx', mode: 0o600 });
    const studio = join(home, 'studio'), buildDir = join(studio, 'dist', manifest.agentId, manifest.buildId);
    await mkdir(buildDir, { recursive: true, mode: 0o700 });
    await writeFile(join(buildDir, 'agent-bundle.zip'), files.find(file => file.name === 'agent-bundle.zip').data, { flag: 'wx', mode: 0o600 });
    const record = await createStudioBuild({ storeDir: studio }).resolve(manifest.agentId, manifest.buildId);
    const agent = { metadata: { ...record.metadata, local: true }, spec: record.spec, bindings: record.bindings };
    const store = createAgentStore({ storeDir: join(studio, 'agents') });
    await store.captureRevision(agent);
    await writeFile(join(studio, 'agents', `${manifest.agentId}.json`), json(agent), { flag: 'wx', mode: 0o600 });
    await writeFile(join(studio, 'dist', manifest.agentId, 'builds.json'), json({ items: [{ id: manifest.buildId, agentId: manifest.agentId, revision: agent.metadata.revision, status: 'SUCCEEDED', artifact: 'agent-bundle.zip', createdAt: manifest.createdAt }] }), { flag: 'wx', mode: 0o600 });
    await writeFile(join(home, 'config.yaml'), stringify({ settings: { modelProfiles: manifest.resources.profiles, ...manifest.resources.cloud } }), { flag: 'wx', mode: 0o600 });
    await writeFile(join(home, 'portable-bundle.zip'), zip, { flag: 'wx', mode: 0o600 });
    await rm(join(home, '.portable-importing'));
    return { bundleId: manifest.bundleId, agentId: manifest.agentId, buildId: manifest.buildId, requirements: manifest.requirements };
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}

/** Recognized automatically only in an explicitly configured, isolated AGENTKIT_HOME. */
export async function loadPortableRuntime(home, env = process.env) {
  if (!home) return null;
  if (await lstat(join(home, '.portable-importing')).catch(() => null)) throw portableError('PORTABLE_IMPORT_INCOMPLETE', '运行包导入未完成');
  const path = join(home, 'portable-bundle.zip');
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw portableError('PORTABLE_ARCHIVE_SIZE_INVALID', '运行包必须是大小不超过 20 MiB 的普通文件');
  const { manifest, files } = verifyPortableBundle(await readFile(path));
  const missing = [...new Set(manifest.requirements.filter(item => !String(env[item.name] || '').trim()).map(item => item.name))];
  if (missing.length) throw portableError('PORTABLE_CREDENTIAL_MISSING', `目标 Host 缺少环境凭证：${missing.join(', ')}`);
  for (const [key, expected] of [['AGENTKIT_RUNTIME_AGENT_ID', manifest.agentId], ['AGENTKIT_RUNTIME_BUILD_ID', manifest.buildId]]) {
    if (env[key] !== expected) throw portableError('PORTABLE_RUNTIME_MISMATCH', `请将 ${key} 设置为运行包中对应的标识`);
  }
  const skillValues = new Map();
  for (const skill of manifest.resources.skills) {
    const definitions = [];
    for (const root of skill.roots) {
      const entries = files.filter(file => file.name.startsWith(`${root}/`)).map(file => ({ ...file, name: file.name.slice(root.length + 1) }));
      definitions.push(...await materializeCloudSkill(createZip(entries, { timestamp: new Date('2026-01-01T00:00:00Z') }), join(home, 'studio', 'portable-skills'), skill.resourceId));
    }
    skillValues.set(skill.resourceId, { name: skill.resourceId, content: definitions.map(item => item.content).join('\n\n'), definitions });
  }
  return { manifest,
    resourceStore: { get: async id => manifest.resources.mcps.find(item => item.resourceId === id) || null },
    loadSkill: async id => {
      const value = skillValues.get(String(id));
      if (!value) throw portableError('PORTABLE_SKILL_MISSING', '运行包未包含所请求的 Skill');
      return value;
    },
  };
}
