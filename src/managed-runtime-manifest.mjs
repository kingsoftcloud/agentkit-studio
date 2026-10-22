/** Package-free DSH input contract. Server catalog selects the release;
 * this consumer verifies the exact mounted bytes and never chooses an engine.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isScalar, parseDocument, visit } from 'yaml';
import { validateManagedResources } from './managed-resource-contract.mjs';

export const DSH_MANIFEST_FORMAT = 'agentengine.dsh-manifest/v1';
export const MANAGED_MANIFEST_MAX_BYTES = 900 * 1024;
const runtimes = new Set(['dsh-native', 'harness', 'codex']);
const fields = new Set(['name', 'description', 'framework', 'artifact_type', 'runtime', 'model', 'prompt', 'resources']);
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function text(value, field, limit, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > limit || value.includes('\0')
    || (field !== 'prompt' && /[\x00-\x1f]/.test(value))) fail('MANAGED_MANIFEST_INVALID', `invalid ${field}`);
  return value;
}

export function parseManagedRuntimeManifest(raw, { runtimeName, runtimeVersion } = {}) {
  if (!runtimes.has(runtimeName) || typeof runtimeVersion !== 'string' || !runtimeVersion) fail('MANAGED_RUNTIME_IDENTITY_INVALID', 'runtime selection is required');
  let source;
  try { source = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { fail('MANAGED_MANIFEST_INVALID', 'declaration must be UTF-8 YAML'); }
  if (Buffer.byteLength(source) > MANAGED_MANIFEST_MAX_BYTES) fail('MANAGED_MANIFEST_TOO_LARGE', 'declaration exceeds 900 KiB');
  let value;
  try {
    const document = parseDocument(source, { uniqueKeys: true, version: '1.2' });
    if (document.errors.length || document.warnings.length) throw Error('invalid declaration');
    visit(document, { Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw Error('declaration keys must be strings');
    } });
    value = document.toJS({ maxAliasCount: 0 });
  } catch { fail('MANAGED_MANIFEST_INVALID', 'invalid YAML declaration'); }
  if (!mapping(value)) fail('MANAGED_MANIFEST_INVALID', 'declaration root must be a mapping');
  if (Object.keys(value).some(key => !fields.has(key))) fail('MANAGED_MANIFEST_FIELD_UNSUPPORTED', 'declaration contains unsupported fields');
  if (Object.hasOwn(value, 'resources')) value.resources = validateManagedResources(value.resources);
  text(value.name, 'name', 240); text(value.model, 'model', 512); text(value.prompt, 'prompt', MANAGED_MANIFEST_MAX_BYTES, true);
  if (Object.hasOwn(value, 'description')) text(value.description, 'description', 4096, true);
  const runtime = value.runtime;
  if (!mapping(runtime) || Object.keys(runtime).sort().join(',') !== 'name,version') fail('MANAGED_MANIFEST_INVALID', 'runtime requires name and version only');
  text(runtime.version, 'runtime.version', 128);
  if (value.framework !== runtimeName || runtime.name !== runtimeName || runtime.version !== runtimeVersion || value.artifact_type !== 'ManagedRuntime') {
    fail('MANAGED_RUNTIME_IDENTITY_MISMATCH', 'declaration does not match the selected runtime');
  }
  return value;
}

/** Accept the canonical Server payload as bytes; do not reserialize YAML
 * before checking its digest. This also works with a ConfigMap symlink.
 */
export async function loadManagedRuntimeManifest(path, { env = process.env } = {}) {
  const runtimeName = env.AGENTENGINE_MANAGED_RUNTIME_NAME;
  const runtimeVersion = env.AGENTENGINE_MANAGED_RUNTIME_VERSION;
  if (env.AGENTENGINE_MANIFEST_PROTOCOL !== 'runtime-manifest/v1' || !/^[0-9a-f]{64}$/.test(env.AGENTENGINE_MANIFEST_SHA256 || '')) {
    fail('MANAGED_RUNTIME_IDENTITY_INVALID', 'manifest protocol and SHA-256 are required');
  }
  const file = await open(path, 'r');
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile()) fail('MANAGED_MANIFEST_INVALID', 'manifest must be a regular file');
    if (info.size > MANAGED_MANIFEST_MAX_BYTES) fail('MANAGED_MANIFEST_TOO_LARGE', 'declaration exceeds 900 KiB');
    // A bounded read also guards a file growing after stat().
    const buffer = Buffer.alloc(MANAGED_MANIFEST_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MANAGED_MANIFEST_MAX_BYTES) fail('MANAGED_MANIFEST_TOO_LARGE', 'declaration exceeds 900 KiB');
    bytes = buffer.subarray(0, offset);
  } finally { await file.close(); }
  const digest = sha256(bytes);
  if (digest !== env.AGENTENGINE_MANIFEST_SHA256) fail('MANAGED_MANIFEST_DIGEST_MISMATCH', 'mounted declaration SHA-256 mismatch');
  const declaration = parseManagedRuntimeManifest(bytes, { runtimeName, runtimeVersion });
  return { format: DSH_MANIFEST_FORMAT, declaration, sha256: digest };
}
