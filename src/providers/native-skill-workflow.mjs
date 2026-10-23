/** Deterministic Node workflow selection matching ksadk.skills.runtime.executor
 * @355059d. The Host owns package admission, authorization, durable process
 * dispatch and artifact publication. This module never imports a Skill module. */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync } from 'node:fs';

export const NATIVE_SKILL_WORKFLOW = 'agentkit.native-skill-workflow/v1';
const TEXT_SUFFIXES = new Set(['csv', 'json', 'jsonl', 'log', 'md', 'rst', 'tsv', 'txt', 'xml', 'yaml', 'yml']);
const TEXT_LIMIT = 256 * 1024, FILE_LIMIT = 500, ENTRY_LIMIT = 4000, TOTAL_LIMIT = 50 * 1024 ** 2;
const fail = code => Object.assign(new Error(code), { code });
const requireValue = (value, code) => { if (!value) throw fail(code); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const utf8 = bytes => new TextDecoder('utf8', { ignoreBOM: true }).decode(bytes, { stream: true });
const tail = value => { const bytes = Buffer.from(value ?? ''); return bytes.length <= 65536 ? String(value ?? '')
  : '...' + new TextDecoder().decode(bytes.subarray(bytes.length - 65530)); };
function directory(path) {
  for (let part = resolve(path);; part = dirname(part)) {
    const stat = lstatSync(part); requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'SW_DIRECTORY_CHANGED');
    if (part === dirname(part)) return;
  }
}
function safeFile(path, allowedRoot) {
  try {
    const root = resolve(allowedRoot), absolute = resolve(root, path), rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
    directory(dirname(absolute)); directory(root);
    const stat = lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? { path: absolute, stat } : null;
  } catch { return null; }
}
/** Bounded no-follow file read. Before/after ancestor and inode checks reject
 * persistent replacement. This shares the Host uid; it is not OS isolation. */
