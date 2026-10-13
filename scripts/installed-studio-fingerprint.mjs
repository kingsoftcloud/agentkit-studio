/** Fingerprint actual packaged Studio bytes separately from its Runtime source subset. */
import { createHash } from 'node:crypto';
import asar from '@electron/asar';

export function installedStudioFingerprint(archive) {
  asar.uncacheAll();
  const prefix = '/dsh/node_modules/@kingsoftcloud/agentkit-studio/';
  const runtime = createHash('sha256'), packageHash = createHash('sha256');
  let files = 0;
  for (const path of asar.listPackage(archive).filter(path => path.startsWith(prefix)).sort()) {
    const entry = asar.statFile(archive, path.slice(1), false);
    if (entry.files) continue;
    if (entry.link) throw new Error('Installed Studio package contains a link');
    const name = path.slice(prefix.length), bytes = asar.extractFile(archive, path.slice(1));
    packageHash.update(name).update('\0').update(bytes); files += 1;
    if (/^(src\/.*\.(?:mjs|js)|packages\/agentkit-harness\/src\/.*\.mjs|dist\/client\.js|studio\.plugin\.json)$/.test(name)) {
      runtime.update(name).update('\0').update(bytes);
    }
  }
  if (!files) throw new Error('Installed archive has no Studio package');
  return { studioSourceSha256: runtime.digest('hex'), studioPackageSha256: packageHash.digest('hex') };
}
