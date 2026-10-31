import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

export const NATIVE_PACKAGES = ['core', 'node', 'ui'].map(part => `@kingsoftcloud/agentkit-harness-${part}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Check the exact registry release consumed by the Host, including its bytes.
 * Reviewed pins ship with Studio so isolated/offline installations work too. */
export function verifyNativePackageTree(root, names = NATIVE_PACKAGES) {
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pins = JSON.parse(readFileSync(join(root, 'scripts/native-package-pins.json'), 'utf8'));
  if (pins.schemaVersion !== 'agentkit.native-registry-pins/v1') throw Error('Invalid Native registry pins');
  const require = createRequire(join(root, 'package.json'));
  let checked = 0;
  for (const name of names) {
    const pin = pins.packages?.[name];
    if (!pin || !/^\d+\.\d+\.\d+$/.test(pin.version) || product.dependencies?.[name] !== pin.version)
      throw Error(`Native registry version is not pinned: ${name}`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity) || !pin.files || !Object.keys(pin.files).length)
      throw Error(`Native registry evidence is missing: ${name}`);
    let installed = dirname(require.resolve(name));
    while (!existsSync(join(installed, 'package.json'))) {
      const parent = dirname(installed); if (parent === installed) throw Error(`Native package root missing: ${name}`); installed = parent;
    }
    const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== pin.version) throw Error(`Native package identity mismatch: ${name}`);
    for (const [path, expected] of Object.entries(pin.files)) {
      if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.')
        || !/^[a-f0-9]{64}$/.test(expected)) throw Error(`Invalid Native file pin: ${name}/${path}`);
      const actual = join(installed, path);
      if (!existsSync(actual) || !lstatSync(actual).isFile() || digest(readFileSync(actual)) !== expected)
        throw Error(`Installed Native package is stale or modified: ${name}/${path}. Reinstall the locked registry release.`);
      checked++;
    }
  }
  return checked;
}
