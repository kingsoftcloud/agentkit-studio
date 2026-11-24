import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Studio verifies package bytes before loading any code from a release.
 * Verify the exact regular-file set of an installed release. Dependency
 * resolution belongs to the caller; nothing inside a package may be a link.
 */
export function verifyPackageFiles(directory, expected, { dependencyPackages = {} } = {}) {
  const root = realpathSync(directory), files = new Map(Object.entries(expected ?? {}));
  if (!files.size) throw Error('Package file manifest is empty');
  for (const [path, hash] of files) {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid package file pin: ' + path);
  }
  const directories = new Set([...files.keys()].flatMap(path => {
    const parts = path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }));
  let checked = 0;
  function dependencyDirectory(path) {
    const metadataPath = join(root, 'package.json');
    if (!files.has('package.json') || createHash('sha256').update(readFileSync(metadataPath)).digest('hex') !== files.get('package.json'))
      throw Error('Dependencies require a verified package manifest');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const declared = { ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies };
    const names = [];
    for (const name of readdirSync(path)) {
      const entry = join(path, name), info = lstatSync(entry);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Package dependency must be a regular directory: ' + name);
      if (name.startsWith('@')) for (const child of readdirSync(entry)) names.push(name + '/' + child);
      else names.push(name);
    }
    for (const name of names) {
      const entry = join(path, name), info = lstatSync(entry);
      if (!Object.hasOwn(declared, name) || !info.isDirectory() || info.isSymbolicLink())
        throw Error('Unexpected package dependency: ' + name);
      const installed = JSON.parse(readFileSync(join(entry, 'package.json'), 'utf8'));
      const pin = dependencyPackages[`${name}@${installed.version}`];
      if (installed.name !== name || !pin?.files) throw Error('Package dependency has no registry evidence: ' + name);
      verifyPackageFiles(entry, pin.files, { dependencyPackages });
    }
  }
  function visit(path, prefix = '') {
    for (const name of readdirSync(path)) {
      const relative = prefix + name, target = join(path, name), info = lstatSync(target);
      if (info.isSymbolicLink()) throw Error('Package link is not allowed: ' + relative);
      if (info.isDirectory()) {
        if (relative === 'node_modules' && Object.keys(dependencyPackages).length) { dependencyDirectory(target); continue; }
        if (!directories.has(relative)) throw Error('Unexpected package directory: ' + relative);
        visit(target, relative + '/');
      } else {
        if (!info.isFile() || !files.has(relative)) throw Error('Unexpected package file: ' + relative);
        const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
        if (actual !== files.get(relative)) throw Error('Package file is stale or modified: ' + relative);
        checked++;
      }
    }
  }
  visit(root);
  if (checked !== files.size) throw Error('Package file is missing');
  return checked;
}
