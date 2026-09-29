/** Local Agent build for the Studio plugin Node host.
 *
 * Port of the legacy Studio build semantics: freeze an Agent Revision into a
 * content-addressed `agent-bundle.zip` under the Studio store. The cloud
 * Agent carries its definition; the local bundle snapshots that definition
 * (manifest + spec + bindings) so later local runners and schedules execute
 * against a frozen revision. Deployment-to-cloud remains a server contract.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createZip, buildIdFor } from './zip.mjs';

export class BuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.details = details;
  }
}

export function createStudioBuild({ storeDir } = {}) {
  const root = storeDir;

  function agentDir(agentId) {
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
    await writeFile(join(dir, 'builds.json'), JSON.stringify({ items }, null, 2));
  }

  async function build({ agentId, agentName, revision, spec, bindings = {}, metadata = {} }) {
    if (!agentId) throw new BuildError('BUILD_AGENT_ID_MISSING', 'AgentId 不能为空');
    // The build id is content-addressed over the frozen definition only —
    // never the wall clock — so rebuilding an unchanged revision is idempotent
    // (same contract as the legacy builder's resolved digest).
    const identity = { format: 'agentkit.agent-bundle/v1', agentId, name: String(agentName || agentId), revision: Number(revision) || 1, bindings, metadata, spec: spec ?? null };
    const buildId = buildIdFor(identity);
    const manifest = { ...identity, createdAt: new Date().toISOString() };
    const dir = join(agentDir(agentId), buildId);
    let existing;
    try { existing = await stat(join(dir, 'agent-bundle.zip')); } catch { existing = null; }
    if (existing?.isFile()) {
      const builds = await readBuilds(agentId);
      return builds.find(item => item.id === buildId) || { id: buildId, revision: manifest.revision, status: 'SUCCEEDED', createdAt: manifest.createdAt, artifact: 'agent-bundle.zip' };
    }
    const zip = createZip([
      { name: 'agent-bundle/manifest.json', data: JSON.stringify(manifest, null, 2) },
      { name: 'agent-bundle/spec.json', data: JSON.stringify({ spec: manifest.spec, bindings: manifest.bindings }, null, 2) },
      { name: 'agent-bundle/README.md', data: `# ${manifest.name}\n\nLocal build ${buildId} of revision ${manifest.revision}.\nFrozen by AgentKit Studio; deployed execution still requires the AgentEngine Server deployment contract.\n` },
    ]);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'agent-bundle.zip'), zip);
    const record = {
      id: buildId,
      agentId,
      revision: manifest.revision,
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
    return join(agentDir(agentId), buildId, 'agent-bundle.zip');
  }

  return { build, list, artifactPath };
}
