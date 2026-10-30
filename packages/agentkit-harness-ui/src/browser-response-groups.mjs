import { toolIdentity } from './tool-identity.mjs';

const isTool = item => ['tool', 'tool-preview'].includes(item.kind);
const isBrowser = item => isTool(item) && !item.child && (toolIdentity(item.name).family === 'browser'
  || ['mcp__computer-use__', 'mcp__plugin_zcode-cua_computer-use__'].some(prefix => item.name?.startsWith(prefix)));

/** Response membership is a Host fact, not adjacency or text inference. This
 * read-only projection mirrors the reference CUA flow: pure browser responses
 * share a work stage; mixed responses and final prose stay in the outer flow. */
export function browserResponseGroups(items, { stageTailIsRunning = false } = {}) {
  const responses = new Map();
  for (const item of items) if (isTool(item) && item.responseId) {
    const value = responses.get(item.responseId) ?? { browser: false, other: false };
    if (isBrowser(item)) value.browser = true; else value.other = true;
    responses.set(item.responseId, value);
  }
  const result = [], identities = new Map(); let active = null;
  const close = () => { if (active) active.active = false; active = null; };
  const append = item => {
    if (!active) {
      const identity = item.responseId ? `activity:browser:response:${item.responseId}`
        : `activity:browser:call:${item.callId ?? item.id}`;
      const occurrence = identities.get(identity) ?? 0;
      identities.set(identity, occurrence + 1);
      // A mixed response can resume browser work after another tool. Distinct
      // stages must not share React keys or disclosure state with one another.
      active = { kind: 'activity-group', id: occurrence ? `${identity}:stage:${occurrence}` : identity,
        family: 'browser', children: [], events: [], active: true,
        failed: 0, uncertain: 0 };
      result.push(active);
    }
    active.events.push(item);
    if (isBrowser(item)) {
      active.children.push(item);
      if (item.status === 'failed') active.failed++;
      if (['uncertain', 'interrupted', 'waiting'].includes(item.status)) active.uncertain++;
    }
  };
  for (const item of items) {
    if (isBrowser(item)) { append(item); continue; }
    if (isTool(item) || item.kind === 'text' && item.role === 'user') { close(); result.push(item); continue; }
    if (item.kind === 'text' || item.kind === 'thought') {
      const classification = item.responseId && responses.get(item.responseId);
      if (classification?.browser && !classification.other) { append(item); continue; }
      // A future tool declaration may classify streaming text/reasoning. Keep
      // it exactly where it is until evidence arrives, without closing an
      // earlier browser stage merely because the new response is incomplete.
      if (item.kind === 'thought' && !classification || item.kind === 'text' && item.responseId && !classification && item.streaming) {
        result.push(item); continue;
      }
      close(); result.push(item); continue;
    }
    result.push(item);
  }
  if (!stageTailIsRunning) close();
  return result;
}
