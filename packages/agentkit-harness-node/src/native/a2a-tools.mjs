/**
 * Native Node A2A tools for the AgentKit Harness.
 *
 * Exports nativeA2aToolDefinitions() and createNativeA2aToolPort({scope,
 * sessionId, spaceId, discovery, invocation, exposurePlan, authorize,
 * assertCurrent}) -> {definitions, execute, contract}.
 *
 * Three sealed ToolDefinitions ported from ksadk.toolsets.a2a @355059d:
 *   list_a2a_agents — read-only discovery of remote agents in the A2A Space.
 *   get_a2a_agent_card — read-only agent card lookup by id or name.
 *   call_a2a_agent — managed invocation of a remote agent. HIGH risk with
 *     side_effect a2a_remote_call. The model provides only agent ref + message;
 *     the Host runtime supplies the invocation service, exposure plan, and
 *     authorization. The model cannot control URL/credentials/scope/trigger.
 *
 * call_a2a_agent is a managed invocation — it never fetches a model URL
 * directly. The injected `invocation` object provides:
 *   resolve({agent, message, scope, sessionId, runId, callId, operationKey,
 *     signal}) -> {spec, trigger}  — maps the model's agent/message to a
 *     fixed target via the exposure plan (no model control over target).
 *   dispatch({request, trigger, signal}) -> {status, reply, task_id, agent,
 *     output_refs, snapshots, item_kinds}
 *     — invokes the remote agent through the managed service and returns the
 *     terminal reply selected from authoritative output_refs via
 *     selectTerminalReply. The dispatch result must carry a terminal status
 *     ('completed'/'failed'/'cancelled'/'rejected'); running/unknown are not
 *     success. If the dispatch returns a non-terminal status, the result is
 *     uncertain.
 *
 * The exposure plan is REQUIRED and must fail closed: if
 * assertGenericTargetAllowed is missing, returns a thenable, or throws, the
 * call is rejected — the model cannot target arbitrary endpoints.
 * assertGenericTargetAllowed must be synchronous and return void (undefined).
 * A thenable return is observed then immediately rejected — no dispatch.
 *
 * Authorization: every execute enforces full request identity (scope four
 * domains, sessionId, run/turn/build/parent/chain/op/fence, call, definition,
 * budget, interaction, signal). assertCurrent(request)===true is required
 * (thenable observed + rejected). authorize is called before any remote
 * dispatch. call_a2a_agent's dispatch is a side effect: effectStarted is set
 * only immediately before calling dispatch (NOT before resolve/plan/guard).
 * Any throw/abort/drift/unknown-terminal AFTER effectStarted returns
 * 'uncertain' with the original frozen scope/session/run/op locator (captured
 * at entry, before any await), never 'error' that invites a blind retry.
 * Pre-dispatch rejections (resolve/plan/guard) return 'error' with
 * executed:false. Discovery/card are read-only and safely retryable.
 *
 * The locator is frozen at entry from the immutable bound scope — callback
 * tampering of the mutable request cannot pollute the uncertain receipt.
 * The frozen signal (captured at guard construction) is used for abort
 * checks, never the mutable request.signal.
 *
 * Binding digest requires a serializable binding description from the Host:
 * sourceRef, sourceDigest, spaceId, planDigest, transport, version.
 * Missing fields fail closed. No secrets in digest.
 *
 * list/card sanitize agent metadata: only safe fields with strict per-field
 * byte limits, strip userinfo/query from URLs, enforce a total JSON byte
 * budget by iteratively truncating the actual serialized output (not a
 * fixed count). Not-found hints are also byte-bounded.
 */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant, toolInputRejection, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_A2A_TOOLS_CONTRACT = 'agentkit.native-a2a-tools/v1';
export const DSH_A2A_TOOLS_CONTRACT = 'agentkit.dsh-a2a-tools/v1';
const lockFailure = code => Object.assign(new Error(code), { code });
const MAX_AGENT_LIST_BYTES = 256 * 1024; // 256 KiB total JSON budget
const MAX_AGENT_FIELD_BYTES = 4096; // per-field byte limit
const MAX_HINT_BYTES = 64 * 1024; // 64 KiB for not-found hints
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const SAFE_AGENT_FIELDS = new Set(['agent_id', 'name', 'description', 'version_id', 'card_sha256', 'source', 'url']);

