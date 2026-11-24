import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { canonical, copy, invariant } from '../contracts/native-values.mjs';
import { privateDirectory, syncDirectory } from '../host/private-state.mjs';
import { NATIVE_SKILL_WORKFLOW, readSkillWorkflowArtifact } from './native-skill-workflow.mjs';

export const NATIVE_SKILL_RUNTIME = 'agentkit.native-skill-runtime/v1';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const inside = (path, root) => path === root || path.startsWith(root + sep);

// Keep the published binding digest compatible with existing Skill workflows.
// Runtime settings have always used the default local script allowlist.
function skillEnvironmentDigest(env) {
  const allowed = Object.create(null);
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT']) {
    if (Object.hasOwn(env, name)) allowed[name] = String(env[name]);
  }
  allowed.PATH ??= '/bin:/usr/bin';
  allowed.LANG ??= 'C.UTF-8';
  allowed.CI = '1';
  return hash(allowed);
}

export function nativeSkillRuntimeSettings(env = {}) {
  const value = env.KSADK_SKILL_RUNTIME_BACKEND ?? env.KSADK_SANDBOX_BACKEND
    ?? (env.KSADK_SANDBOX_TEMPLATE_ID || env.KSADK_SKILL_RUNTIME_TEMPLATE_ID ? 'e2b' : 'disabled');
  invariant(typeof value === 'string', 'SKILL_RUNTIME_BACKEND_INVALID');
  const backend = value.trim().toLowerCase();
  invariant(['', 'disabled', 'none', 'off', 'local_process', 'e2b'].includes(backend), 'SKILL_RUNTIME_BACKEND_INVALID');
  const timeout = env.KSADK_SKILL_RUNTIME_TIMEOUT ?? '900';
  invariant(typeof timeout === 'string' && /^\d+$/u.test(timeout) && Number.isSafeInteger(Number(timeout))
    && Number(timeout) >= 1 && Number(timeout) <= 900, 'SKILL_RUNTIME_TIMEOUT_INVALID');
  invariant(env.KSADK_SKILL_PROJECT_NAME === undefined || typeof env.KSADK_SKILL_PROJECT_NAME === 'string', 'SKILL_RUNTIME_PROJECT_INVALID');
  invariant(env.KSADK_SKILL_ARTIFACT_PROJECT === undefined || typeof env.KSADK_SKILL_ARTIFACT_PROJECT === 'string', 'SKILL_RUNTIME_PROJECT_INVALID');
  return Object.freeze({ contract: NATIVE_SKILL_RUNTIME, workflowContract: NATIVE_SKILL_WORKFLOW,
    backend: backend === 'local_process' ? backend : backend === 'e2b' ? 'e2b' : 'disabled',
    enabled: ['local_process', 'e2b'].includes(backend), isolated: backend === 'e2b', timeoutSeconds: Number(timeout),
    projectName: env.KSADK_SKILL_PROJECT_NAME || env.KSADK_SKILL_ARTIFACT_PROJECT || 'ksadk-artifact',
    environmentBindingDigest: skillEnvironmentDigest(env) });
}

// Trusted Host helpers shared by local and remote runtimes. Neither is a model
// tool; both require the original runtime's synchronous authority guard.
export function stagePackages(packages, root, guard) {
  invariant(Array.isArray(packages) && packages.length <= 100, 'SKILL_RUNTIME_PACKAGES_INVALID');
  let count = 0, total = 0;
  return packages.map((pkg, index) => {
    invariant(pkg && typeof pkg.name === 'string' && pkg.name && typeof pkg.body === 'string' && typeof pkg.rootDir === 'string', 'SKILL_RUNTIME_PACKAGE_INVALID');
    guard(); privateDirectory(root, true);
    const source = resolve(pkg.rootDir), destination = join(root, String(index)); privateDirectory(destination, true);
    const manifest = [];
    function walk(from, to, depth) {
      invariant(depth <= 32, 'SKILL_RUNTIME_PACKAGE_DEPTH'); guard();
      // readSkillWorkflowArtifact checks every ancestor for each file. Empty
      // directories also reject links before enumeration.
      for (let part = from;; part = dirname(part)) {
        const stat = lstatSync(part); invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'SKILL_RUNTIME_PACKAGE_SYMLINK');
        if (part === dirname(part)) break;
      }
      const dir = opendirSync(from);
      try {
        for (;;) {
          const entry = dir.readSync(); if (!entry) break;
          invariant(++count <= 4000 && !entry.isSymbolicLink(), 'SKILL_RUNTIME_PACKAGE_ENTRIES'); guard();
          const input = join(from, entry.name), output = join(to, entry.name);
          if (entry.isDirectory()) { privateDirectory(output, true); walk(input, output, depth + 1); }
          else {
            invariant(entry.isFile(), 'SKILL_RUNTIME_PACKAGE_FILE_INVALID');
            const item = readSkillWorkflowArtifact(input, source, 50 * 1024 ** 2 - total);
            invariant(!item.truncated, 'SKILL_RUNTIME_PACKAGE_SIZE'); total += item.size;
            const executable = lstatSync(input).mode & 0o111;
            guard(); const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, executable ? 0o700 : 0o600);
            try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
            manifest.push({ path: relative(source, input), sha256: hash(item.bytes), executable: Boolean(executable) });
          }
        }
      } finally { dir.closeSync(); }
      syncDirectory(to);
    }
    walk(source, destination, 0); guard();
    return { ...copy(pkg), rootDir: destination, stagedManifest: manifest };
  });
}
export function publishArtifacts(result, workDir, workspace, runtimeId, guard) {
  const paths = [...new Set([...(result.artifacts ?? []), ...(result.output_files ?? [])])];
  invariant(paths.length <= 500, 'SKILL_RUNTIME_ARTIFACT_COUNT');
  if (!paths.length) return { ...result, artifacts: [], output_files: [], artifact_metadata: [] };
  const target = join(workspace, '.agentkit', 'skill-results', hash(runtimeId));
  function ensure(path) {
    if (path === workspace) return;
    invariant(inside(path, workspace), 'SKILL_RUNTIME_ARTIFACT_PATH'); ensure(dirname(path)); guard();
    if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
    invariant(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'SKILL_RUNTIME_ARTIFACT_PATH');
  }
  ensure(target); let total = 0;
  const mapping = new Map(), metadata = [];
  for (let i = 0; i < paths.length; i++) {
    guard(); const item = readSkillWorkflowArtifact(paths[i], workDir, 50 * 1024 ** 2 - total);
    invariant(!item.truncated, 'SKILL_RUNTIME_ARTIFACT_SIZE'); total += item.size;
    const filename = `${i}-${basename(item.path)}`, output = join(target, filename); ensure(target); guard();
    const fd = openSync(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, item.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(target); guard(); mapping.set(paths[i], output);
    metadata.push({ path: output, sha256: hash(item.bytes), size_bytes: item.size, source_path: relative(workDir, item.path) });
  }
  return { ...result, artifacts: paths.map(path => mapping.get(path)),
    output_files: (result.output_files ?? []).map(path => mapping.get(path)), artifact_metadata: metadata };
}
