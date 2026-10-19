/** Audit the pinned DSH file-read boundary with synthetic files; never enables downloads. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Set AGENTKIT_DSH_ROOT to the isolated, built pinned DSH checkout.');
if (process.platform !== 'linux') throw new Error('This cloud boundary audit requires Linux symlink semantics.');
const dsh = await realpath(process.env.AGENTKIT_DSH_ROOT);
const manifest = JSON.parse(await readFile(join(studio, 'package.json'), 'utf8'));
const patches = JSON.parse(await readFile(join(studio, `patches/dsh-v${manifest.engines.dsh}/manifest.json`), 'utf8'));
const dshCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dsh, encoding: 'utf8' }).trim();
assert.equal(dshCommit, patches.baseCommit, 'Audit the pinned DSH baseline, not a different checkout.');
const load = (owner, name) => {
  const require = createRequire(join(dsh, owner, 'package.json'));
  return import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
};
const { Context } = await load('packages/fs/fs-local', 'cordis');
const { LocalFileSystem } = await load('packages/fs/fs-local', 'dsh-fs-local');
const { WorkspaceFiles } = await load('packages/api/workspace-files', 'dsh-api-workspace-files');
const { remoteErrorOf } = await load('packages/api/workspace-files', 'dsh-typert-protocol');
const intended = Buffer.from('workspace fixture content');
const outside = Buffer.from('synthetic outside fixture');
assert.equal(intended.length, outside.length, 'Equal-size fixtures demonstrate that size checks do not close the race.');
const cases = [];

async function fixture(name, exercise) {
  const root = await mkdtemp(join(tmpdir(), 'studio-deliverable-boundary-'));
  const workspace = join(root, 'workspace'), outsideRoot = join(root, 'outside');
  const ctx = new Context();
  try {
    await mkdir(join(workspace, 'reports'), { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(join(workspace, 'reports/report.bin'), intended);
    await writeFile(join(outsideRoot, 'report.bin'), outside);
    await ctx.plugin(LocalFileSystem, { cwd: workspace });
    ctx.provide('sandboxPolicy', { workspaceRoot: workspace });
    const endpoint = new WorkspaceFiles(ctx, { maxBytes: 64, maxFileBytes: 64, maxLines: 10, maxEntries: 10 });
    const read = () => endpoint.readBytes({ sessionId: 'synthetic-session', workspaceRoot: workspace },
      'reports/report.bin', {}, new AbortController().signal);
    const evidence = await exercise({ fs: ctx.fs, read, workspace, outsideRoot });
    cases.push({ name, ...evidence });
  } finally {
    try { await ctx.fiber.dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

await fixture('regular-file', async ({ read }) => {
  const value = await read();
  assert.deepEqual(Buffer.from(value.data), intended);
  assert.equal(value.bytes, intended.length);
  assert.equal(value.eof, true);
  return { behavior: 'reads-intended-bytes', observedBytes: value.data.length };
});

await fixture('existing-final-symlink', async ({ read, workspace, outsideRoot }) => {
  const target = join(workspace, 'reports/report.bin');
  await rm(target);
  await symlink(join(outsideRoot, 'report.bin'), target);
  await assert.rejects(read(), error => remoteErrorOf(error)?.code === 'workspace-file/not-regular-file');
  return { behavior: 'rejected-before-read' };
});

for (const ancestor of [false, true]) {
  await fixture(ancestor ? 'ancestor-swap-after-stat' : 'final-symlink-swap-after-stat', async ({ fs, read, workspace, outsideRoot }) => {
    let swaps = 0;
    // This is DSH's existing deterministic post-stat test seam, not a patched reader.
    fs.internals.inspectReadBytesAfterStat = async () => {
      swaps++;
      if (ancestor) {
        await rename(join(workspace, 'reports'), join(workspace, 'reports-original'));
        await symlink(outsideRoot, join(workspace, 'reports'), 'dir');
      } else {
        await rm(join(workspace, 'reports/report.bin'));
        await symlink(join(outsideRoot, 'report.bin'), join(workspace, 'reports/report.bin'));
      }
    };
    const value = await read();
    assert.equal(swaps, 1, 'The native reader must cross the audited post-stat boundary.');
    assert.deepEqual(Buffer.from(value.data), outside, 'The current native reader follows the replacement link outside the workspace.');
    assert.equal(value.bytes, value.data.length, 'The returned pre-read size still matches these outside bytes.');
    return { behavior: 'outside-bytes-observed', actualRead: Buffer.from(value.data).toString('utf8'),
      observedBytes: value.data.length, reportedBytes: value.bytes, safeForDownload: false };
  });
}

await fixture('oversized-file', async ({ read, workspace }) => {
  await writeFile(join(workspace, 'reports/report.bin'), Buffer.alloc(65));
  await assert.rejects(read(), error => remoteErrorOf(error)?.code === 'workspace-file/too-large');
  return { behavior: 'rejected-by-byte-cap' };
});

await fixture('growth-after-stat', async ({ fs, read, workspace }) => {
  fs.internals.inspectReadBytesAfterStat = async () => {
    await writeFile(join(workspace, 'reports/report.bin'), Buffer.alloc(65));
  };
  await assert.rejects(read(), error => remoteErrorOf(error)?.code === 'workspace-file/too-large');
  return { behavior: 'rejected-by-byte-cap' };
});

const report = { evidence: 'real-built-dsh-synthetic-filesystem', dshCommit,
  pathDeliverableDownload: 'blocked', safeForPathDeliverableDownload: false, cases };
if (process.argv[2]) {
  const output = resolve(process.argv[2]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
console.log('Audit assertions passed; path-only deliverables remain metadata-only. This is not a download-safety pass.');