function freezeJson(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeJson(item); Object.freeze(value); }
  return value;
}

// Cancellation must finish even when an injected service ignores the signal.
// Observe late rejection, but never resume this call after cancellation.
function abortable(signal, work) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    let pending;
    try { pending = work(); } catch (error) { pending = Promise.reject(error); }
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function def(name, description, parameters, opts) {
  return {
    name, description, parameters: copy(parameters),
    readOnly: opts.readOnly, concurrentSafe: opts.concurrentSafe,
    permissions: opts.permissions || [], timeoutMs: opts.timeoutMs,
    contextRole: opts.contextRole || 'none', observationRole: 'none',
    progressObservation: false, contextRetention: 'normal',
  };
}

export function nativeA2aToolDefinitions({ receiptObservation = false } = {}) {
  return [
    def('list_a2a_agents', 'List remote A2A agents in the configured A2A Space. Returns each agent\'s id, name, description and version. No remote calls are made to the agents themselves — only discovery metadata.', {
      type: 'object', properties: {}, additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, timeoutMs: 30_000 }),
    def('get_a2a_agent_card', 'Get the AgentCard of a remote A2A agent by id or name. Accepts the A2AAgentId (a2a-agent-*) or the card name. When not found, returns available_agents and a suggestion.', {
      type: 'object',
      properties: { agent: { type: 'string', description: 'The A2A agent id (a2a-agent-*) or card name.' } },
      required: ['agent'], additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, timeoutMs: 30_000 }),
    def('call_a2a_agent', 'Invoke a managed remote agent and return its reply. The runtime supplies authorization, actual call identity and a fixed target. The model provides only the agent reference and message.', {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The A2A agent id (a2a-agent-*) or card name.' },
        message: { type: 'string', description: 'The message to send to the remote agent.' },
      },
      required: ['agent', 'message'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, permissions: ['a2a:call'], timeoutMs: 90_000 }),
  ].map(tool => receiptObservation && tool.name === 'call_a2a_agent'
    ? { ...tool, recoveryPolicy: 'receipt-observation/v1' } : tool);
}

/** Normalize an agent reference: strip, lower, remove a2a-agent- prefix. */
function normalizeAgentRef(value) {
  return String(value || '').trim().toLowerCase().replace(/^a2a-agent-/, '');
}

/** Match an agent reference against a list of discovered agents. */
function matchAgent(agents, ref) {
  const target = normalizeAgentRef(ref);
  if (!target) return { matched: null, hint: agents.map(a => a.agent_id) };
  for (const a of agents) {
    if (normalizeAgentRef(a.agent_id) === target || normalizeAgentRef(a.name) === target) {
      return { matched: a, hint: [] };
    }
  }
  const allNames = [
    ...agents.map(a => normalizeAgentRef(a.agent_id)),
    ...agents.filter(a => a.name).map(a => normalizeAgentRef(a.name)),
  ];
  let suggestion = null;
  for (const name of allNames) {
    if (name.includes(target) || target.includes(name)) { suggestion = name; break; }
  }
  return { matched: null, hint: [...agents.map(a => a.agent_id), ...(suggestion ? [suggestion] : [])] };
}

/** Strip userinfo and query from a URL for safe display. Only origin+path. */
function sanitizeUrl(url) {
  const value = String(url || '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    return parsed.toString();
  } catch { return ''; } // invalid URL → empty, never echo raw
}

/** Sanitize agent metadata: only allow safe fields, strip secrets, truncate
 *  per-field UTF-8 bytes (not JS chars), sanitize URLs. */
function sanitizeAgent(agent) {
  const safe = {};
  for (const key of SAFE_AGENT_FIELDS) {
    if (agent[key] == null) continue;
    if (key === 'url') { safe[key] = truncateUtf8(sanitizeUrl(agent[key]), MAX_AGENT_FIELD_BYTES); }
    else { safe[key] = truncateUtf8(String(agent[key]), MAX_AGENT_FIELD_BYTES); }
  }
  return safe;
}

/** Truncate a string to maxBytes UTF-8, not cutting mid-codepoint. */
function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) return str;
  // Find the last valid UTF-8 boundary at or before maxBytes.
  let cut = maxBytes;
  // Walk back to a valid boundary (not a continuation byte 10xxxxxx).
  while (cut > 0 && (buf[cut] & 0xC0) === 0x80) cut--;
  return buf.subarray(0, cut).toString('utf8');
}

