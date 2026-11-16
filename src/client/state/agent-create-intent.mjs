/** Cross-panel intent for opening the manual Agent form.
 *
 *  The Agent workspace owns its own list/create/edit view state, so a surface
 *  in another panel (the Overview start card) cannot switch it directly.
 *  Record the intent and announce it: a workspace that is already mounted
 *  opens the form from the event, and one that mounts afterwards consumes the
 *  pending intent. Consuming clears it so a later visit starts on the list.
 */
export const MANUAL_AGENT_CREATE_EVENT = 'agentkit-studio:create-manual-agent';

let pending = false;

export function requestManualAgentCreate(window = globalThis.window) {
  pending = true;
  window?.dispatchEvent(new CustomEvent(MANUAL_AGENT_CREATE_EVENT));
}

export function consumeManualAgentCreate() {
  if (!pending) return false;
  pending = false;
  return true;
}
