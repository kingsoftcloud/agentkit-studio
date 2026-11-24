#!/usr/bin/env node
/** Platform initContainer entry, independent of the user's main command. */
import { parseArgs } from 'node:util';
import { loadManagedRuntimeManifest } from '../src/managed-runtime-manifest.mjs';

try {
  const { values } = parseArgs({ options: { manifest: { type: 'string' } } });
  if (!values.manifest) throw Error('manifest required');
  const result = await loadManagedRuntimeManifest(values.manifest);
  const ksxcPayload = result.declaration.runtime.name === 'ksxc'
    ? await import('../src/providers/ksxc-runtime.mjs').then(({ verifyManagedKsxcPayload }) => verifyManagedKsxcPayload())
    : undefined;
  console.log(JSON.stringify({ event: 'manifest.verified', sha256: result.sha256, ...(ksxcPayload ? { ksxcPayload } : {}) }));
} catch (error) {
  console.error(JSON.stringify({ event: 'manifest.verification.failed', code: error.code || 'MANAGED_MANIFEST_INVALID' }));
  process.exitCode = 1;
}