/** Bounded agent list: iteratively truncate the ACTUAL serialized JSON of the
 *  complete content envelope (not just the agents array) until it is under
 *  the byte budget. The budget covers the full { ok, space_id, agents }
 *  object with JSON escaping. */
function sanitizeAgentList(agents, spaceId, maxBytes = MAX_AGENT_LIST_BYTES) {
  const envelope = agents => ({ ok: true, space_id: spaceId, agents });
  if (Buffer.byteLength(JSON.stringify(envelope([])), 'utf8') > maxBytes) {
    return { ok: false, error_type: 'a2a_discovery_result_too_large', error_message: 'Configured discovery metadata exceeds the output byte limit' };
  }
  const sanitized = (agents || []).filter(a => a && typeof a === 'object').map(sanitizeAgent);
  // Binary search for the largest prefix where the full envelope fits.
  let lo = 0, hi = sanitized.length, best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const json = JSON.stringify(envelope(sanitized.slice(0, mid)));
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return envelope(sanitized.slice(0, best));
}

/** Bounded hint list for not-found responses. */
function boundedHint(hint, maxBytes = MAX_HINT_BYTES) {
  const ids = [...new Set(hint.filter(Boolean).map(value => truncateUtf8(String(value), MAX_AGENT_FIELD_BYTES)))];
  const envelope = available_agents => ({ ok: false, error_message: 'Agent not found', available_agents });
  let result = [];
  for (const id of ids) {
    const candidate = [...result, id];
    if (Buffer.byteLength(JSON.stringify(envelope(candidate))) > maxBytes) break;
    result = candidate;
  }
  return envelope(result);
}

/** Select the terminal reply from authoritative output_refs and snapshots,
 *  ported from ksadk.a2a.result_text.select_terminal_reply. Prefers the last
 *  text artifact; falls back to the last agent message. */
function selectTerminalReply(outputRefs, snapshots, itemKinds) {
  const selected = new Map(), ordered = { artifact: [], message: [] };
  for (const ref of outputRefs || []) {
    const key = `${ref.scope_id}:${ref.item_id}`;
    if (!Object.hasOwn(itemKinds, key) || !Object.hasOwn(snapshots, key)) continue;
    const kind = itemKinds[key];
    const parts = snapshots[key];
    if (!parts || !Object.hasOwn(ordered, kind)) continue;
    if (!selected.has(key)) { selected.set(key, []); ordered[kind].push(key); }
    if (ref.part_id == null) { for (const v of Object.values(parts)) if (typeof v === 'string' && v) selected.get(key).push(v); }
    else if (Object.hasOwn(parts, String(ref.part_id))) {
      const v = parts[String(ref.part_id)]; if (typeof v === 'string' && v) selected.get(key).push(v);
    }
  }
  const candidates = ordered.artifact.length ? ordered.artifact : ordered.message;
  if (!candidates.length) return '';
  return selected.get(candidates[candidates.length - 1]).join('');
}

/** Same result semantics for execution and an independently verified old receipt. */
export function nativeA2aTerminalResult(observation, agent) {
  invariant(TERMINAL_STATUSES.has(observation?.state), 'a2a_terminal_receipt_required');
  const content = { ok: observation.state === 'completed', agent, task_id: observation.task_id,
    state: observation.state, reply: observation.state === 'completed'
      ? selectTerminalReply(observation.output_refs, observation.snapshots, observation.item_kinds) : '' };
  return { status: content.ok ? 'ok' : 'error', content };
}

// ---- Identity guard --------------------------------------------------------

function createIdentityGuard(request, assertCurrent) {
  const captureBody = () => {
    const body = {};
    for (const key of Object.keys(request)) {
      if (key === 'signal') continue;
      body[key] = request[key];
    }
    return canonical(body);
  };
  const before = captureBody();
  const signal = request.signal; // frozen signal identity
  return () => {
    if (assertCurrent) {
      const result = assertCurrent(request);
      if (result !== true) {
        if (result && typeof result.then === 'function') { result.then(() => {}, () => {}); }
        throw lockFailure('a2a_lease_lost');
      }
    }
    if (signal !== request.signal) throw lockFailure('a2a_signal_replaced');
    if (before !== captureBody()) throw lockFailure('a2a_context_drift');
    signal.throwIfAborted(); // use frozen signal, not request.signal
  };
}