export function readSkillWorkflowArtifact(path, root, maxBytes) {
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= TOTAL_LIMIT, 'SW_ARTIFACT_LIMIT_INVALID');
  const before = safeFile(path, root); requireValue(before, 'SW_ARTIFACT_UNSAFE');
  const fd = openSync(before.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValue(same(before.stat, fstatSync(fd)), 'SW_ARTIFACT_CHANGED');
    const length = Math.min(maxBytes, before.stat.size), data = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) { const count = readSync(fd, data, offset, length - offset, offset); if (!count) break; offset += count; }
    const after = safeFile(before.path, root);
    requireValue(offset === length && after && same(before.stat, after.stat) && same(before.stat, fstatSync(fd)), 'SW_ARTIFACT_CHANGED');
    return { bytes: data, size: before.stat.size, truncated: before.stat.size > length, path: before.path };
  } finally { closeSync(fd); }
}
function collectArtifacts(outputDir, root, declared = []) {
  const files = new Map(); let entries = 0, total = 0, truncated = false;
  const add = path => {
    const file = safeFile(path, root); if (!file || files.has(file.path)) return;
    if (files.size >= FILE_LIMIT || total + file.stat.size > TOTAL_LIMIT) { truncated = true; return; }
    total += file.stat.size; files.set(file.path, file.stat.size);
  };
  // stdout is already bounded by the command transport. Apply the same file
  // count/size/path rules to declared and discovered artifacts.
  for (const path of declared) { if (++entries > ENTRY_LIMIT) { truncated = true; break; } add(path); }
  const walk = (path, depth) => {
    if (depth > 10 || entries >= ENTRY_LIMIT || files.size >= FILE_LIMIT) { truncated = true; return; }
    let dir;
    try { directory(path); dir = opendirSync(path); } catch { return; }
    try {
      for (;;) {
        const entry = dir.readSync(); if (!entry) break;
        if (++entries > ENTRY_LIMIT || files.size >= FILE_LIMIT) { truncated = true; break; }
        const target = join(path, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(target, depth + 1); else if (entry.isFile()) add(target);
      }
    } finally { dir.closeSync(); }
  };
  if (existsSync(outputDir)) walk(outputDir, 0);
  return { files: [...files.keys()].sort(), truncated };
}
function collectText(files, root) {
  const candidates = files.filter(path => { const suffix = basename(path).split('.').at(-1).toLowerCase(); return TEXT_SUFFIXES.has(suffix); });
  let text = '', remaining = TEXT_LIMIT, truncated = false;
  for (let i = 0; i < candidates.length; i++) {
    const prefix = (i ? '\n\n' : '') + (candidates.length > 1 ? `--- ${basename(candidates[i])} ---\n` : '');
    if (Buffer.byteLength(prefix) >= remaining) { truncated = true; break; }
    try {
      const result = readSkillWorkflowArtifact(candidates[i], root, remaining - Buffer.byteLength(prefix));
      const payload = utf8(result.bytes); text += prefix + payload; remaining -= Buffer.byteLength(prefix + payload);
      truncated ||= result.truncated;
      if (result.truncated || remaining === 0) { truncated ||= i < candidates.length - 1; break; }
    } catch { truncated = true; }
  }
  return { output_text: text, output_text_truncated: truncated };
}
const commandRecord = (label, cwd, result) => ({ command: label, cwd, exit_code: result.exit_code,
  stdout: tail(result.stdout), stderr: tail(result.stderr), ...(result.timed_out ? { timed_out: true } : {}) });

export function createNativeSkillWorkflowExecutor({ runCommand, workDir, projectName = 'ksadk-artifact' } = {}) {
  if (typeof runCommand !== 'function') throw new Error('runCommand required');
  if (typeof workDir !== 'string' || !workDir) throw new Error('workDir required');
  const root = resolve(workDir), project = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectName) ? projectName : 'ksadk-artifact';
  async function execute(request = {}) {
    const signal = request.signal, authority = request.assertCurrent;
    requireValue(signal instanceof AbortSignal && typeof authority === 'function', 'SW_AUTHORITY_REQUIRED');
    const body = () => JSON.stringify({ workflowPrompt: request.workflowPrompt, skillNames: request.skillNames ?? [], packages: request.packages ?? [] });
    const sealed = body();
    function guard() {
      signal.throwIfAborted(); requireValue(request.signal === signal && request.assertCurrent === authority && body() === sealed, 'SW_REQUEST_CHANGED');
      const current = authority();
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      requireValue(current === true, 'SW_LEASE_LOST');
      requireValue(request.signal === signal && request.assertCurrent === authority && body() === sealed, 'SW_REQUEST_CHANGED'); signal.throwIfAborted(); return true;
    }
    guard();
    const { workflowPrompt: prompt = '', skillNames = [], packages = [] } = structuredClone({ workflowPrompt: request.workflowPrompt,
      skillNames: request.skillNames ?? [], packages: request.packages ?? [] });
    requireValue(typeof prompt === 'string' && Array.isArray(skillNames) && Array.isArray(packages), 'SW_INPUT_INVALID');
    const selected = skillNames.map(name => String(name).trim()).filter(Boolean), loaded = packages.map(pkg => pkg.name);
    const base = { selected_skills: selected, loaded_skills: loaded };
    const candidates = packages.filter(pkg => !selected.length || selected.some(name => name.toLowerCase() === pkg.name.toLowerCase()));
    let pkg = candidates.find(pkg => pkg.name === 'web-artifacts-builder' && ['web-artifacts-builder', 'artifact', 'bundle', 'html', 'react'].some(word => prompt.toLowerCase().includes(word))
      && safeFile('scripts/init-artifact.sh', pkg.rootDir) && safeFile('scripts/bundle-artifact.sh', pkg.rootDir));
    const web = Boolean(pkg);
    pkg ??= candidates.find(pkg => safeFile('scripts/run-workflow.sh', pkg.rootDir));
    if (!pkg) {
      const instructions = candidates.find(pkg => !existsSync(join(pkg.rootDir, 'scripts')) && pkg.body?.trim());
      guard();
      return instructions ? { ...base, status: 'instructions', executed_skill: instructions.name, instructions: instructions.body,
        warnings: ['This Skill provides instructions. Follow them using your available tools.'] }
        : { ...base, status: packages.length ? 'skipped' : 'no_skills', warnings: ['No selected Skill exposes an executable workflow entrypoint.'] };
    }
    guard();
    // The Host supplies one private workdir per original invocation. Existing
    // projects are never deleted; a duplicate invocation belongs to its ledger.
    if (!existsSync(root)) { directory(dirname(root)); guard(); mkdirSync(root, { mode: 0o700 }); }
    directory(root);
    const rootStat = lstatSync(root), check = () => { guard(); directory(root); const stat = lstatSync(root);
      requireValue(stat.ino === rootStat.ino && stat.dev === rootStat.dev, 'SW_DIRECTORY_CHANGED'); return true; };
    const commands = [];
    async function run(argv, cwd, env = {}) {
      check(); const result = await runCommand({ argv, cwd, env, timeoutSeconds: 300, signal, assertCurrent: check }); check();
      requireValue(result && !result.uncertain && result.status !== 'uncertain' && Number.isSafeInteger(result.exit_code), 'SW_COMMAND_OUTCOME_UNKNOWN');
      commands.push(commandRecord(argv.map(value => basename(value)).join(' '), cwd, result)); return result;
    }
    let result, outputDir;
    if (web) {
      outputDir = join(root, project); check();
      if (existsSync(outputDir)) return { ...base, status: 'failed', executed_skill: pkg.name, commands: [],
        error: 'Artifact project already exists; reconcile the original workflow.', error_type: 'SW_PROJECT_EXISTS' };
      result = await run(['bash', join(pkg.rootDir, 'scripts/init-artifact.sh'), project], root);
      if (result.exit_code === 0) { directory(outputDir); result = await run(['bash', join(pkg.rootDir, 'scripts/bundle-artifact.sh')], outputDir); }
    } else {
      outputDir = join(root, 'artifacts'); check();
      if (!existsSync(outputDir)) mkdirSync(outputDir, { mode: 0o700 }); directory(outputDir); check();
      result = await run(['bash', join(pkg.rootDir, 'scripts/run-workflow.sh')], root,
        { KSADK_WORKFLOW_PROMPT: prompt, KSADK_SKILL_WORKDIR: root, KSADK_SKILL_OUTPUT_DIR: outputDir, KSADK_SKILL_ROOT_DIR: pkg.rootDir });
    }
    check();
    const declared = String(result.stdout ?? '').split('\n').filter(line => line.startsWith('artifact=')).map(line => line.slice(9).trim()).filter(Boolean);
    if (web) declared.unshift(join(outputDir, 'bundle.html'));
    const artifacts = collectArtifacts(outputDir, root, declared);
    const outputFiles = web ? artifacts.files.filter(path => path === join(outputDir, 'bundle.html')) : artifacts.files;
    const text = collectText(artifacts.files, root); check();
    const status = result.exit_code === 0 && (!web || outputFiles.length) ? 'ok' : 'failed';
    return { ...base, status, executed_skill: pkg.name, commands, artifacts: artifacts.files, output_files: outputFiles,
      artifacts_truncated: artifacts.truncated, ...text, ...(status === 'failed' ? { error: `Command failed with exit code ${result.exit_code}` } : {}) };
  }
  return { execute };
}
