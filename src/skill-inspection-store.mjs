// Private, immutable inspection bytes. The token index is published last;
// incomplete writes cannot become an installable inspection after a crash.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, copy, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { atomicPrivate, openPrivate, privateDirectory } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';
import { parseFrontmatter, skillSlug } from './skill-discovery.mjs';
import { skillCandidateExcluded, skillCandidateRisk } from './skill-candidate-metadata.mjs';

export const SKILL_INSPECTION_STORAGE = 'agentkit.skill-inspection-blobs/v2';
export const MAX_SKILL_CANDIDATES = 5000;
const SKILL_BYTES = 100 * 1024 * 1024, INSPECTION_BYTES = 200 * 1024 * 1024, INDEX_BYTES = 16 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
export const safeSkillPath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\\\x00-\x1f\x7f]/u.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sortPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const publicCandidate = ({ files: _, ...value }) => value;

export function createSkillInspectionStore({ root, agentId, contract, guard }) {
  const inspections = join(root, 'inspections'), blobs = join(root, 'blobs');
  privateDirectory(inspections, true); privateDirectory(blobs, true);
  function read(path, limit) {
    const fd = openPrivate(path, constants.O_RDONLY);
    try { invariant(fstatSync(fd).size <= limit, 'skill_management_inspection_limit'); return readFileSync(fd); }
    finally { closeSync(fd); }
  }
  function json(path, limit = INDEX_BYTES) { return parseNativeJson(read(path, limit).toString('utf8')); }
  function writeJson(path, value) {
    const bytes = canonical(value); invariant(Buffer.byteLength(bytes) <= INDEX_BYTES, 'skill_management_inspection_limit');
    atomicPrivate(path, bytes);
  }
  return {
    persist(value, token, request) {
      invariant(/^[a-f0-9]{40}$/.test(value?.commit) && Array.isArray(value.candidates)
        && value.candidates.length <= MAX_SKILL_CANDIDATES, 'skill_management_source_invalid');
      const directory = join(inspections, token); guard(request); privateDirectory(directory, true);
      const ids = new Set(), stored = new Set(), repositoryFiles = new Map(), candidates = [], result = [];
      let totalBytes = 0;
      for (const input of value.candidates) {
        guard(request);
        invariant(typeof input.candidateId === 'string' && input.candidateId.length > 0 && input.candidateId.length <= 2048
          && !ids.has(input.candidateId) && (input.path === '' || safeSkillPath(input.path))
          && Array.isArray(input.files), 'skill_management_source_invalid');
        ids.add(input.candidateId);
        let candidate;
        if (input.status === 'invalid') {
          invariant(input.files.length === 0, 'skill_management_source_invalid');
          candidate = { candidateId: input.candidateId, path: input.path, status: 'invalid',
            name: input.path.split('/').pop() || value.repository?.name || 'invalid-skill', version: '', description: '',
            risk: { requiresReview: true }, diagnostics: [{ code: /^[A-Za-z0-9_]{1,100}$/.test(input.diagnostics?.[0]?.code)
              ? input.diagnostics[0].code : 'skill_management_candidate_invalid', message: 'Skill candidate could not be inspected.' }], files: [] };
        } else {
          const accepted = input.files.filter(file => !skillCandidateExcluded(file.path));
          invariant(accepted.length > 0 && accepted.length <= 1000, 'skill_management_source_invalid');
          const paths = new Set(), files = []; let size = 0, manifestText;
          for (const file of accepted.sort(sortPath)) {
            guard(request);
            invariant(safeSkillPath(file.path) && !paths.has(file.path) && file.bytes instanceof Uint8Array,
              'skill_management_source_invalid');
            paths.add(file.path); size += file.bytes.byteLength;
            invariant(size <= SKILL_BYTES, 'skill_management_source_limit');
            const bytes = Buffer.from(file.bytes), digest = sha(bytes), path = [input.path, file.path].filter(Boolean).join('/');
            const previous = repositoryFiles.get(path);
            invariant(!previous || previous === digest, 'skill_management_source_invalid');
            if (!previous) {
              repositoryFiles.set(path, digest); totalBytes += bytes.byteLength;
              invariant(totalBytes <= INSPECTION_BYTES && repositoryFiles.size <= 5000, 'skill_management_source_limit');
            }
            if (!stored.has(digest)) { guard(request); atomicPrivate(join(blobs, digest), bytes); stored.add(digest); }
            files.push({ path: file.path, sha256: digest, size: bytes.byteLength });
            if (file.path === 'SKILL.md') {
              try { manifestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
              catch { invariant(false, 'skill_management_manifest_invalid'); }
            }
          }
          invariant([...paths].every(path => path.split('/').slice(0, -1)
            .every((_, i, parts) => !paths.has(parts.slice(0, i + 1).join('/')))), 'skill_management_source_invalid');
          invariant(manifestText !== undefined, 'skill_management_manifest_missing');
          const metadata = parseFrontmatter(manifestText, { strict: true }), name = skillSlug(metadata.name), version = String(metadata.version || '1.0.0');
          invariant(typeof metadata.description === 'string' && metadata.description.trim()
            && version.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version),
          'skill_management_manifest_invalid');
          candidate = { candidateId: input.candidateId, path: input.path, name, version,
            displayName: String(metadata.name), description: metadata.description.slice(0, 4096), status: 'ready',
            fileCount: files.length, totalBytes: size, risk: skillCandidateRisk({ manifestText, paths: files.map(file => file.path) }),
            diagnostics: [], files };
        }
        const detailDigest = sha(canonical(candidate)); guard(request);
        writeJson(join(directory, `${detailDigest}.json`), candidate);
        candidates.push({ candidateId: candidate.candidateId, detailDigest }); result.push(publicCandidate(candidate));
      }
      const snapshot = { storageContract: SKILL_INSPECTION_STORAGE, repository: copy(value.repository), commit: value.commit, candidates };
      guard(request); writeJson(join(inspections, `${token}.json`), { contract, agentId, token, snapshot, digest: sha(canonical(snapshot)) });
      guard(request); return { repository: snapshot.repository, commit: snapshot.commit, candidates: result };
    },
    read(token) {
      invariant(/^skg_[a-f0-9]{64}$/.test(token), 'skill_management_inspection_invalid');
      const record = json(join(inspections, `${token}.json`));
      invariant(record.contract === contract && record.agentId === agentId && record.token === token
        && record.digest === sha(canonical(record.snapshot)), 'skill_management_inspection_invalid');
      invariant(record.snapshot.storageContract === undefined || record.snapshot.storageContract === SKILL_INSPECTION_STORAGE,
        'skill_management_inspection_invalid');
      return record.snapshot;
    },
    candidate(record, token, id) {
      const item = record.candidates.find(candidate => candidate.candidateId === id);
      if (!item || record.storageContract === undefined) return item;
      invariant(validDigest(item.detailDigest), 'skill_management_inspection_invalid');
      const candidate = json(join(inspections, token, `${item.detailDigest}.json`));
      invariant(candidate.candidateId === id && sha(canonical(candidate)) === item.detailDigest, 'skill_management_inspection_invalid');
      return candidate;
    },
    bytes(file) {
      invariant(safeSkillPath(file.path) && validDigest(file.sha256), 'skill_management_inspection_invalid');
      // Inline v1 records remain readable; new records never embed base64.
      const bytes = typeof file.body === 'string' ? Buffer.from(file.body, 'base64')
        : read(join(blobs, file.sha256), SKILL_BYTES);
      invariant(bytes.length <= SKILL_BYTES && (file.body !== undefined || bytes.length === file.size)
        && sha(bytes) === file.sha256, 'skill_management_inspection_invalid');
      return bytes;
    },
  };
}
