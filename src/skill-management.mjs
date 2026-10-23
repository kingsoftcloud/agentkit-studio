/** Host-owned Skill discovery/install/binding. No model-selected local paths,
 * runtime code execution, Python, or fabricated Native execution identity. */
import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { canonical, copy, invariant, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, openPrivate, privateDirectory } from '../packages/agentkit-harness/src/native/local-command-state.mjs';
import { commandStateRoot } from './providers/dsh-node-command-ledger.mjs';
import { parseFrontmatter, skillSlug } from './skill-discovery.mjs';

export const SKILL_MANAGEMENT_CONTRACT = 'agentkit.studio-skill-management/v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const ids = { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: text };
const definition = (name, description, properties, required = [], extra = {}) => ({ name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false, ...extra },
  readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 120000 });
export const skillManagementDefinitions = () => copy([
  definition('skill_discover_github', 'Search public GitHub or inspect immutable Skill candidates. Never executes repository code.',
    { source: text, ref: text, limit: { type: 'integer', minimum: 1, maximum: 10 } }, ['source']),
  definition('skill_install', 'Install previously inspected cached Skill candidates. Agent binding remains separate.',
    { inspection_token: text, candidate_id: text, candidate_ids: ids, overwrite: { type: 'boolean' } }, ['inspection_token'],
    { anyOf: [{ required: ['candidate_id'] }, { required: ['candidate_ids'] }] }),
  definition('skill_bind_agent', 'Bind ready installed Skills to the next Agent revision. Current immutable execution is unchanged.',
    { resource_id: text, resource_ids: ids }, [], { anyOf: [{ required: ['resource_id'] }, { required: ['resource_ids'] }] }),
]);
const selected = (one, many) => [...new Set([one, ...(many ?? [])].filter(Boolean))];
const safePath = value => typeof value === 'string' && value && value.length <= 1024 && !/[\\\x00-\x1f\x7f]/u.test(value)
  && !posix.isAbsolute(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
function guardRequest(request) {
  invariant(request?.signal instanceof AbortSignal && typeof request.assertCurrent === 'function', 'skill_management_authority_missing');
  request.signal.throwIfAborted(); const current = request.assertCurrent();
  if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
  invariant(current === true, 'skill_management_authority_lost'); request.signal.throwIfAborted();
}
function guarded(request, work) {
  guardRequest(request);
  return new Promise((resolve, reject) => {
    const abort = () => reject(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { guardRequest(request); return work(); }).then(value => {
      try { guardRequest(request); resolve(value); } catch (error) { reject(error); }
    }, reject).finally(() => request.signal.removeEventListener('abort', abort)).catch(() => {});
    if (request.signal.aborted) abort();
  });
}

export function createStudioSkillManagement({ workspaceRoot, stateDir, agentId, skillDiscovery, agents, source } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && typeof skillDiscovery?.registerBundleSkills === 'function'
    && typeof agents?.get === 'function' && typeof agents?.update === 'function'
    && typeof source?.search === 'function' && typeof source?.inspect === 'function', 'skill_management_binding_invalid');
  const state = commandStateRoot(join(stateDir, 'skill-management'), workspaceRoot, agentId);
  // Inspections belong to one Agent, while immutable content belongs to the
  // shared installed-resource catalog. The same resource cannot point to two
  // different Agent-private directories when another Agent installs it.
  const root = state.root, inspections = join(root, 'inspections'), packages = join(realpathSync(join(stateDir, 'skill-management')), 'packages');
  privateDirectory(inspections, true); privateDirectory(packages, true);
  const guard = request => { guardRequest(request); state.guard(); };
  const readInspection = token => {
    invariant(/^skg_[a-f0-9]{64}$/.test(token), 'skill_management_inspection_invalid'); state.guard();
    const fd = openPrivate(join(inspections, `${token}.json`), constants.O_RDONLY);
    try {
      invariant(fstatSync(fd).size <= 16 * 1024 * 1024, 'skill_management_inspection_limit');
      const record = parseNativeJson(readFileSync(fd, 'utf8'));
      invariant(record.contract === SKILL_MANAGEMENT_CONTRACT && record.agentId === agentId
        && record.token === token && record.digest === sha(canonical(record.snapshot)), 'skill_management_inspection_invalid');
      return record.snapshot;
    } finally { closeSync(fd); }
  };
  function snapshot(value) {
    invariant(/^[a-f0-9]{40}$/.test(value?.commit) && Array.isArray(value.candidates)
      && value.candidates.length <= 16, 'skill_management_source_invalid');
    let total = 0;
    const ids = new Set();
    const candidates = value.candidates.map(candidate => {
      invariant(typeof candidate.candidateId === 'string' && candidate.candidateId && !ids.has(candidate.candidateId)
        && (candidate.path === '' || safePath(candidate.path)) && Array.isArray(candidate.files)
        && candidate.files.length > 0 && candidate.files.length <= 256, 'skill_management_source_invalid');
      ids.add(candidate.candidateId); const paths = new Set();
      const files = candidate.files.map(file => {
        invariant(safePath(file.path) && !paths.has(file.path) && file.bytes instanceof Uint8Array
          && file.bytes.length <= 512 * 1024, 'skill_management_source_invalid');
        paths.add(file.path); total += file.bytes.length;
        invariant(total <= 8 * 1024 * 1024, 'skill_management_source_limit');
        const bytes = Buffer.from(file.bytes);
        return { path: file.path, body: bytes.toString('base64'), sha256: sha(bytes) };
      });
      invariant([...paths].every(path => path.split('/').slice(0, -1)
        .every((_, i, parts) => !paths.has(parts.slice(0, i + 1).join('/')))), 'skill_management_source_invalid');
      const manifest = files.find(file => file.path === 'SKILL.md'); invariant(manifest, 'skill_management_manifest_missing');
      const metadata = parseFrontmatter(Buffer.from(manifest.body, 'base64').toString('utf8'));
      const name = skillSlug(metadata.name), version = String(metadata.version || '1.0.0');
      invariant(version.length <= 128 && !/[\x00-\x1f]/.test(version), 'skill_management_manifest_invalid');
      return { candidateId: candidate.candidateId, path: candidate.path, name, version,
        displayName: String(metadata.name), description: String(metadata.description || '').slice(0, 4096), files };
    });
    return { repository: copy(value.repository), commit: value.commit, candidates };
  }
  const descriptor = (record, candidate) => {
    const digest = sha(canonical({ repository: record.repository, commit: record.commit, candidate }));
    return { resourceId: `skill-catalog-${digest.slice(0, 24)}`, name: candidate.name, displayName: candidate.displayName,
      description: candidate.description, version: candidate.version, status: 'ready', kind: 'skill', source: 'github-import',
      digest, directory: join(packages, digest), fileCount: candidate.files.length };
  };
  const publicDescriptor = ({ directory: _, ...value }) => value;
  return { contract: SKILL_MANAGEMENT_CONTRACT,
    binding: { contract: SKILL_MANAGEMENT_CONTRACT, agentId, workspace: state.workspace, source: 'public-github-immutable/v1' },
    async execute(name, args, request) {
      guard(request);
      if (name === 'skill_discover_github') {
        const value = args.source.trim();
        if (!/^(?:https?:\/\/github\.com\/|git@github\.com:)/.test(value)) {
          const result = await guarded(request, () => source.search(value, { limit: args.limit ?? 5, signal: request.signal,
            assertCurrent: () => { guard(request); return true; } })); guard(request);
          return { ok: true, mode: 'search', query: value, repositories: result.repositories,
            next: 'Choose the exact repository URL and inspect it before installing.' };
        }
        const result = await guarded(request, () => source.inspect(value, { ref: args.ref ?? 'main', signal: request.signal,
          assertCurrent: () => { guard(request); return true; } })); guard(request);
        const content = snapshot(result), token = `skg_${randomBytes(32).toString('hex')}`;
        const record = { contract: SKILL_MANAGEMENT_CONTRACT, agentId, token, snapshot: content, digest: sha(canonical(content)) };
        guard(request); atomicPrivate(join(inspections, `${token}.json`), canonical(record)); guard(request);
        return { ok: true, mode: 'inspection', inspectionToken: token, repository: content.repository, commit: content.commit,
          requiresConfirmation: true, candidates: content.candidates.map(({ files, ...candidate }) => ({ ...candidate,
            fileCount: files.length, totalBytes: files.reduce((n, file) => n + Buffer.from(file.body, 'base64').length, 0) })) };
      }
      if (name === 'skill_install') {
        const chosen = selected(args.candidate_id, args.candidate_ids); invariant(chosen.length && chosen.length <= 16, 'candidate_required');
        const record = readInspection(args.inspection_token), installed = [], failures = [];
        for (const candidateId of chosen) {
          const candidate = record.candidates.find(item => item.candidateId === candidateId);
          if (!candidate) { failures.push({ candidate_id: candidateId, ok: false, error_type: 'skill_management_candidate_not_found' }); continue; }
          guard(request); const item = descriptor(record, candidate);
          try {
            privateDirectory(item.directory, true);
            for (const file of candidate.files) {
              guard(request); invariant(safePath(file.path), 'skill_management_inspection_invalid');
              const bytes = Buffer.from(file.body, 'base64'); invariant(sha(bytes) === file.sha256, 'skill_management_inspection_invalid');
              const path = join(item.directory, file.path); privateDirectory(dirname(path), true); guard(request); atomicPrivate(path, bytes);
            }
            guard(request);
            await guarded(request, () => skillDiscovery.registerBundleSkills([item], { assertCurrent: () => { guard(request); return true; },
              overwrite: args.overwrite === true, rejectNameConflict: true })); guard(request);
            installed.push(publicDescriptor(item));
          } catch (error) {
            guard(request);
            // Unknown publication must propagate to the outer durable execution
            // owner. Only known validation/conflict failures form partial results.
            if (!['SKILL_ALREADY_EXISTS', 'SKILL_BUNDLE_CONFLICT'].includes(error.code)) throw error;
            failures.push({ candidate_id: candidateId, ok: false, error_type: error.code });
          }
        }
        return { ok: !failures.length, installed, failures, ...(installed.length === 1 ? { installed_resource: installed[0] } : {}),
          next: 'Call skill_bind_agent with installed resourceIds to bind them.' };
      }
      invariant(name === 'skill_bind_agent', 'skill_management_tool_unbound');
      const chosen = selected(args.resource_id, args.resource_ids); invariant(chosen.length && chosen.length <= 16, 'resource_required');
      const catalog = await guarded(request, () => skillDiscovery.listInstalled()); guard(request);
      invariant(chosen.every(id => catalog.items.some(item => item.resourceId === id && item.kind === 'skill' && item.status === 'ready')),
        'skill_not_ready');
      const current = await guarded(request, () => agents.get(agentId)); guard(request);
      invariant(current?.metadata?.id === agentId, 'skill_management_agent_missing');
      const bindings = copy(current.spec?.bindings ?? current.bindings ?? {});
      const existing = new Set((bindings.skills ?? []).map(item => typeof item === 'string' ? item : item.resourceId));
      const additions = chosen.filter(id => !existing.has(id));
      if (!additions.length) return { ok: true, already_bound: true, agent_id: agentId, resource_ids: chosen,
        revision: current.metadata.revision, effective_from: 'next_run' };
      bindings.skills = [...(bindings.skills ?? []), ...additions.map(resourceId => ({ resourceId, enabled: true }))];
      const updated = await guarded(request, () => agents.update(agentId, { bindings, expectedRevision: current.metadata.revision },
        { assertCurrent: () => { guard(request); return true; } })); guard(request);
      return { ok: true, already_bound: false, agent_id: agentId, resource_ids: additions, revision: updated.metadata.revision,
        effective_from: 'next_run', message: 'Skill binding is saved for the next Agent run.' };
    },
  };
}
