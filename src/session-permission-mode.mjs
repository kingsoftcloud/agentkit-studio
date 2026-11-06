/**
 * Resolve the execution mode a Session's permission picker selected.
 *
 * The sandbox knob is authoritative: DSH records it as a closed three-value
 * mode, and Studio's cloud runner writes it directly when the image configures
 * no preset for `read-only`. The preset name is only a fallback, because a
 * derived `custom` cannot tell which of the three modes is in force and the
 * Codex provider must never guess (it fails closed to read-only).
 *
 * @param {{ get?: (name: string) => any }} ctx DSH context.
 * @param {object} session DSH Session.
 * @returns {string | undefined} one of the three modes, or undefined when the
 *   Session has no override (composition defaults stay in force).
 */
export function readSessionPermissionMode(ctx, session) {
  try {
    const sandbox = ctx?.get?.('sessionProjections')?.stateOf?.(session, 'sandboxMode');
    if (typeof sandbox === 'string' && sandbox) return sandbox;
    const current = ctx?.get?.('permissionPresets')?.current?.(session);
    return typeof current === 'string' && current ? current : undefined;
  } catch {
    // A missing projection or a disposing context must not fail a turn.
    return undefined;
  }
}
