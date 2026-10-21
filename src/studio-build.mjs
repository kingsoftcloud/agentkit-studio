/** Local Agent build for the Studio plugin Node host.
 *
 * Port of the legacy Studio build semantics: freeze an Agent Revision into a
 * content-addressed `agent-bundle.zip` under the Studio store. The cloud
 * Agent carries its definition; the local bundle snapshots that definition
 * (manifest + spec + bindings) so later local runners and schedules execute
 * against a frozen revision. Deployment-to-cloud remains a server contract.
 */
import { mkdir, readFile, writeFile, stat, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { createZip, buildIdFor, readZipEntry } from './zip.mjs';
import { buildExecutionEngine, validateBuildEngineManifest } from './build-engine.mjs';

export class BuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.details = details;
  }
}

export function createStudioBuild({ storeDir, nativeEngineContract } = {}) {
  buildExecutionEngine({}, nativeEngineContract);
  const root = storeDir;
  const pending = new Map();

  function agentDir(agentId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}$/.test(String(agentId)) || agentId === '..') throw new BuildError('BUILD_AGENT_ID_INVALID', 'AgentId 格式无效');
    return join(root, 'dist', agentId);
  }

  async function readBuilds(agentId) {
    let builds;
    try { builds = await readFile(join(agentDir(agentId), 'builds.json'), 'utf8'); } catch { return []; }
    try { const parsed = JSON.parse(builds); return Array.isArray(parsed.items) ? parsed.items : []; } catch { return []; }
  }

  async function writeBuilds(agentId, items) {
    const dir = agentDir(agentId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(dir, 'builds.json'), JSON.stringify({ items }, null, 2));
  }

  async function atomicWrite(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, value, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }

  function build(input) {
    const snapshot = structuredClone(input);
    const key = String(snapshot?.agentId || '');
    const previous = pending.get(key) || Promise.resolve();
    const result = previous.then(() => buildSnapshot(snapshot));
    const settled = result.catch(() => {});
    pending.set(key, settled);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return result;
  }

  async function buildSnapshot({ agentId, agentName, revision, spec, bindings = {}, metadata = {}, executionEngine }) {
    if (!agentId) throw new BuildError('BUILD_AGENT_ID_MISSING', 'AgentId 不能为空');
    if (!Number.isSafeInteger(revision) || revision < 1 || (metadata.revision !== undefined && metadata.revision !== revision)) throw new BuildError('BUILD_REVISION_INVALID', '构建 Revision 无效或与 Agent 定义不一致');
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new BuildError('BUILD_DEFINITION_INVALID', '构建缺少有效的 Agent 定义');
    // The build id is content-addressed over the frozen definition and engine,
    // never the wall clock, so rebuilding the same definition and engine is idempotent
    // (same contract as the legacy builder's resolved digest).
    const selectedEngine = buildExecutionEngine(spec, nativeEngineContract);
    if (executionEngine !== undefined && !isDeepStrictEqual(executionEngine, selectedEngine)) throw new BuildError('BUILD_ENGINE_BINDING_CHANGED', '构建引擎绑定已变化');
    const identity = { format: selectedEngine ? 'agentkit.agent-bundle/v2' : 'agentkit.agent-bundle/v1', agentId, name: String(agentName || agentId), revision: Number(revision) || 1, bindings, metadata, spec: spec ?? null,
      ...(selectedEngine ? { executionEngine: selectedEngine } : {}) };
    const buildId = buildIdFor(identity);
    const manifest = { ...identity, createdAt: new Date().toISOString() };
    const dir = join(agentDir(agentId), buildId);
    let existing;
    try { existing = await stat(join(dir, 'agent-bundle.zip')); } catch { existing = null; }
    if (existing?.isFile()) {
      await verifiedArchive(agentId, buildId);
      const builds = await readBuilds(agentId);
      return builds.find(item => item.id === buildId) || { id: buildId, revision: manifest.revision, status: 'SUCCEEDED', createdAt: manifest.createdAt, artifact: 'agent-bundle.zip' };
    }
    const zip = createZip([
      { name: 'agent-bundle/manifest.json', data: JSON.stringify(manifest, null, 2) },
      { name: 'agent-bundle/spec.json', data: JSON.stringify({ spec: manifest.spec, bindings: manifest.bindings }, null, 2) },
      { name: 'agent-bundle/README.md', data: `# ${manifest.name}\n\nLocal build ${buildId} of revision ${manifest.revision}.\nFrozen by AgentKit Studio; deployed execution still requires the AgentEngine Server deployment contract.\n` },
    ]);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(dir, 'agent-bundle.zip'), zip);
    const record = {
      id: buildId,
      agentId,
      revision: manifest.revision,
      ...(selectedEngine ? { executionEngine: selectedEngine } : {}),
      status: 'SUCCEEDED',
      createdAt: manifest.createdAt,
      artifact: 'agent-bundle.zip',
      digest: buildId.replace('build_', ''),
      bytes: zip.length,
    };
    const builds = await readBuilds(agentId);
    builds.unshift(record);
    await writeBuilds(agentId, builds);
    return record;
  }

  async function list(agentId) {
    return readBuilds(agentId);
  }

  async function artifactPath(agentId, buildId) {
    if (!/^build_[0-9a-f]{20}$/.test(String(buildId))) throw new BuildError('BUILD_ID_INVALID', 'BuildId 格式无效');
    return join(agentDir(agentId), buildId, 'agent-bundle.zip');
  }

  async function verifiedArchive(agentId, buildId) {
    const path = await artifactPath(agentId, buildId);
    let zip;
    try { zip = await readFile(path); } catch (error) {
      if (error.code === 'ENOENT') throw new BuildError('BUILD_NOT_FOUND', '构建产物不存在', { agentId, buildId });
      throw error;
    }
    try {
      const manifest = JSON.parse(readZipEntry(zip, 'agent-bundle/manifest.json').toString('utf8'));
      const { createdAt, ...identity } = manifest;
      if (manifest.agentId !== agentId || buildIdFor(identity) !== buildId || !manifest.spec) throw new Error('bundle identity mismatch');
      validateBuildEngineManifest(manifest);
      const spec = JSON.parse(readZipEntry(zip, 'agent-bundle/spec.json').toString('utf8'));
      if (!isDeepStrictEqual(spec, { spec: manifest.spec, bindings: manifest.bindings })) throw new Error('bundle spec mismatch');
      return { zip, record: {
        metadata: { ...manifest.metadata, id: agentId, name: manifest.name, revision: manifest.revision },
        spec: { ...manifest.spec, bindings: manifest.bindings },
        bindings: manifest.bindings,
        buildId,
        ...(manifest.executionEngine ? { executionEngine: manifest.executionEngine } : {}),
      } };
    } catch (error) {
      throw new BuildError('BUILD_ARTIFACT_INVALID', '构建产物损坏或与 BuildId 不匹配', { agentId, buildId });
    }
  }

  async function resolve(agentId, buildId) { return (await verifiedArchive(agentId, buildId)).record; }
  async function download(agentId, buildId) {
    const { zip } = await verifiedArchive(agentId, buildId);
    if (zip.length > 4 * 1024 * 1024) throw new BuildError('BUILD_DOWNLOAD_TOO_LARGE', '构建产物超过本地下载上限（4 MiB）');
    return { filename: `${agentId}-${buildId}.zip`, contentType: 'application/zip', bytes: zip.length, base64: zip.toString('base64') };
  }

  return { build, list, artifactPath, resolve, download,
    executionEngineFor: spec => buildExecutionEngine(spec, nativeEngineContract) };
}
