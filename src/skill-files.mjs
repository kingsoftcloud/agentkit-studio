/** Materialize resource files; DSH owns loading, tool execution and permissions. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rename, rm, readFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readZipFiles } from './zip.mjs';
import { parseFrontmatter } from './skill-discovery.mjs';

export function runtimeSkill({ name, content, path }) {
  const metadata = parseFrontmatter(content);
  const candidate = String(metadata.name || name || '').toLowerCase();
  const id = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : `bound-skill-${createHash('sha256').update(candidate).digest('hex').slice(0, 12)}`;
  return { name: id, description: String(metadata.description || `绑定的 Skill：${name || id}`), content, path,
    source: 'custom', provider: 'agentkit-studio', resourceBase: { kind: 'directory', path: dirname(path) },
    invocation: { modelInvocable: String(metadata['disable-model-invocation']) !== 'true', userInvocable: String(metadata['user-invocable']) !== 'false' } };
}

export async function materializeCloudSkill(archive, cacheDir, name) {
  const files = readZipFiles(archive);
  const manifests = files.filter(file => /(?:^|\/)SKILL\.md$/i.test(file.name));
  if (!manifests.length) throw Object.assign(new Error('云端 Skill 缺少 SKILL.md'), { code: 'SKILL_MANIFEST_MISSING' });
  const digest = createHash('sha256').update(archive).digest('hex');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const target = join(cacheDir, digest);
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('invalid skill cache directory');
    for (const file of files) {
      const path = join(target, file.name);
      if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(file.data)) throw new Error('skill cache content changed');
    }
  } else {
    const staging = await mkdtemp(join(cacheDir, '.prepare-'));
    try {
      for (const file of files) {
        const path = join(staging, file.name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.data, { mode: file.executable ? 0o700 : 0o600, flag: 'wx' });
      }
      try { await rename(staging, target); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return manifests.map(file => runtimeSkill({ name, content: file.data.toString('utf8'), path: join(target, file.name) }));
}
