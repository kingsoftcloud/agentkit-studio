/** Rebuild the signed source, independently of the checkout containing these tools. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import asar from '@electron/asar';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyDesktopClientSource({ repository, source, archive, report }) {
  if (!/^[0-9a-f]{40}$/.test(source || '')) throw new Error('Specify an immutable 40-character source commit');
  repository = resolve(repository);
  const run = (command, args, cwd) => execute(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
  const resolved = (await run('git', ['rev-parse', `${source}^{commit}`], repository)).stdout.trim();
  if (resolved !== source) throw new Error('Source must identify a commit, not a tag or tree');
  const scratch = await mkdtemp(join(tmpdir(), 'studio-client-source-'));
  try {
    const checkout = join(scratch, 'source');
    await mkdir(checkout);
    await run('git', ['archive', '--format=tar', `--output=${join(scratch, 'source.tar')}`, source], repository);
    await run('tar', ['-xf', join(scratch, 'source.tar'), '-C', checkout], repository);
    // Old commits can still contain dist. Never accept those bytes as a rebuild.
    await rm(join(checkout, 'dist'), { recursive: true, force: true });
    await run('pnpm', ['install', '--frozen-lockfile'], checkout);
    await run('pnpm', ['run', 'build:client'], checkout);
    const expected = await readFile(join(checkout, 'dist/client.js'));
    asar.uncacheAll();
    const actual = asar.extractFile(resolve(archive), 'dsh/node_modules/@kingsoftcloud/agentkit-studio/dist/client.js');
    const result = { evidence: 'desktop-client-rebuilt-from-immutable-source', sourceCommit: source,
      lockfileSha256: sha256(await readFile(join(checkout, 'pnpm-lock.yaml'))),
      expectedSha256: sha256(expected), installedSha256: sha256(actual), passed: actual.equals(expected) };
    if (report) {
      await mkdir(dirname(resolve(report)), { recursive: true });
      await writeFile(resolve(report), JSON.stringify(result, null, 2) + '\n');
    }
    if (!result.passed) throw new Error('Desktop client differs from its rebuilt immutable source');
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['source', 'archive', 'report'].map(name => [name, { type: 'string' }])) });
  if (!values.source || !values.archive || !values.report) throw new Error('Usage: verify-desktop-client-source.mjs --source COMMIT --archive APP_ASAR --report REPORT');
  console.log(JSON.stringify(await verifyDesktopClientSource({ repository: resolve(import.meta.dirname, '..'), ...values })));
}
