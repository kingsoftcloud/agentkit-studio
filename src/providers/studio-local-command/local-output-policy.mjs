// Versioned, opt-in execution-boundary policies. These are NOT keys in
// localControlSettings: that object is normalized and enters the command
// request digest, so adding keys there would change every historical digest.
// The policy travels as a separate optional field, preserving exact legacy
// serialization and digests when absent.
import { LocalProcessError } from './local-process.mjs';

export const OUTPUT_POLICY_CONTRACT = 'agentkit.output-policy/v1';
export const outputPolicyVersion = 'persisted-stream/v1';
export const ENVIRONMENT_POLICY_CONTRACT = 'agentkit.environment-policy/v1';
export const environmentPolicyVersion = 'local-development/v1';

// The only environment names a local-development policy may add. Never the full
// process.env and never arbitrary credentials. HOME/USERPROFILE give the command
// a home for dotfiles/cache; USER/LOGNAME/TMPDIR are basic identity/temp names.
export const BASIC_ENVIRONMENT_NAMES = Object.freeze(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'USERPROFILE']);
const basicNameSet = new Set(BASIC_ENVIRONMENT_NAMES);

const HARD_PERSISTED_CAP_BYTES = 64 * 1024 ** 2;
const isPositiveInt = value => Number.isSafeInteger(value) && value > 0;
// Enforced bounds: preview/persisted caps must be sane and persisted >= preview
// so the hard cap is always the real boundary, never the preview.
const checkBytes = (value, code, min = 1, max = HARD_PERSISTED_CAP_BYTES * 16) => {
  if (!isPositiveInt(value) || value < min || value > max) throw new LocalProcessError(code);
};

/** Parse an opt-in output policy. `null`/`undefined` => legacy semantics.
 *  Rejects unknown options and invalid limits. Frozen, deterministic, and omits
 *  undefined properties so canonical serialization (which rejects undefined)
 *  never sees them. */
export function localOutputPolicy(input = null) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new LocalProcessError('invalid_output_policy');
  const keys = Object.keys(input);
  if (!keys.every(key => key === 'version' || key === 'previewBytes' || key === 'persistedBytes'))
    throw new LocalProcessError('invalid_output_policy_option');
  const version = input.version ?? outputPolicyVersion;
  if (version !== outputPolicyVersion) throw new LocalProcessError('unsupported_output_policy_version');
  const hasPreview = Object.hasOwn(input, 'previewBytes'), hasPersisted = Object.hasOwn(input, 'persistedBytes');
  if (hasPreview) checkBytes(input.previewBytes, 'invalid_output_policy_preview');
  if (hasPersisted) checkBytes(input.persistedBytes, 'invalid_output_policy_persisted');
  // Do NOT reject persistedBytes < previewBytes here: resolveOutputPolicy clamps
  // the preview down to the persisted cap, so a caller may set a large preview and
  // a smaller persisted cap and still get a sane bounded preview. Both limits are
  // individually valid positive integers; the relationship is resolved, not parsed.
  // Omit undefined properties: canonical serialization rejects undefined, and a
  // clean object is digestable/deterministic across fresh vs legacy bindings.
  const policy = { version };
  if (hasPreview) policy.previewBytes = input.previewBytes;
  if (hasPersisted) policy.persistedBytes = input.persistedBytes;
  return Object.freeze(policy);
}

/** Parse an opt-in environment policy. `null`/`undefined` => legacy allowlist.
 *  The local-development policy may ONLY add the basic names; it cannot inject
 *  arbitrary names or credentials. Rejects unknown options. */
export function localEnvironmentPolicy(input = null) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new LocalProcessError('invalid_environment_policy');
  const keys = Object.keys(input);
  if (!keys.every(key => key === 'version' || key === 'names'))
    throw new LocalProcessError('invalid_environment_policy_option');
  const version = input.version ?? environmentPolicyVersion;
  if (version !== environmentPolicyVersion) throw new LocalProcessError('unsupported_environment_policy_version');
  let names = BASIC_ENVIRONMENT_NAMES;
  if (Object.hasOwn(input, 'names')) {
    if (!Array.isArray(input.names) || input.names.some(name => typeof name !== 'string' || !basicNameSet.has(name)))
      throw new LocalProcessError('invalid_environment_policy_names');
    names = Object.freeze([...new Set(input.names)]);
  }
  return Object.freeze({ version, names });
}

/** Resolve an output policy against control settings for runBoundedProcess.
 *  Returns { mode, previewBytes, persistedBytes }. Legacy mode preserves the
 *  exact maxOutputBytes-then-kill semantics. */
export function resolveOutputPolicy(settings, outputPolicy) {
  if (!outputPolicy) return { mode: 'legacy', previewBytes: settings.maxOutputBytes, persistedBytes: settings.maxOutputBytes };
  const previewBytes = outputPolicy.previewBytes ?? settings.maxOutputBytes;
  const persistedBytes = outputPolicy.persistedBytes ?? HARD_PERSISTED_CAP_BYTES;
  // previewBytes may exceed the legacy default but can never exceed the persisted cap.
  return { mode: 'persistedStream', previewBytes: Math.min(previewBytes, persistedBytes), persistedBytes };
}

/** Resolve an environment policy against control settings for buildScriptEnvironment.
 *  Returns the set of additional names to admit beyond the restrictive allowlist. */
export function resolveEnvironmentPolicy(settings, environmentPolicy) {
  if (!environmentPolicy) return { names: [] };
  return { names: [...environmentPolicy.names] };
}

export const OUTPUT_POLICY_HARD_PERSISTED_CAP_BYTES = HARD_PERSISTED_CAP_BYTES;
