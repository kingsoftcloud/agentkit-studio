import { localControlSettings } from './local-process.mjs';

export const LOCAL_RESOURCE_PROFILE = 'agentkit.local-resource-profile/v1';
const profiles = Object.freeze({
  'bounded/v1': Object.freeze({}),
  // Repository packs and build artifacts routinely exceed the restricted
  // per-file allowance. Keep a finite development allowance; explicit Host
  // settings always win. Other limits retain their existing values.
  'local-development/v1': Object.freeze({ maxFileBytes: 1024 ** 3 }),
});
export function validLocalResourceProfile(profile) {
  return typeof profile === 'string' && Object.hasOwn(profiles, profile);
}

/** Host admission selects this policy, never a model/tool argument. */
export function localResourceSettings({ profile = 'bounded/v1', settings = {} } = {}) {
  if (!validLocalResourceProfile(profile)) throw Error('invalid_local_resource_profile');
  // Validate raw settings before merging: unknown keys/invalid overrides must
  // not be hidden by profile defaults.
  localControlSettings(settings);
  return localControlSettings({ ...profiles[profile], ...settings });
}

/** These are requested limits. Per-command receipts remain authoritative for
 * OS hard-limit clamping, unsupported controls and actual process outcomes. */
export function localResourceFacts(profile, settings) {
  if (!validLocalResourceProfile(profile)) throw Error('invalid_local_resource_profile');
  const selected = localControlSettings(settings);
  return { contract: LOCAL_RESOURCE_PROFILE, profile, requestedLimits: Object.fromEntries(
    ['cpuSeconds', 'addressSpaceBytes', 'maxProcesses', 'maxOpenFiles', 'maxFileBytes', 'wallSeconds']
      .map(key => [key, selected[key]])) };
}