function validateStrictIdentity(request, definition) {
  const errors = [];
  const scope = request.scope;
  if (!scope || typeof scope !== 'object' || !scope.tenantId || !scope.workspaceId || !scope.userId || !scope.agentId) errors.push('scope must have all four domains');
  if (!request.sessionId || typeof request.sessionId !== 'string') errors.push('sessionId must be a non-empty string');
  for (const f of ['runId', 'turnId', 'buildId', 'taskChainId', 'operationKey']) {
    if (!request[f] || typeof request[f] !== 'string') errors.push(`${f} must be a non-empty string`);
  }
  if (request.callId == null && request.call?.callId == null) errors.push('callId must be present');
  if (request.parentRunId != null && (typeof request.parentRunId !== 'string' || !request.parentRunId)) errors.push('parentRunId must be null or non-empty');
  if (!Number.isSafeInteger(request.executionFence) || request.executionFence <= 0) errors.push('executionFence must be a positive integer');
  if (!(request.signal instanceof AbortSignal)) errors.push('signal must be an AbortSignal instance');
  if (request.definition == null) errors.push('request.definition is required');
  else if (!matchesToolExecutionContract(request.definition, definition)) errors.push('request.definition must equal the locked formal execution contract');
  return errors;
}

function validateDshIdentity(request, definition, owner) {
  const errors = [];
  for (const key of ['scope', 'runId', 'turnId', 'taskChainId', 'executionFence', 'parentRunId'])
    if (Object.hasOwn(request, key)) errors.push('Native identity is not a DSH call');
  if (request.agentId !== owner.agentId || request.agentRevision !== owner.agentRevision || request.buildId !== owner.buildId)
    errors.push('DSH owner binding mismatch');
  if (typeof request.operationKey !== 'string' || !request.operationKey.trim()
    || typeof request.call?.callId !== 'string' || !request.call.callId.trim()) errors.push('DSH call identity required');
  if (!(request.signal instanceof AbortSignal)) errors.push('signal must be an AbortSignal instance');
  if (canonical(request.definition) !== canonical(definition)) errors.push('definition mismatch');
  return errors;
}

// ---- Tool implementations --------------------------------------------------

