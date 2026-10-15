/** Metadata for synthetic packaging fixtures; never used by release builds. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function writeReviewedPatchFixture(directory, baseCommit) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const patches = [], previous = new Map(), bytes = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.patch')).sort()) {
    const source = await readFile(join(directory, file)); bytes.push(source);
    const id = file.slice(0, 3), affectedFiles = [...new Set([...source.toString().matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]))];
    const dependsOn = [...new Set(affectedFiles.map(path => previous.get(path)).filter(Boolean))];
    for (const path of affectedFiles) previous.set(path, id);
    patches.push({ id, file, category: 'product', baseCommit, sha256: hash(source), dependsOn, affectedFiles,
      affectedPackages: ['fixture'], contracts: ['Synthetic packaging fixture'], risk: 'low', maintainerRole: 'Fixture owner',
      upstreamStatus: { state: 'not-submitted', evidence: 'Synthetic fixture' }, removeWhen: 'Fixture retired',
      verification: { hostTests: [], integrations: ['source'] } });
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, baseCommit,
    patchedDiffSha256: hash(Buffer.concat(bytes)), upstream: { repository: 'https://example.invalid/dsh.git', ref: 'fixture' },
    verificationProfiles: { source: { kind: 'fixture' } }, patches }));
}
