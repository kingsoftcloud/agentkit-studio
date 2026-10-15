/** Hash source content and file modes independently of Git diff presentation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
export async function fingerprintPatchedSource(checkout) {
  const temporary = await mkdtemp(join(tmpdir(), 'studio-source-fingerprint-'));
  const invoke = async (args, env = process.env) => (await execute('git', args, { cwd: checkout, env, encoding: null, maxBuffer: 32 * 1024 * 1024 })).stdout;
  try {
    const index = (await invoke(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).toString().trim();
    const privateIndex = join(temporary, 'index');
    await copyFile(index, privateIndex);
    const env = { ...process.env, GIT_INDEX_FILE: privateIndex };
    await invoke(['add', '--all', '--', '.'], env);
    const tree = (await invoke(['write-tree'], env)).toString().trim();
    const entries = await invoke(['ls-tree', '-r', '-z', '--full-tree', tree], env);
    return { tree, sha256: createHash('sha256').update(entries).digest('hex'), files: entries.toString().split('\0').filter(Boolean).length };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function assertPatchedSource(checkout, manifest) {
  const actual = await fingerprintPatchedSource(checkout);
  const expected = { tree: manifest.patchedTree, sha256: manifest.patchedSourceSha256 };
  if (actual.tree !== expected.tree || actual.sha256 !== expected.sha256) {
    throw Object.assign(new Error('Patched source differs from the reviewed tree'), { code: 'PATCHED_SOURCE_MISMATCH', expected, actual });
  }
  return actual;
}
