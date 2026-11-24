import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { verifyPackageFiles } from '../src/package-integrity.mjs';

export const NATIVE_CORE_PACKAGE = '@kingsoftcloud/agentkit-harness-core';
export const NATIVE_NODE_PACKAGE = '@kingsoftcloud/agentkit-harness-node';
export const NATIVE_PACKAGES = [NATIVE_CORE_PACKAGE, NATIVE_NODE_PACKAGE];

export function pinnedNativeVersion(product, name) {
  return product.devDependencies?.[name];
}

/** Check the exact registry fixtures used by Studio's tests. */
export function verifyNativePackageTree(root, names = NATIVE_PACKAGES) {
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pins = JSON.parse(readFileSync(join(root, 'scripts/native-package-pins.json'), 'utf8'));
  if (pins.schemaVersion !== 'agentkit.native-registry-pins/v2') throw Error('Invalid Native registry pins');
  const require = createRequire(join(root, 'package.json'));
  let checked = 0;
  for (const name of names) {
    const pin = pins.packages?.[name];
    if (!pin || !/^\d+\.\d+\.\d+$/.test(pin.version) || pinnedNativeVersion(product, name) !== pin.version)
      throw Error(`Native registry version is not pinned: ${name}`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity) || !pin.files || !Object.keys(pin.files).length)
      throw Error(`Native registry evidence is missing: ${name}`);
    let installed = dirname(require.resolve(name));
    while (!existsSync(join(installed, 'package.json'))) {
      const parent = dirname(installed); if (parent === installed) throw Error(`Native package root missing: ${name}`); installed = parent;
    }
    const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== pin.version) throw Error(`Native package identity mismatch: ${name}`);
    checked += verifyPackageFiles(installed, pin.files, { dependencyPackages: pins.dependencyPackages ?? {} });
  }
  return checked;
}
