import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export const NATIVE_PACKAGES = ['core', 'node', 'ui'].map(part => `@kingsoftcloud/agentkit-harness-${part}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify actual consumed bytes, rather than only a package's version/API.
 * This also runs against the isolated Studio archive before it is accepted. */
export function verifyNativePackageTree(root, names = NATIVE_PACKAGES) {
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const require = createRequire(join(root, 'package.json'));
  let checked = 0;
  for (const name of names) {
    const dependency = product.dependencies?.[name];
    if (!dependency?.startsWith('file:vendor/native/')) throw Error(`Native archive dependency is missing: ${name}`);
    const archive = resolve(root, dependency.slice(5));
    if (!archive.startsWith(resolve(root, 'vendor/native') + sep)) throw Error('Native archive escapes vendor directory');
    const addressed = archive.match(/-([a-f0-9]{16})\.tgz$/);
    if (addressed && digest(readFileSync(archive)).slice(0, 16) !== addressed[1]) throw Error(`Native archive identity mismatch: ${name}`);
    let installed = dirname(require.resolve(name));
    while (!existsSync(join(installed, 'package.json'))) {
      const parent = dirname(installed); if (parent === installed) throw Error(`Native package root missing: ${name}`); installed = parent;
    }
    if (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).name !== name) throw Error(`Native package root mismatch: ${name}`);
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (files.some(path => !path.startsWith('package/') || path.split('/').includes('..'))) throw Error('Unsafe Native archive entry');
    const temporary = mkdtempSync(join(tmpdir(), 'native-package-integrity-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', temporary]);
      for (const entry of files) {
        const expected = join(temporary, entry), info = lstatSync(expected);
        if (info.isDirectory()) continue;
        if (!info.isFile()) throw Error(`Non-file Native archive entry: ${entry}`);
        const path = entry.slice('package/'.length), actual = join(installed, path);
        if (!existsSync(actual) || !lstatSync(actual).isFile() || digest(readFileSync(actual)) !== digest(readFileSync(expected)))
          throw Error(`Installed Native package is stale or modified: ${name}/${path}. Reinstall the content-addressed dependency before building.`);
        checked++;
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return checked;
}