async function listA2aAgents({ discovery, spaceId, signal, guard }) {
  if (!spaceId) return { ok: false, error_message: 'A2A Space not configured' };
  try { guard(); } catch (e) { if (signal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost before discovery' }; }
  let agents;
  try { agents = await abortable(signal, () => discovery.list({ spaceId, signal })); }
  catch (error) { if (signal.aborted) throw error; return { ok: false, error_type: 'a2a_discovery_failed', error_message: 'Unable to list A2A agents' }; }
  try { guard(); } catch (e) { if (signal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost after discovery' }; }
  return sanitizeAgentList(agents, spaceId);
}

async function getA2aAgentCard({ discovery, spaceId, agent, signal, guard }) {
  if (!spaceId) return { ok: false, error_message: 'A2A Space not configured' };
  try { guard(); } catch (e) { if (signal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost before discovery' }; }
  let agents;
  try { agents = await abortable(signal, () => discovery.list({ spaceId, signal })); }
  catch (error) { if (signal.aborted) throw error; return { ok: false, error_type: 'a2a_discovery_failed', error_message: 'Unable to list A2A agents' }; }
  try { guard(); } catch (e) { if (signal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost after discovery' }; }
  const { matched, hint } = matchAgent(agents, agent);
  if (!matched) return boundedHint(hint);
  return { ok: true, agent: sanitizeAgent(matched) };
}

async function callA2aAgent({ invocation, exposurePlan, agent, message, frozenLocator, frozenSignal, guard, request, effect, dsh }) {
  if (!invocation || typeof invocation.resolve !== 'function' || typeof invocation.dispatch !== 'function') {
    return { ok: false, error_type: 'A2A_MANAGED_INVOCATION_CONTEXT_REQUIRED', error_message: 'Managed A2A invocation context is required' };
  }
  if (!String(message || '').trim()) return { ok: false, error_message: 'message is required' };
  // exposurePlan is REQUIRED and must fail closed.
  if (!exposurePlan || typeof exposurePlan.assertGenericTargetAllowed !== 'function') {
    return { ok: false, error_type: 'A2A_EXPOSURE_PLAN_REQUIRED', error_message: 'Exposure plan is required and must fail closed' };
  }
  try { guard(); } catch (e) { if (frozenSignal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost before resolve' }; }
  let resolved;
  try {
    resolved = await abortable(frozenSignal, () => invocation.resolve({ agent, message, scope: request.scope, sessionId: request.sessionId, runId: request.runId, callId: request.call?.callId, operationKey: request.operationKey, signal: frozenSignal,
      ...(dsh ? { dshRequest: request } : { nativeRequest: request }) }));
  } catch (error) {
    if (frozenSignal.aborted) throw error;
    return { ok: false, error_type: 'A2A_INVOCATION_FAILED', error_message: 'Managed A2A invocation failed' };
  }
  // Seal the resolved spec/trigger immediately — plan/permission callbacks
  // cannot mutate the target after resolution.
  const sealedResolved = freezeJson(copy(resolved));
  const sealedSpec = sealedResolved.spec;
  const sealedTrigger = sealedResolved.trigger;
  invariant(typeof sealedSpec?.target_agent_id === 'string' && sealedSpec.target_agent_id.trim(), 'a2a_target_required');
  // The exposure plan validates that the resolved target is a generic allowed
  // agent. assertGenericTargetAllowed must be SYNCHRONOUS: return undefined
  // (void). Any non-undefined return (false, 0, thenable, etc.) is rejected.
  try {
    const planResult = exposurePlan.assertGenericTargetAllowed(sealedSpec.target_agent_id);
    if (planResult !== undefined) {
      if (planResult && typeof planResult.then === 'function') {
        planResult.then(() => {}, () => {}); // observe to prevent unhandledRejection
      }
      return { ok: false, error_type: 'A2A_EXPOSURE_PLAN_INVALID_RETURN', error_message: 'Exposure plan must return undefined; non-undefined or thenable is rejected' };
    }
  } catch (error) { return { ok: false, error_type: 'A2A_TARGET_NOT_ALLOWED', error_message: 'The resolved target is not allowed by the exposure plan' }; }
  try { guard(); } catch (e) { if (frozenSignal.aborted) throw e; return { ok: false, error_type: e.code, error_message: 'Lease lost before dispatch' }; }
  // effectStarted is set ONLY immediately before calling dispatch.
  // Pre-dispatch rejections return error:executed=false.
  // The sealed spec/trigger is used for dispatch — the target cannot change.
  try {
    effect.agent = sealedSpec.target_agent_id;
    effect.started = true; // shared with the outer final guard, before dispatch
    const dispatchResult = await abortable(frozenSignal, () => invocation.dispatch({ request: sealedResolved, trigger: sealedTrigger, signal: frozenSignal }));
    // Preserve a known remote task even if later result interpretation aborts.
    effect.taskId = dispatchResult?.task_id ?? null;
    // Guard after dispatch using frozen signal.
    try { guard(); } catch (e) {
      return { ok: false, error_type: 'A2A_INVOCATION_UNCERTAIN', error_message: 'Lease lost after dispatch; the remote call may have completed', agent: effect.agent, executed: true, task_id: effect.taskId, operation_locator: frozenLocator };
    }
    // Validate terminal status. running/unknown are NOT success.
    const status = String(dispatchResult?.state || dispatchResult?.status || 'unknown').toLowerCase();
    if (!TERMINAL_STATUSES.has(status)) {
      return { ok: false, error_type: 'A2A_INVOCATION_UNCERTAIN', error_message: `Invocation is not terminal (state: ${status})`, agent: effect.agent, executed: true, task_id: effect.taskId, operation_locator: frozenLocator };
    }
    // Select reply from authoritative output_refs only.
    const reply = status === 'completed'
      ? selectTerminalReply(dispatchResult.output_refs, dispatchResult.snapshots || {}, dispatchResult.item_kinds || {})
      : '';
    return { ok: status === 'completed', agent: effect.agent, task_id: effect.taskId, state: status, reply };
  } catch (error) {
    if (frozenSignal.aborted && !effect.started) throw error;
    // effectStarted — dispatch may have started. Uncertain with frozen locator.
    return { ok: false, error_type: 'A2A_INVOCATION_UNCERTAIN', error_message: 'Dispatch failed; the remote call may have been sent', agent: effect.agent, executed: effect.started, task_id: effect.taskId, operation_locator: frozenLocator };
  }
}

// ---- Factory ---------------------------------------------------------------

export function createNativeA2aToolPort(options = {}) { return createA2aToolPort(options, false); }
export function createDshA2aToolPort(options = {}) { return createA2aToolPort(options, true); }

function createA2aToolPort({
  agentId, agentRevision, buildId = null, scope: boundScopeInput, sessionId, spaceId, discovery, invocation, exposurePlan,
  authorize, assertCurrent, bindingDescription, receiptObservation = false,
} = {}, dsh) {
  invariant(typeof sessionId === 'string' && sessionId, 'a2a_session_required');
  invariant(typeof discovery?.list === 'function', 'a2a_discovery_required');
  invariant(typeof authorize === 'function', 'a2a_authorize_required');
  invariant(typeof assertCurrent === 'function', 'a2a_assert_current_required');
  if (dsh) invariant(typeof agentId === 'string' && agentId.trim() && Number.isSafeInteger(agentRevision) && agentRevision > 0
    && (buildId === null || typeof buildId === 'string' && buildId.trim()), 'a2a_dsh_owner_required');
  else invariant(boundScopeInput && boundScopeInput.tenantId && boundScopeInput.workspaceId && boundScopeInput.userId && boundScopeInput.agentId, 'a2a_bound_scope_required');
  const contract = dsh ? DSH_A2A_TOOLS_CONTRACT : NATIVE_A2A_TOOLS_CONTRACT;
  // bindingDescription is a serializable object from the Host containing
  // sourceRef, sourceDigest, spaceId, planDigest, transport, version.
  // Required for a stable bindingDigest that detects plan/transport changes.
  invariant(bindingDescription && typeof bindingDescription === 'object', 'a2a_binding_description_required');
  invariant(typeof bindingDescription.sourceRef === 'string' && bindingDescription.sourceRef, 'a2a_source_ref_required');
  invariant(typeof bindingDescription.sourceDigest === 'string' && bindingDescription.sourceDigest, 'a2a_source_digest_required');
  invariant(typeof bindingDescription.planDigest === 'string' && bindingDescription.planDigest, 'a2a_plan_digest_required');
  invariant(typeof bindingDescription.transport === 'string' && bindingDescription.transport, 'a2a_transport_required');
  invariant(typeof bindingDescription.version === 'string' && bindingDescription.version, 'a2a_version_required');
  const boundScope = dsh ? null : Object.freeze(copy(boundScopeInput));
  invariant(!dsh || !receiptObservation, 'a2a_native_receipt_policy_not_dsh');
  const definitions = nativeA2aToolDefinitions({ receiptObservation });
  const formal = new Map(definitions.map(item => [item.name, item]));

  async function execute(request) {
    if (!request || typeof request !== 'object') return { status: 'error', content: { code: 'invalid_request', message: 'request object required' } };
    if (request.sessionId !== sessionId) return { status: 'error', content: { code: 'a2a_session_mismatch' } };
    if (!dsh && canonical(request.scope) !== canonical(boundScope)) return { status: 'error', content: { code: 'invalid_identity', message: 'request.scope must match the trusted bound scope' } };
    const idErrors = dsh ? validateDshIdentity(request, formal.get(request.call?.name) || {}, { agentId, agentRevision, buildId })
      : validateStrictIdentity(request, formal.get(request.call?.name) || {});
    if (idErrors.length) return { status: 'error', content: { code: 'invalid_identity', message: idErrors.join('; ') } };
    const call = request.call;
    const definition = formal.get(call.name);
    if (!definition) return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${call.name}` } };
    const rejection = toolInputRejection(definition, call);
    if (rejection) return { status: 'error', content: rejection };
    request.signal.throwIfAborted();

    // Freeze the locator at entry from the immutable bound scope — before any
    // await. Callback tampering of the mutable request cannot pollute the
    // uncertain receipt. The frozen signal is captured by createIdentityGuard
    // and used for all abort checks (not the mutable request.signal).
    const frozenLocator = Object.freeze(dsh ? { contract, agentId, agentRevision, buildId, sessionId,
      operationKey: request.operationKey, callId: request.call.callId } : {
      scope: boundScope, sessionId: request.sessionId, runId: request.runId,
      turnId: request.turnId, buildId: request.buildId, parentRunId: request.parentRunId ?? null,
      taskChainId: request.taskChainId, operationKey: request.operationKey,
      executionFence: request.executionFence, callId: call.callId,
    });
    const frozenSignal = request.signal; // captured before any await
    const guard = createIdentityGuard(request, assertCurrent);
    let decision;
    try { guard(); } catch (error) { if (frozenSignal.aborted) throw error; return { status: 'error', content: { code: error.code, executed: false } }; }
    try { decision = await abortable(frozenSignal, () => authorize(request)); }
    catch (error) { if (frozenSignal.aborted) throw error; return { status: 'error', content: { code: 'authorize_failed', message: 'authorization failed' } }; }
    try { guard(); } catch (e) { if (frozenSignal.aborted) throw e; return { status: 'error', content: { code: e.code, executed: false } }; }
    if (decision !== 'allow') {
      if (decision?.status === 'approval_required' && typeof decision.interactionId === 'string') return decision;
      return { status: 'error', content: { code: 'policy_denied', executed: false } };
    }
    const args = copy(call.arguments);
    // Dispatch records effect state directly. Return content is not an
    // authority for deciding whether an external call has already started.
    const effect = { started: false, taskId: null, agent: args.agent };
    const uncertain = content => ({ status: 'uncertain', content: {
      ...content, ok: false, error_type: 'A2A_INVOCATION_UNCERTAIN',
      agent: effect.agent, executed: true, task_id: effect.taskId, operation_locator: frozenLocator,
    } });
    try {
      if (call.name === 'list_a2a_agents') {
        const content = await listA2aAgents({ discovery, spaceId, signal: frozenSignal, guard });
        try { guard(); } catch (e) { if (frozenSignal.aborted) throw e; return { status: 'error', content: { code: e.code, executed: false } }; }
        return { status: content.ok ? 'ok' : 'error', content };
      }
      if (call.name === 'get_a2a_agent_card') {
        const content = await getA2aAgentCard({ discovery, spaceId, agent: args.agent, signal: frozenSignal, guard });
        try { guard(); } catch (e) { if (frozenSignal.aborted) throw e; return { status: 'error', content: { code: e.code, executed: false } }; }
        return { status: content.ok ? 'ok' : 'error', content };
      }
      if (call.name === 'call_a2a_agent') {
        const content = await callA2aAgent({ invocation, exposurePlan, agent: args.agent, message: args.message, frozenLocator, frozenSignal, guard, request, effect, dsh });
        // Final guard after all operations — uses frozen signal.
        try { guard(); } catch (e) {
          if (frozenSignal.aborted && !effect.started) throw e;
          // If the guard throws after an effect, return uncertain with frozen
          // locator — never lose the effect by returning a bare error.
          if (effect.started) return uncertain(content);
          return { status: 'error', content: { ...content, ok: false, error_type: e.code, executed: false } };
        }
        if (content.error_type === 'A2A_INVOCATION_UNCERTAIN') return uncertain(content);
        return { status: content.ok ? 'ok' : 'error', content };
      }
    } catch (error) {
      if (frozenSignal.aborted && !effect.started) throw error;
      if (effect.started) return uncertain({ error_message: 'Operation interrupted after dispatch; the remote call may have completed' });
      return { status: 'error', content: { ok: false, error_type: error.code || 'A2AError', error_message: 'Operation failed' } };
    }
    return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${call.name}` } };
  }

  // Binding digest from the serializable binding description — no secrets.
  const bindingDigest = createHash('sha256').update(canonical({
    contract,
    sourceRef: bindingDescription.sourceRef,
    sourceDigest: bindingDescription.sourceDigest,
    spaceId: bindingDescription.spaceId || spaceId || '',
    planDigest: bindingDescription.planDigest,
    transport: bindingDescription.transport,
    version: bindingDescription.version,
    ...(dsh ? { agentId, agentRevision, buildId } : { scope: boundScope }),
    sessionId,
  })).digest('hex');

  return { definitions: definitions.map(item => copy(item)), execute, contract, bindingDigest };
}
