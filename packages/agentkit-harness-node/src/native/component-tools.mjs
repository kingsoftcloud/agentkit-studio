/**
 * Native component_status tool port.
 *
 * Ports ksadk.toolsets.platform.component_status: a read-only tool that reports
 * the AgentEngine built-in toolset and runtime binding status. The Host passes
 * a fixed admission status snapshot at construction; the port never reads
 * process.env, the filesystem, or the network, never auto-discovers bindings,
 * and never exposes credentials. A component that is not bound is reported
 * explicitly as not enabled.
 *
 * Status is data, not a capability authorization: the real Native ledger owns
 * authority via the required assertCurrent callback, and status never lets the
 * model choose an environment, service endpoint, or backend.
 */
import { canonical, copy, invariant, scopeKey, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';

export const NATIVE_COMPONENT_TOOLS_CONTRACT = 'agentkit.native-component-tools/v1';

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_ARRAY = 4096;
const MAX_STRING = 8192;
const ENABLED_DISABLED = new Set(['enabled', 'not_enabled']);

/** Reject any key in object that is not in the allowlist. */
function rejectUnknownKeys(object, allow, prefix) {
  for (const key of Object.keys(object)) {
    invariant(allow.has(key), `component_status_unknown_field:${prefix}${key}`);
  }
}

/** Validate a Host-provided status snapshot with precise per-field allowlists
 *  at every nesting level. Unknown fields (including secrets) are rejected,
 *  never silently dropped. Returns a frozen deep clone the caller cannot
 *  mutate after construction. Missing tool lists default to empty — the port
 *  never claims tools are available that the Host did not bind. */
export function componentStatusSnapshot(raw) {
  invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'component_status_invalid');
  rejectUnknownKeys(raw, new Set(['summary', 'skill_space', 'skill_runtime', 'sandbox', 'workspace']), '');

  const summary = group(raw.summary, new Set(['model', 'knowledge_base_bound', 'long_term_memory_bound',
    'skill_space_bound', 'isolated_execution', 'sandbox_direct_tools']), 'summary.');
  const skillSpace = group(raw.skill_space, new Set(['space_ids', 'user_space_ids', 'public_space_ids',
    'service_url', 'aicp_endpoint_mode', 'tools']), 'skill_space.');
  const skillRuntime = group(raw.skill_runtime, new Set(['backend', 'enabled', 'template_bound',
    'request_protocol']), 'skill_runtime.');
  const sandbox = group(raw.sandbox, new Set(['backend', 'enabled', 'template_bound', 'tools']), 'sandbox.');
  const workspace = group(raw.workspace, new Set(['root', 'tools', 'boundary', 'editing_model']), 'workspace.');

  const result = deepFreeze(copy({
    // ok:true is a Host-fixed read-only result the port always emits (mirrors
    // the Python component_status return). It is NOT accepted from the input
    // status snapshot — the model cannot set it.
    ok: true,
    summary: {
      model: stringField(summary.model),
      knowledge_base_bound: boolField(summary.knowledge_base_bound),
      long_term_memory_bound: boolField(summary.long_term_memory_bound),
      skill_space_bound: boolField(summary.skill_space_bound),
      isolated_execution: enabledDisabled(summary.isolated_execution),
      sandbox_direct_tools: enabledDisabled(summary.sandbox_direct_tools),
    },
    skill_space: {
      space_ids: stringArrayField(skillSpace.space_ids),
      user_space_ids: stringArrayField(skillSpace.user_space_ids),
      public_space_ids: stringArrayField(skillSpace.public_space_ids),
      service_url: stringField(skillSpace.service_url),
      aicp_endpoint_mode: stringField(skillSpace.aicp_endpoint_mode) || 'auto',
      tools: stringArrayField(skillSpace.tools),
    },
    skill_runtime: {
      backend: stringField(skillRuntime.backend) || 'disabled',
      enabled: boolField(skillRuntime.enabled),
      template_bound: boolField(skillRuntime.template_bound),
      request_protocol: stringField(skillRuntime.request_protocol) || '--request-file JSON envelope',
    },
    sandbox: {
      backend: stringField(sandbox.backend) || 'disabled',
      enabled: boolField(sandbox.enabled),
      template_bound: boolField(sandbox.template_bound),
      tools: stringArrayField(sandbox.tools),
    },
    workspace: {
      root: stringField(workspace.root),
      tools: stringArrayField(workspace.tools),
      boundary: stringField(workspace.boundary)
        || 'Workspace tools are confined to the AgentEngine UI workspace directory.',
      editing_model: stringField(workspace.editing_model)
        || 'write tools support whole-file writes; edit_workspace_file supports exact snippet '
          + 'replacement; lint_workspace_file provides lightweight built-in checks.',
    },
  }));
  invariant(Buffer.byteLength(canonical(result), 'utf-8') <= MAX_RESULT_BYTES, 'component_status_oversized');
  return result;
}

