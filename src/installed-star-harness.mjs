import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStarHarness, STAR_HARNESS_PACKAGE } from './host/services/star-harness-release.mjs';
import { verifyNativePackageTree } from '../scripts/native-package-integrity.mjs';

export async function startInstalledStarHarness(options) {
  verifyNativePackageTree(fileURLToPath(new URL('..', import.meta.url)));
  const require = createRequire(import.meta.url);
  const engineDirectory = dirname(dirname(dirname(require.resolve(STAR_HARNESS_PACKAGE + '/native/engine-server'))));
  const version = require('../package.json').dependencies[STAR_HARNESS_PACKAGE];
  return startStarHarness({ ...options, packageDirectory: engineDirectory, version });
}
