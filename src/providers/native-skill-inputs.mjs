/** Optional trusted Host inputs for the E2B Skill runtime. Model arguments
 * cannot choose Host paths. Bytes are pinned privately before sandbox creation.
 * Remote paths retain the reference's /workspace/inputs boundary. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { privateDirectory, syncDirectory } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';
import { readSkillWorkflowArtifact } from './native-skill-workflow.mjs';

export const NATIVE_SKILL_INPUT_FILES = 'agentkit.native-skill-input-files/v1';
export const SKILL_INPUT_ROOT = '/workspace/inputs';
const MAX_FILES = 500, MAX_FILE_BYTES = 20 * 1024 ** 2, MAX_TOTAL_BYTES = 50 * 1024 ** 2;
const hash = value => createHash('sha256').update(value).digest('hex');

export function normalizeSkillInputFiles(value = []) {
  invariant(Array.isArray(value) && value.length <= MAX_FILES, 'SKILL_INPUT_FILES_INVALID');
  const result = value.map(item => {
    invariant(item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).every(key => ['source', 'targetPath', 'sha256'].includes(key))
      && typeof item.source === 'string' && item.source.trim() && item.source.length <= 4096 && !item.source.includes('\0')
      && typeof item.targetPath === 'string' && item.targetPath.length <= 4096
      && item.targetPath.startsWith(SKILL_INPUT_ROOT + '/') && posix.normalize(item.targetPath) === item.targetPath
      && !item.targetPath.endsWith('/') && !item.targetPath.includes('\\') && !item.targetPath.includes('\0')
      && !item.targetPath.split('/').some(part => part === '.' || part === '..')
      && (item.sha256 === undefined || typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)), 'SKILL_INPUT_FILE_INVALID');
    return copy(item);
  });
  const targets = result.map(item => item.targetPath).sort();
  for (let i = 1; i < targets.length; i++) invariant(targets[i] !== targets[i - 1]
    && !targets[i].startsWith(targets[i - 1] + '/'), 'SKILL_INPUT_TARGET_CONFLICT');
  // A file can be an ancestor even if another sibling sorts between them.
  const seen = new Set(targets);
  for (const target of targets) for (let parent = posix.dirname(target); parent !== SKILL_INPUT_ROOT; parent = posix.dirname(parent)) {
    invariant(!seen.has(parent), 'SKILL_INPUT_TARGET_CONFLICT');
  }
  return result;
}

export function stageSkillInputFiles(inputFiles, workspaceRoot, destination, guard) {
  const inputs = normalizeSkillInputFiles(inputFiles), root = resolve(workspaceRoot);
  const check = () => {
    invariant(typeof guard === 'function', 'SKILL_INPUT_AUTHORITY_REQUIRED');
    const verdict = guard();
    if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
    invariant(verdict === true, 'SKILL_INPUT_AUTHORITY_LOST');
  };
  let total = 0;
  // Validate/read every source before creating any staged input. There is still
  // no remote effect. This is a bounded snapshot, not a whole-workspace sync.
  const pinned = inputs.map(item => {
    check(); const source = resolve(root, item.source), local = relative(root, source);
    invariant(local && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local), 'SKILL_INPUT_SOURCE_OUTSIDE_WORKSPACE');
    const result = readSkillWorkflowArtifact(source, root, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total));
    invariant(!result.truncated, 'SKILL_INPUT_FILE_LIMIT'); total += result.size;
    const sha256 = hash(result.bytes);
    invariant(!item.sha256 || item.sha256 === sha256, 'SKILL_INPUT_SOURCE_CHANGED'); check();
    return { source: local, targetPath: item.targetPath, sizeBytes: result.size, sha256, bytes: result.bytes };
  });
  if (!pinned.length) return [];
  check(); privateDirectory(destination, true);
  return pinned.map((item, index) => {
    check(); const stagedPath = join(destination, String(index));
    const fd = openSync(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(destination); check();
    const { bytes, ...metadata } = item; return { ...metadata, stagedPath };
  });
}