function group(value, allow, prefix) {
  if (value === undefined || value === null) return {};
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'component_status_field_invalid');
  rejectUnknownKeys(value, allow, prefix);
  return value;
}

function boolField(value) {
  invariant(value === undefined || typeof value === 'boolean', 'component_status_field_invalid');
  return value === true;
}

function stringField(value) {
  if (value === undefined || value === null) return '';
  invariant(typeof value === 'string' && value.length <= MAX_STRING, 'component_status_field_invalid');
  return value;
}

function stringArrayField(value) {
  if (value === undefined || value === null) return [];
  invariant(Array.isArray(value) && value.length <= MAX_ARRAY, 'component_status_field_invalid');
  for (const item of value) invariant(typeof item === 'string' && item.length <= MAX_STRING, 'component_status_field_invalid');
  return value;
}

function enabledDisabled(value) {
  if (value === undefined || value === null) return 'not_enabled';
  if (typeof value === 'boolean') return value ? 'enabled' : 'not_enabled';
  invariant(typeof value === 'string' && ENABLED_DISABLED.has(value), 'component_status_field_invalid');
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function errorResult(code) {
  return { status: 'error', content: { code, executed: false } };
}

const FORMAL_DEFINITION = deepFreeze({
  name: 'component_status',
  description: 'Report the AgentEngine built-in toolset and runtime binding status '
    + '(model, knowledge base, long-term memory, skill space, skill runtime, sandbox, workspace). '
    + 'Read-only: returns the Host-fixed admission snapshot; does not discover bindings, read '
    + 'environment variables, or expose credentials.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  readOnly: true,
  concurrentSafe: true,
  permissions: [],
  timeoutMs: 30000,
  contextRole: 'none',
  observationRole: 'none',
  progressObservation: false,
  contextRetention: 'normal',
});

/** Return an isolated copy of the fixed formal component_status definition.
 *  The Host uses this to declare the tool schema before a real Session instance
 *  exists. It does not construct a fake execution identity — only the
 *  definition shape. Each call returns a fresh copy so a caller mutating the
 *  returned array or definition cannot affect the port's own definitions. */
export function nativeComponentToolDefinitions() {
  return [copy(FORMAL_DEFINITION)];
}

/**
 * @param {object} opts
 * @param {object} opts.scope Trusted bound RunScope (validated via scopeKey).
 * @param {string} opts.sessionId Trusted bound session id.
 * @param {object} opts.status Host-fixed admission status snapshot.
 * @param {(request:object)=>boolean} opts.assertCurrent Host authority check (required).
 * @returns {{contract,definitions,execute(request):Promise<object>,close()}}
 */
export function createNativeComponentTools({ scope, sessionId, status, assertCurrent } = {}) {
  invariant(scope && typeof scope === 'object', 'component_status_scope_missing');
  // Validate all four scope domains via the core scopeKey (throws on missing/empty).
  scopeKey(scope);
  invariant(typeof sessionId === 'string' && sessionId.trim(), 'component_status_session_id_missing');
  invariant(typeof assertCurrent === 'function', 'component_status_assert_current_required');

  const boundScope = deepFreeze(copy(scope));
  const boundSessionId = String(sessionId);
  const frozenStatus = componentStatusSnapshot(status);
  const statusCanonical = canonical(frozenStatus);
  invariant(Buffer.byteLength(statusCanonical, 'utf-8') <= MAX_RESULT_BYTES, 'component_status_oversized');

  const frozenDefinition = deepFreeze(copy(FORMAL_DEFINITION));
  const definitions = Object.freeze([frozenDefinition]);
  const formalDefinitionCanonical = canonical(frozenDefinition);

  let closed = false;

  /** Strict synchronous authority + identity guard. Runs before AND after the
   *  assertCurrent call. Verifies: closed, original signal instance ===, signal
   *  not aborted, bound scope/session match, and the sealed request body has not
   *  drifted. assertCurrent must return a strict boolean; a thenable is a
   *  contract violation whose rejection is observed (never an
   *  unhandledRejection). A getter/throw is converted to a bounded error. */
  function guard(sealed, request) {
    if (closed) return { ok: false, code: 'component_status_closed' };
    if (request.signal !== sealed.originalSignal) return { ok: false, code: 'component_status_signal_drifted' };
    if (sealed.originalSignal.aborted) return { ok: false, code: 'component_status_canceled' };
    if (canonical(request.scope) !== sealed.scopeCanonical) return { ok: false, code: 'component_status_scope_drifted' };
    if (request.sessionId !== boundSessionId) return { ok: false, code: 'component_status_session_drifted' };
    let live;
    try { live = canonical(sealed.stripSignal(request)); }
    catch { return { ok: false, code: 'component_status_request_invalid' }; }
    if (live !== sealed.bodyCanonical) return { ok: false, code: 'component_status_body_drifted' };
    return { ok: true };
  }

  function callAssertCurrent(request) {
    let verdict;
    try { verdict = assertCurrent(request); }
    catch { return { ok: false, code: 'component_status_assert_current_invalid' }; }
    if (verdict && typeof verdict === 'object' && typeof verdict.then === 'function') {
      verdict.then(() => {}, () => {}); // observe the rejection
      return { ok: false, code: 'component_status_assert_current_invalid' };
    }
    if (typeof verdict !== 'boolean') return { ok: false, code: 'component_status_assert_current_invalid' };
    if (!verdict) return { ok: false, code: 'component_status_authority_lost' };
    return { ok: true };
  }

  async function execute(request) {
    if (!request || typeof request !== 'object') return errorResult('component_status_request_invalid');

    // Validate formal parameters before anything else.
    const rejection = toolInputRejection(frozenDefinition, request.call);
    if (rejection) return { status: 'error', content: rejection };

    // The incoming definition must be canonically identical to the fixed formal
    // definition — not merely self-consistent. A forged {name:'forged'} is
    // rejected here before any authority check.
    if (canonical(request.definition) !== formalDefinitionCanonical)
      return errorResult('component_status_definition_mismatch');

    // Require a real AbortSignal by instance identity.
    const signal = request.signal;
    if (!(signal instanceof AbortSignal)) return errorResult('component_status_signal_missing');

    // Validate the full Native identity fields are present and match the bound
    // scope/session. The model cannot call with a foreign principal.
    if (canonical(request.scope) !== canonical(boundScope)) return errorResult('component_status_scope_mismatch');
    if (request.sessionId !== boundSessionId) return errorResult('component_status_session_mismatch');

    // Seal the complete request body (excluding the non-JSON signal) and the
    // original signal instance so every guard can detect drift.
    const stripSignal = ({ signal: _s, ...rest }) => rest;
    let bodyCanonical;
    try { bodyCanonical = canonical(stripSignal(request)); }
    catch { return errorResult('component_status_request_invalid'); }
    const sealed = { originalSignal: signal, scopeCanonical: canonical(boundScope), bodyCanonical, stripSignal };

    // Guard before authority.
    let pre = guard(sealed, request);
    if (!pre.ok) return errorResult(pre.code);

    // Authority check.
    let auth = callAssertCurrent(request);
    if (!auth.ok) return errorResult(auth.code);

    // Guard after authority: closed, signal, body, scope must not have drifted.
    let post = guard(sealed, request);
    if (!post.ok) return errorResult(post.code);

    // Build a fresh copy of the frozen snapshot for this call.
    const payload = copy(frozenStatus);

    // Final guard: re-verify closed/cancel/body/signal one last time before
    // returning. A close or abort that lands between the post-guard and here
    // is caught.
    let final = guard(sealed, request);
    if (!final.ok) return errorResult(final.code);

    return { status: 'ok', content: payload };
  }

  function close() { closed = true; }

  return { contract: NATIVE_COMPONENT_TOOLS_CONTRACT, definitions, execute, close };
}
