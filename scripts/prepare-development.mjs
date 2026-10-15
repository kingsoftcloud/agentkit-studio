/** Apply the reviewed DSH patch series once; never reset an existing checkout. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkBoundMaintenanceSource } from './dsh-maintenance-source.mjs';

export async function prepareDevelopment({ source, patches, commit, checkOnly = false }) {
  const root = resolve(source), patchRoot = resolve(patches);
  const git = (args, env = process.env) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || git(['rev-parse', 'HEAD']) !== commit) throw Error('DSH checkout 与固定 commit 不符；请使用独立的 DSH_ROOT，不会重置现有源码');
  const names = (await readdir(patchRoot)).filter(name => name.endsWith('.patch')).sort();
  if (!names.length) throw Error('没有可应用的 DSH 补丁');
  await checkBoundMaintenanceSource({ patches: patchRoot, source: root });
  const temporary = await mkdtemp(join(tmpdir(), 'studio-development-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') };
    git(['read-tree', 'HEAD'], env);
    for (const name of names) git(['apply', '--cached', join(patchRoot, name)], env);
    const expected = git(['write-tree'], env);
    git(['read-tree', 'HEAD'], env);
    // Include added patch files without modifying the developer's real index.
    git(['add', '-A', '--', '.'], env);
    const actual = git(['write-tree'], env);
    if (actual === expected) return { status: 'already-applied', patches: names.length };
    if (actual !== git(['rev-parse', 'HEAD^{tree}']) || git(['status', '--porcelain'])) throw Error('DSH checkout 包含额外改动或未完成的补丁；已保留现场，请选择独立 DSH_ROOT');
    if (checkOnly) throw Error('DSH 补丁尚未应用；先执行 make setup');
    for (const name of names) git(['apply', '--index', join(patchRoot, name)]);
    if (git(['write-tree']) !== expected) throw Error('DSH 补丁应用结果不符；已保留现场');
    return { status: 'applied', patches: names.length };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, patches, commit] = process.argv.slice(2);
  console.log(JSON.stringify(await prepareDevelopment({ source, patches, commit })));
}
