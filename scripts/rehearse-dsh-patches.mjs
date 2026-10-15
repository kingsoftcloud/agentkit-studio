/** Check a candidate baseline without modifying its checkout or the production series. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { checkPatchManifest } from './check-patch-manifest.mjs';

export async function rehearsePatches({ checkout, commit, patches }) {
  const startedAt = new Date().toISOString(), started = performance.now();
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('candidate must be a full commit SHA');
  const root = resolve(checkout), directory = resolve(patches);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const assertCheckout = () => {
    if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('candidate HEAD does not match the requested commit');
    if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('candidate checkout must be clean');
  };
  assertCheckout();
  const { manifest, report } = await checkPatchManifest(directory);
  const temporary = await mkdtemp(join(tmpdir(), 'studio-upgrade-rehearsal-'));
  const results = [];
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
    const run = args => spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    const seed = run(['read-tree', commit]);
    if (seed.error || seed.status !== 0) throw new Error('could not seed candidate index', { cause: seed.error });
    for (const patch of manifest.patches) {
      const patchStarted = performance.now();
      const blockedBy = patch.dependsOn.filter(id => results.find(result => result.id === id)?.application !== 'applied');
      const result = { id: patch.id, file: patch.file, dependsOn: patch.dependsOn, affectedPackages: patch.affectedPackages,
        requiredHostTests: patch.verification.hostTests, application: 'dependency-blocked', blockedBy,
        behavior: 'not-run', removalVerified: false };
      if (!blockedBy.length) {
        const path = join(directory, patch.file);
        const check = run(['apply', '--cached', '--check', path]);
        if (check.error || check.signal || ![0, 1].includes(check.status)) throw new Error(`patch ${patch.id}: Git check could not run`, { cause: check.error });
        if (check.status === 0) {
          const applied = run(['apply', '--cached', path]);
          if (applied.error || applied.status !== 0) throw new Error(`patch ${patch.id}: application changed after check`, { cause: applied.error });
          result.application = 'applied';
        } else {
          result.application = 'needs-rework';
          result.diagnostics = check.stderr.trim().split('\n');
        }
      }
      result.elapsedMs = Math.round(performance.now() - patchStarted);
      results.push(result);
    }
    assertCheckout();
    const unchanged = await checkPatchManifest(directory);
    if (unchanged.report.seriesSha256 !== report.seriesSha256) throw new Error('production patch series changed during rehearsal');
    return { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      candidateCommit: commit, candidateTree: git(['rev-parse', 'HEAD^{tree}']), productionBase: manifest.baseCommit,
      seriesSha256: report.seriesSha256, patchCount: results.length, applicationPassed: results.every(result => result.application === 'applied'),
      acceptancePassed: false, verifiedRemovals: [],
      limits: ['Application checks do not prove behavior or equivalence.', 'Blocked patches require rechecking after their dependencies are ported.', 'No production baseline or patch is changed.'],
      patches: results };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [checkout, commit, patches, output, ...extra] = process.argv.slice(2);
  if (!checkout || !commit || !patches || !output || extra.length) throw new Error('usage: rehearse-dsh-patches.mjs <candidate-checkout> <candidate-commit> <patch-directory> <report.json>');
  const report = await rehearsePatches({ checkout, commit, patches });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  const counts = Object.fromEntries(['applied', 'needs-rework', 'dependency-blocked'].map(status => [status, report.patches.filter(patch => patch.application === status).length]));
  console.log(JSON.stringify({ candidateCommit: report.candidateCommit, elapsedMs: report.elapsedMs, counts, acceptancePassed: false }));
  if (!report.applicationPassed) process.exitCode = 1;
}
