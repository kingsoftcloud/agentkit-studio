import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telemetryEndpoint } from '../src/telemetry/contract.mjs';

const runtimeFiles = ['desktop.mjs', 'contract.mjs', 'schema-v1.json'];
const allowed = new Set(['endpoint', 'defaultBasic', 'policyRevision', 'buildOff']);

/** Snapshot only telemetry code and public release policy, outside the DSH source tree. */
export async function stageDesktopTelemetryInputs(parent, environment) {
  const file = environment.AGENTKIT_TELEMETRY_RELEASE_FILE;
  const inline = environment.AGENTKIT_TELEMETRY_RELEASE_POLICY;
  if (file && inline) throw new Error('Use one desktop telemetry release policy input');
  const release = JSON.parse(file ? await readFile(file, 'utf8') : (inline || '{}'));
  if (!release || Object.getPrototypeOf(release) !== Object.prototype
    || Object.keys(release).some(key => !allowed.has(key))
    || (release.endpoint !== undefined && !telemetryEndpoint(release.endpoint))
    || (release.policyRevision !== undefined && (typeof release.policyRevision !== 'string'
      || !/^[a-zA-Z0-9._-]{1,64}$/.test(release.policyRevision)))
    || ['defaultBasic', 'buildOff'].some(key => release[key] !== undefined && typeof release[key] !== 'boolean')
    || (release.defaultBasic && (!release.endpoint || !release.policyRevision))) {
    throw new Error('Invalid desktop telemetry release policy');
  }
  const directory = await mkdtemp(join(parent, 'studio-telemetry-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const buildOff = environment.AGENTKIT_TELEMETRY_BUILD === 'off' || release.buildOff === true;
    const policy = buildOff ? { buildOff: true } : release;
    await writeFile(join(directory, 'policy.json'), JSON.stringify(policy) + '\n', { mode: 0o600 });
    if (!buildOff) {
      for (const name of runtimeFiles) {
        const source = fileURLToPath(new URL(`../src/telemetry/${name}`, import.meta.url));
        await copyFile(source, join(directory, name));
      }
    }
    return { directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
