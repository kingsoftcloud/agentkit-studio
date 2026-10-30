// Native Skills builtin tools — bounded formal definitions and ToolPort.
//
// Security contract: the internal definition map is deep-cloned from the
// public definitions; the public array returns independent copies. Every
// execute() validates request.definition against the internal formal via
// canonical comparison (before authorization and after every await). The
// full request object is re-read after each await — not destructured locals
// — so any drift in runId/turn/build/fence/signal/definition/call is detected.
// forAgent validates authority.scope/sessionId against the binding identity.
// An uncertain backend result (after side effects) returns Native status
// 'uncertain', never 'error' with executed:false.

import { canonical, copy, invariant, scopeKey, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { nativeSkillEventEvidence } from './skill-events.mjs';
import { realpath, lstat, stat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const SKILL_TOOL_CONTRACT = 'agentkit.native-skill-tools/v3';

function uncertainOutcome(content) {
  const result = { ...content, uncertain: true };
  delete result.executed;
  return { status: 'uncertain', content: result };
}

// --- skill name normalization (ksadk/skills/runtime/base.py) ------------------

export function normalizeSkillNames(skillNames) {
  if (skillNames == null) return [];
  const rawValues = Array.isArray(skillNames) ? skillNames.map(String) : [String(skillNames)];
  const normalized = [], seen = new Set();
  for (const raw of rawValues) {
    for (const part of String(raw).split(',')) {
      const name = part.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      normalized.push(name);
    }
  }
  return normalized;
}

// --- skill matching (ksadk/skills/runtime/registry.py) ------------------------

function tokenize(text) {
  return new Set(text.toLowerCase().split(/[^0-9a-zA-Z一-鿿]+/).filter(t => t.length >= 2));
}

function metadataScore(skill, normalizedPrompt, promptTokens) {
  if (skill.name && skill.name.toLowerCase().includes(normalizedPrompt.trim())) return [90, 'name'];
  if (skill.name && normalizedPrompt.includes(skill.name.toLowerCase())) return [90, 'name'];
  for (const alias of skill.aliases ?? []) {
    if (alias && normalizedPrompt.includes(alias.toLowerCase())) return [80, 'alias'];
  }
  for (const tag of skill.tags ?? []) {
    const tagKey = (tag || '').toLowerCase();
    if (tagKey && (normalizedPrompt.includes(tagKey) || promptTokens.has(tagKey))) return [65, 'tag'];
  }
  const text = [skill.description ?? '', ...(skill.examples ?? [])].join(' ').toLowerCase();
  const skillTokens = tokenize(text);
  const overlap = [...promptTokens].filter(t => skillTokens.has(t));
  if (overlap.length) return [Math.min(55, 20 + overlap.length * 10), 'metadata'];
  return [0, ''];
}

export function matchSkillRefs(skillRefs, prompt, { skillNames = null, limit = null } = {}) {
  const requestedNames = new Set(normalizeSkillNames(skillNames).map(n => n.toLowerCase()));
  const normalizedPrompt = (prompt || '').toLowerCase();
  const promptTokens = tokenize(normalizedPrompt);
  const matches = [], seen = new Set();
  for (const skill of skillRefs) {
    if (!skill.name) continue;
    const skillName = skill.name.toLowerCase();
    let score, reason;
    if (requestedNames.size) {
      if (!requestedNames.has(skillName)) continue;
      score = 100; reason = 'exact_name';
    } else {
      [score, reason] = metadataScore(skill, normalizedPrompt, promptTokens);
      if (score <= 0) continue;
    }
    const key = skill.cacheKey || skill.skillId || skill.name;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ skill, score, reason });
  }
  matches.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return limit != null ? matches.slice(0, Math.max(0, limit)) : matches;
}

// --- manifest helpers (ksadk/skills/tool_defs.py) -----------------------------

function singleLine(value, limit = 240) {
  const text = String(value || '').trim().split(/\s+/).join(' ');
  return text.slice(0, limit).replace(/\s+$/, '');
}

export function skillManifestItem(skill, spaceId) {
  const item = {
    name: String(skill.name || '').trim(),
    description: singleLine(skill.description),
    version: String(skill.version || '').trim(),
    space_id: String(spaceId || '').trim(),
  };
  if (skill.aliases?.length) item.aliases = singleLine(skill.aliases.join(', '));
  if (skill.tags?.length) item.tags = singleLine(skill.tags.join(', '));
  return item;
}

export function selectPublicSkillRefs(skillRefs, allowlist) {
  if (!allowlist?.length) return skillRefs.filter(skill => skill.name);
  const allowed = new Set(allowlist.map(n => n.toLowerCase()));
  return skillRefs.filter(skill => skill.name && allowed.has(skill.name.toLowerCase()));
}

// --- formal tool definitions -------------------------------------------------

const text = (desc, max = 1024) => ({ type: 'string', description: desc, maxLength: max });
const str = desc => ({ type: 'string', description: desc });

const TOOL_DEFINITIONS = [
  { name: 'list_skill_spaces', description: 'List visible Skill Spaces with id/name/description.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 15000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
  { name: 'list_skills', description: 'List skills discoverable from configured Skill Spaces.',
    parameters: { type: 'object', properties: { space_id: str('Limit to one bound Skill Space.') }, required: [], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 30000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
  { name: 'load_skill', description: "Download and load a skill's SKILL.md instructions.",
    parameters: { type: 'object', properties: { skill_name: text('The skill name to load.'), space_id: str('Limit to one bound Skill Space.') }, required: ['skill_name'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 30000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
  { name: 'preview_skill', description: 'Return manifest-level info for a skill without downloading.',
    parameters: { type: 'object', properties: { skill_name: text('The skill name to preview.'), space_id: str('Limit to one bound Skill Space.') }, required: ['skill_name'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 15000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
  { name: 'search_skills', description: 'Search skills by name, aliases, tags, description.',
    parameters: { type: 'object', properties: { query: text('The search query.'), max_results: { type: 'integer', description: 'Max results (default 10).', minimum: 1, maximum: 50 }, space_id: str('Limit to one bound Skill Space.') }, required: ['query'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 15000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
  { name: 'execute_skills', description: 'Execute a workflow through the configured Skill Runtime. Has side effects.',
    parameters: { type: 'object', properties: { workflow_prompt: text('The workflow prompt.', 8192), skill_names: { type: 'array', items: { type: 'string' }, description: 'Skill names to execute with.' }, approval: { type: 'object', description: 'Optional approval metadata.', additionalProperties: true } }, required: ['workflow_prompt'], additionalProperties: false },
    readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 900000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' },
];

// --- identity validation -----------------------------------------------------

function validateRequestIdentity(request) {
  const { scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId, operationKey, executionFence, signal } = request;
  if (!(scope && typeof scope === 'object' && !Array.isArray(scope))) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'scope is required' };
  try { scopeKey(scope); } catch { return { code: 'NATIVE_SKILL_IDENTITY_INVALID', message: 'scope must have four non-empty domain strings' }; }
  if (typeof runId !== 'string' || !runId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'runId is required' };
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'sessionId is required' };
  if (typeof turnId !== 'string' || !turnId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'turnId is required' };
  if (typeof buildId !== 'string' || !buildId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'buildId is required' };
  if (parentRunId !== null && (typeof parentRunId !== 'string' || !parentRunId.trim())) return { code: 'NATIVE_SKILL_IDENTITY_INVALID', message: 'parentRunId must be null or non-empty' };
  if (typeof taskChainId !== 'string' || !taskChainId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'taskChainId is required' };
  if (typeof operationKey !== 'string' || !operationKey.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING', message: 'operationKey is required' };
  if (!Number.isSafeInteger(executionFence) || executionFence <= 0) return { code: 'NATIVE_SKILL_IDENTITY_INVALID', message: 'executionFence must be a positive integer' };
  if (!(signal instanceof AbortSignal)) return { code: 'NATIVE_SKILL_IDENTITY_INVALID', message: 'signal must be an AbortSignal' };
  return null;
}

/** Snapshot the full request identity + call + definition into a sealed
 *  string for drift comparison. Canonicalizes ALL enumerable own keys of the
 *  request body excluding `signal` (which is not JSON-cloneable). This
 *  catches drift in any field — budget, interaction, tokens, tools, or
 *  future fields — without manually enumerating a subset. */
function snapshotRequest(request, internalDefinition) {
  const body = Object.create(null);
  for (const key of Object.keys(request)) {
    if (key === 'signal') continue;
    const value = request[key];
    if (value !== undefined) body[key] = copy(value);
  }
  return canonical({ body, internalDefinition });
}

/** Race an async operation against an AbortSignal. Removes the abort
 *  listener in finally to prevent leaks. A late rejection from the
 *  operation is observed via the returned promise. */
function raceAbort(signal, operation) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED' }));
  let listener = null;
  const stopped = new Promise((_, reject) => {
    // Let a result already settled by the dispatching callback retain known
    // remote identity. A callback that never settles still loses this race.
    listener = () => queueMicrotask(() => reject(Object.assign(new Error('REQUEST_CANCELLED'), { code: 'REQUEST_CANCELLED' })));
    signal.addEventListener('abort', listener, { once: true });
  });
  let pending;
  try { pending = Promise.resolve(operation()); } catch (error) { pending = Promise.reject(error); }
  return Promise.race([pending, stopped]).finally(() => {
    if (listener) signal.removeEventListener('abort', listener);
  });
}

function frozenCopy(value) {
  const result = copy(value);
  const freeze = item => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  };
  return freeze(result);
}

// --- ToolPort factory --------------------------------------------------------

export function createNativeSkillTools({
  serviceClient, loadSkillFn, executeWorkflow, locateWorkflow, authorize,
  skillSpaceIds = [], publicSpaceIds = [], publicAllowlist = [], boundSkillNames = [], manifestLimit = 30,
  binding = {},
} = {}) {
  invariant(typeof authorize === 'function', 'native_skill_authorize_required');

  const sealedSpaceIds = copy(skillSpaceIds);
  const sealedPublicSpaceIds = copy(publicSpaceIds);
  const sealedPublicAllowlist = copy(publicAllowlist);
  const sealedBoundSkillNames = new Set(copy(boundSkillNames).map(n => n.toLowerCase()));
  const allSpaceIds = [...sealedSpaceIds, ...sealedPublicSpaceIds];
  const readTransport = createSkillReadTransport({ serviceClient, loadSkillFn, skillSpaceIds: sealedSpaceIds,
    publicSpaceIds: sealedPublicSpaceIds, publicAllowlist: sealedPublicAllowlist, manifestLimit });

  // Fix #1, #4: Internal definition map is an independent deep copy. The
  // public definitions array returns separate copies so mutating the public
  // array or a returned definition object does not affect the internal map.
  const internalDefinitions = copy(TOOL_DEFINITIONS);
  const internalDefinitionMap = new Map(internalDefinitions.map(d => [d.name, copy(d)]));
  const publicDefinitions = copy(TOOL_DEFINITIONS);

  const sealedBinding = copy(binding);

  // --- space validation (fix #5) -------------------------------------------

  function validateSkillNames(names) {
    if (!names.length || !sealedBoundSkillNames.size) return null;
    const unbound = names.filter(n => !sealedBoundSkillNames.has(n.toLowerCase()));
    return unbound.length ? `skill names not bound: ${unbound.join(', ')}` : null;
  }

  // --- guard closure (fix #3) ------------------------------------------------
  // A guard function that re-reads the original request object and compares
  // against the sealed snapshot. Used before every service/loader/backend call.

  function makeGuard(request, internalDef, assertCurrent) {
    const sealed = snapshotRequest(request, internalDef);
    const originalSignal = request.signal;
    return {
      check() {
        if (originalSignal.aborted) return { code: 'REQUEST_CANCELLED', message: 'Cancelled during execution' };
        try {
          if (request.signal !== originalSignal || snapshotRequest(request, internalDef) !== sealed)
            return { code: 'NATIVE_SKILL_DRIFT', message: 'Request identity, call, definition or signal drifted' };
          const verdict = assertCurrent(request);
          if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
          if (verdict !== true)
            return { code: 'NATIVE_SKILL_AUTHORITY_EXPIRED', message: 'The original tool intent is no longer current' };
          if (originalSignal.aborted) return { code: 'REQUEST_CANCELLED', message: 'Cancelled during authorization check' };
          if (request.signal !== originalSignal || snapshotRequest(request, internalDef) !== sealed)
            return { code: 'NATIVE_SKILL_DRIFT', message: 'Request changed inside authorization check' };
        } catch {
          return { code: 'NATIVE_SKILL_AUTHORITY_EXPIRED', message: 'The original tool intent cannot be verified' };
        }
        return null;
      },
      signal: originalSignal,
      assertCurrent() {
        const failure = this.check();
        if (failure) throw new SkillToolError(failure.code, failure.message);
        return true;
      },
    };
  }

  // --- execute_skills (fix #4: effectStarted, uncertain, approval) ------------

  async function executeSkills({ workflow_prompt: workflowPrompt, skill_names: skillNames, approval } = {}, ctx) {
    const guard = ctx.guard;
    const prompt = String(workflowPrompt || '').trim();
    if (!prompt) return { ok: false, error_message: 'workflow_prompt is required' };
    if (typeof executeWorkflow !== 'function') {
      return { ok: false, error_type: 'skill_runtime_unavailable', error_message: 'Skill Runtime backend is not configured on this Host.' };
    }
    const names = normalizeSkillNames(skillNames);
    const nameError = validateSkillNames(names);
    if (nameError) return { ok: false, error_type: 'SKILL_NAME_NOT_BOUND', error_message: nameError };
    const g = guard.check(); if (g) return { ok: false, error_type: g.code, error_message: g.message };

    // Once the workflow is dispatched, side effects may have occurred.
    // Any subsequent abort/throw/guard-failure returns uncertain, not error.
    let effectStarted = false;
    let result;
    let runtimeLocator = {};
    try {
      const g2 = guard.check(); if (g2) return { ok: false, error_type: g2.code, error_message: g2.message };
      // effectStarted is set only immediately before the real backend call,
      // not before validation or guard checks.
      effectStarted = true;
      ctx.effectStarted = true;
      const workflowRequest = {
        workflowPrompt: prompt, skillNames: names, skillSpaceIds: allSpaceIds, env: {}, timeout: 900,
        signal: guard.signal, scope: ctx.scope, runId: ctx.runId, sessionId: ctx.sessionId,
        turnId: ctx.turnId, buildId: ctx.buildId, parentRunId: ctx.parentRunId,
        taskChainId: ctx.taskChainId, operationKey: ctx.operationKey,
        executionFence: ctx.executionFence, callId: ctx.callId, call: ctx.call,
        lockedDefinition: copy(ctx.lockedDefinition), ...(approval === undefined ? {} : { approval }), assertCurrent: () => guard.assertCurrent(),
      };
      if (typeof locateWorkflow === 'function') {
        const locator = locateWorkflow(workflowRequest);
        if (locator && typeof locator.then === 'function') Promise.resolve(locator).catch(() => {});
        invariant(locator && typeof locator.then !== 'function' && typeof locator.runtime_id === 'string' && locator.runtime_id.length <= 4096
          && typeof locator.task_id === 'string' && /^[a-f0-9]{64}$/u.test(locator.task_id), 'SKILL_RUNTIME_LOCATOR_INVALID');
        runtimeLocator = { runtime_id: locator.runtime_id, task_id: locator.task_id };
        guard.assertCurrent();
      }
      result = await raceAbort(guard.signal, () => executeWorkflow(workflowRequest));
      if (runtimeLocator.runtime_id && result && typeof result === 'object') {
        invariant((result.runtime_id ?? runtimeLocator.runtime_id) === runtimeLocator.runtime_id
          && (result.task_id ?? runtimeLocator.task_id) === runtimeLocator.task_id, 'SKILL_RUNTIME_LOCATOR_CHANGED');
        result = { ...result, ...runtimeLocator };
      }
    } catch (error) {
      // After effectStarted, any throw is uncertain — the workflow may have
      // had side effects before the throw. This includes approval_required:
      // the workflow may have started side effects before requesting approval,
      // so we cannot prove no side effects occurred.
      if (effectStarted) {
        return { ...runtimeLocator, ok: false, status: 'uncertain', uncertain: true,
          error_type: error.code === 'approval_required' || error.approvalRequired ? 'invalid_skill_approval' : 'skill_runtime_uncertain',
          error_message: error.message || 'Skill runtime outcome is unknown; the workflow may have side effects.' };
      }
      return { ok: false, error_type: error.code || error.name || 'Error', error_message: error.message || String(error) };
    }

    // Post-workflow guard: if the request drifted after the workflow completed,
    // the result is uncertain (side effects may have happened).
    const g3 = guard.check();
    if (g3) return { ...runtimeLocator, ok: false, status: 'uncertain', error_type: g3.code, error_message: g3.message, uncertain: true,
      ...nativeSkillEventEvidence(result?.skill_events),
      runtime_id: typeof result?.runtime_id === 'string' ? result.runtime_id : runtimeLocator.runtime_id ?? '', exit_code: result?.exit_code ?? null };

    // Post-workflow abort: uncertain, not error+executed:false.
    if (guard.signal.aborted) {
      return { ok: false, status: 'uncertain', error_type: 'skill_runtime_uncertain',
        ...nativeSkillEventEvidence(result?.skill_events),
        error_message: 'Skill workflow completed but the request was cancelled; the outcome may be unknown.',
        uncertain: true, runtime_id: result?.runtime_id || '', exit_code: result?.exit_code ?? null };
    }

    if (!result || typeof result !== 'object') {
      return { ...runtimeLocator, ok: false, status: 'uncertain', uncertain: true, error_type: 'invalid_skill_runtime_result',
        error_message: `skill runtime returned ${typeof result}, expected object` };
    }

    // Approval-required result from backend: cannot prove no side effects —
    // the backend may have started side effects before requesting approval.
    // Return uncertain, not approval_required.
    if (result.approval_required || result.status === 'approval_required') {
      return { ...runtimeLocator, ok: false, status: 'uncertain', uncertain: true, error_type: 'invalid_skill_approval',
        interactionId: typeof result.interactionId === 'string' ? result.interactionId : '',
        error_message: result.error_message || 'Skill runtime requested approval after potential side effects.' };
    }

    // Uncertain result.
    if (result.uncertain === true || result.status === 'uncertain' ||
      result.executed === false && result.ok === true ||
      (!Number.isSafeInteger(result.exit_code) && result.executed !== false)) {
      return { ...runtimeLocator, ok: false, status: 'uncertain', error_type: 'skill_runtime_uncertain',
        error_message: result.error_message || 'Skill runtime outcome is unknown.',
        uncertain: true, runtime_id: result.runtime_id || '', exit_code: result.exit_code ?? null,
        ...nativeSkillEventEvidence(result.skill_events),
        ...(Array.isArray(result.command_ids) && result.command_ids.length <= 1000
          && result.command_ids.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id))
          ? { command_ids: copy(result.command_ids) } : {}) };
    }

    return { ...result, executed: result.executed !== false,
      ok: result.ok ?? (result.exit_code === 0 && !result.error_type && !result.timed_out) };
  }

  // --- dispatch table ---------------------------------------------------------

  const handlers = {
    ...Object.fromEntries(nativeSkillReadToolDefinitions().map(definition => [definition.name, (_args, ctx) =>
      readTransport.execute({ call: ctx.call, signal: ctx.guard.signal, assertCurrent: () => ctx.guard.assertCurrent() })])),
    execute_skills: executeSkills,
  };

  return {
    definitions: publicDefinitions,
    forAgent(agent, authority = {}) {
      // Fix #2: validate authority.scope and authority.sessionId against the
      // binding. The Host injects the trusted scope/session; the tool request
      // must match. Do not accept a request with no authority.
      invariant(agent?.session?.id && typeof agent.session.id === 'string', 'native_skill_agent_session_required');
      invariant(authority?.scope && typeof authority.scope === 'object', 'native_skill_authority_scope_required');
      try { scopeKey(authority.scope); } catch { throw Object.assign(new Error('native_skill_authority_scope_invalid'), { code: 'native_skill_authority_scope_invalid' }); }
      const sealedAuthorityScope = scopeKey(authority.scope);
      invariant(typeof authority.sessionId === 'string' && authority.sessionId === agent.session.id,
        'native_skill_authority_session_mismatch');
      invariant(typeof authority.assertCurrent === 'function', 'native_skill_authority_guard_required');
      const assertCurrent = authority.assertCurrent;
      const sealedAuthoritySessionId = authority.sessionId;
      invariant(!sealedBinding.agentId || sealedBinding.agentId === authority.scope.agentId, 'native_skill_binding_agent_mismatch');
      invariant(!sealedBinding.agentRevision || sealedBinding.agentRevision === authority.agentRevision, 'native_skill_binding_revision_mismatch');

      return {
        tools: {
          async execute(request = {}) {
            const { call, signal, scope, runId, sessionId, turnId, buildId,
              parentRunId, taskChainId, operationKey, executionFence, definition } = request;

            // --- validate call ---
            if (!call?.name) return { status: 'error', content: { code: 'NATIVE_SKILL_CALL_MISSING', executed: false, message: 'call is missing or has no name' } };
            const internalDef = internalDefinitionMap.get(call.name);
            if (!internalDef) return { status: 'error', content: { code: 'native_skill_tool_unbound', executed: false, message: `tool "${call.name}" is not bound` } };
            if (typeof call.callId !== 'string' || !call.callId.trim()) return { status: 'error', content: { code: 'NATIVE_SKILL_CALL_ID_MISSING', executed: false, message: 'callId is required' } };

            // Fix #1: validate request.definition against the internal formal.
            // If definition is provided, it must canonically match the internal
            // formal. A forged or mutated definition is rejected.
            {
              if (!definition || canonical(definition) !== canonical(internalDef)) {
                return { status: 'error', content: { code: 'NATIVE_SKILL_DEFINITION_FORGED', executed: false, message: 'request.definition does not match the locked formal definition' } };
              }
            }

            // --- validate full request identity ---
            const identityError = validateRequestIdentity(request);
            if (identityError) return { status: 'error', content: { ...identityError, executed: false } };

            // Fix #2: validate request scope/session against the authority binding.
            try {
              if (scopeKey(scope) !== sealedAuthorityScope) {
                return { status: 'error', content: { code: 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH', executed: false, message: 'request scope does not match the bound authority scope' } };
              }
            } catch { return { status: 'error', content: { code: 'NATIVE_SKILL_IDENTITY_INVALID', executed: false, message: 'request scope is invalid' } }; }
            if (sessionId !== sealedAuthoritySessionId) {
              return { status: 'error', content: { code: 'NATIVE_SKILL_AUTHORITY_SESSION_MISMATCH', executed: false, message: 'request sessionId does not match the bound authority session' } };
            }
            if (sealedBinding.buildId && buildId !== sealedBinding.buildId)
              return { status: 'error', content: { code: 'NATIVE_SKILL_BINDING_BUILD_MISMATCH', executed: false } };

            // --- validate argument schema via toolInputRejection ---
            const rejection = toolInputRejection(internalDef, call);
            if (rejection) return { status: 'error', content: rejection };

            // --- snapshot before authorization await (fix #3) ---
            const guard = makeGuard(request, internalDef, assertCurrent);
            if (guard.signal.aborted) return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: 'Cancelled before authorization' } };
            const initial = guard.check();
            if (initial) return { status: 'error', content: { ...initial, executed: false } };

            // --- explicit authorization callback (raced against signal) ---
            let decision;
            try {
              decision = await raceAbort(guard.signal, () => authorize(call.name, { call, signal: guard.signal, scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId, operationKey, executionFence, definition: internalDef }));
            } catch (error) {
              if (guard.signal.aborted) return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: 'Cancelled during authorization' } };
              return { status: 'error', content: { code: error.code || 'NATIVE_SKILL_ERROR', executed: false, message: error.message || String(error) } };
            }
            const g = guard.check();
            if (g) return { status: 'error', content: { code: g.code, executed: false, message: g.message } };
            if (decision !== 'allow') {
              if (decision?.status === 'approval_required' && typeof decision.interactionId === 'string' && decision.interactionId.trim())
                return { status: 'approval_required', interactionId: decision.interactionId, content: { executed: false } };
              const code = decision?.code || 'STUDIO_NATIVE_SKILL_PERMISSION_DENIED';
              const message = decision?.message || 'Skill tool not authorized';
              return { status: 'error', content: { code, executed: false, message } };
            }

            // --- after-await drift guard (fix #3: re-read request) ---
            // --- execute with full context + guard closure ---
            const ctx = { signal: guard.signal, scope: copy(request.scope), runId: request.runId, sessionId: request.sessionId,
                turnId: request.turnId, buildId: request.buildId, parentRunId: request.parentRunId,
                taskChainId: request.taskChainId, operationKey: request.operationKey,
                executionFence: request.executionFence, callId: request.call.callId,
                call: copy(request.call), lockedDefinition: copy(internalDef), guard, effectStarted: false };
            // Deep-copy and freeze the locator BEFORE any handler callback can
            // mutate ctx.scope/call/etc. The backend receives ctx which may be
            // mutated, but the locator retains the original sealed values.
            const locator = frozenCopy({ scope: ctx.scope, runId: ctx.runId, sessionId: ctx.sessionId,
                turnId: ctx.turnId, buildId: ctx.buildId, parentRunId: ctx.parentRunId,
                taskChainId: ctx.taskChainId, operationKey: ctx.operationKey,
                executionFence: ctx.executionFence, callId: ctx.callId, call: ctx.call });
            try {
              guard.signal.throwIfAborted();
              // executeSkills owns the backend race and retains an already
              // known runtime locator on cancellation. Racing it a second
              // time here could discard that evidence before it returns.
              const invoke = () => handlers[call.name](ctx.call.arguments ?? {}, ctx);
              const result = await (call.name === 'execute_skills' ? invoke() : raceAbort(guard.signal, invoke));
              const late = guard.check();
              if (late) return ctx.effectStarted
                ? uncertainOutcome({ ...result, ...locator, error_type: late.code })
                : { status: 'error', content: { code: late.code, executed: false } };
              // Uncertain result.
              if (result?.status === 'uncertain' || result?.uncertain === true) {
                return uncertainOutcome({ ...result, ...locator });
              }
              // Approval-required: preserve.
              if (result?.status === 'approval_required') {
                return { status: 'approval_required', interactionId: result.interactionId, content: result };
              }
              // content.ok === false → status 'error'.
              if (result && typeof result === 'object' && result.ok === false) {
                return { status: 'error', content: { ...result, executed: result.executed ?? ctx.effectStarted } };
              }
              return { status: 'ok', content: result };
            } catch (error) {
              if (ctx.effectStarted) return { status: 'uncertain', content: { ...locator,
                uncertain: true, error_type: 'skill_runtime_uncertain', error_message: error.message || String(error) } };
              if (guard.signal.aborted) {
                // Fix #4: if effectStarted was set by executeSkills, the abort
                // after side effects is uncertain. For read-only tools, it's
                // a clean cancel. We can't know here, but the handler already
                // returned uncertain if needed. A throw reaching here from a
                // read-only tool after abort is a clean cancel.
                return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: 'Cancelled during execution' } };
              }
              return { status: 'error', content: { code: error.code || 'NATIVE_SKILL_ERROR', executed: false, message: error.message || String(error) } };
            }
          },
        },
      };
    },
  };
}

// --- bounded script scanning -------------------------------------------------

const MAX_SCRIPT_FILES = 20;
const MAX_SCRIPT_BYTES = 64 * 1024;

async function scanScripts(rootDir) {
  if (!rootDir || typeof rootDir !== 'string') return { hasScripts: false, files: [] };
  try {
    const resolvedRoot = await realpath(rootDir);
    const scriptsDir = join(resolvedRoot, 'scripts');
    const linfo = await lstat(scriptsDir).catch(() => null);
    if (!linfo?.isDirectory() || linfo.isSymbolicLink()) return { hasScripts: false, files: [] };
    const files = [];
    await scanDir(scriptsDir, resolvedRoot, files);
    return { hasScripts: files.length > 0, files: files.slice(0, MAX_SCRIPT_FILES) };
  } catch { return { hasScripts: false, files: [] }; }
}

async function scanDir(dir, root, files, depth = 0) {
  if (depth > 3 || files.length >= MAX_SCRIPT_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= MAX_SCRIPT_FILES) break;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await scanDir(full, root, files, depth + 1); continue; }
    if (!entry.isFile()) continue;
    const info = await stat(full).catch(() => null);
    if (!info || info.size > MAX_SCRIPT_BYTES) continue;
    files.push(relative(root, full).split(sep).join('/'));
  }
}

export class SkillToolError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillToolError'; this.code = code; }
}

/** Formal schemas shared by the Native and DSH read-only adapters. */
export function nativeSkillReadToolDefinitions() { return copy(TOOL_DEFINITIONS.filter(definition => definition.readOnly)); }

/** Neutral Skill discovery/loading transport. The caller supplies its real
 * authority; this layer neither creates an execution identity nor runs scripts.
 * Download/cache publication is content addressed and guarded by the loader. */
export function createSkillReadTransport({ serviceClient, loadSkillFn, skillSpaceIds = [], publicSpaceIds = [],
  publicAllowlist = [], manifestLimit = 30 } = {}) {
  invariant(Number.isSafeInteger(manifestLimit) && manifestLimit > 0 && manifestLimit <= 4096, 'skill_read_manifest_limit_invalid');
  const sealedSpaceIds = copy(skillSpaceIds), sealedPublicSpaceIds = copy(publicSpaceIds), sealedPublicAllowlist = copy(publicAllowlist);
  const allSpaceIds = [...sealedSpaceIds, ...sealedPublicSpaceIds];
  const userSpaceIdSet = new Set(sealedSpaceIds), publicSpaceIdSet = new Set(sealedPublicSpaceIds);
  const formal = new Map(nativeSkillReadToolDefinitions().map(definition => [definition.name, definition]));
  function resolveSpaceId(spaceId) {
    if (spaceId == null) return { type: 'all' };
    const key = String(spaceId).trim();
    if (!key) return { error: 'space_id is empty' };
    if (key === 'public') { if (!publicSpaceIdSet.size) return { error: 'public space is not configured' }; return { type: 'public' }; }
    if (publicSpaceIdSet.has(key)) return { type: 'public', explicitId: key };
    if (userSpaceIdSet.has(key)) return { type: 'user', id: key };
    return { error: `space_id "${key}" is not a bound Skill Space` };
  }

  // --- space iteration -------------------------------------------------------

  async function iterRemoteSkills(spaceResolution, guard) {
    if (!serviceClient) throw new SkillToolError('SKILL_SERVICE_UNAVAILABLE', 'Skill Service adapter is not configured');
    if (spaceResolution.error) throw new SkillToolError('SKILL_SPACE_NOT_BOUND', spaceResolution.error);
    const pairs = [];
    const spaces = spaceResolution.type === 'all'
      ? [...sealedSpaceIds.map(id => ({ type: 'user', id })), ...(publicSpaceIdSet.size ? [{ type: 'public' }] : [])]
      : [spaceResolution];
    for (const space of spaces) {
      guard.assertCurrent();
      if (space.type === 'public') {
        const listing = await serviceClient.listAvailablePremadeSkills({ signal: guard.signal, assertCurrent: () => guard.assertCurrent() });
        guard.assertCurrent();
        if (listing.truncated) throw new SkillToolError('SKILL_LISTING_INCOMPLETE', 'Public Skill listing is incomplete');
        const active = selectPublicSkillRefs(listing.activeSkills ?? [], sealedPublicAllowlist);
        const resolvedSpaceId = listing.spaceId || 'public';
        if (!publicSpaceIdSet.has(resolvedSpaceId) || space.explicitId && space.explicitId !== resolvedSpaceId)
          throw new SkillToolError('SKILL_SPACE_NOT_BOUND', 'Public directory does not match the bound and selected Skill Space');
        for (const skill of active) pairs.push({ spaceId: resolvedSpaceId, skill });
      } else {
        const listing = await serviceClient.listSkillsBySpaceId(space.id, { signal: guard.signal, assertCurrent: () => guard.assertCurrent() });
        guard.assertCurrent();
        if (listing.truncated) throw new SkillToolError('SKILL_LISTING_INCOMPLETE', 'Skill Space listing is incomplete');
        for (const skill of listing.activeSkills ?? []) pairs.push({ spaceId: space.id, skill });
      }
    }
    return pairs;
  }

  // --- list_skill_spaces -----------------------------------------------------

  async function listSkillSpaces(_args, { guard }) {
    const configured = new Set(allSpaceIds);
    let spaces = [];
    if (serviceClient?.listSkillSpaces) {
      try {
        guard.assertCurrent();
        spaces = parseSkillSpaces(await serviceClient.listSkillSpaces({ signal: guard.signal, assertCurrent: () => guard.assertCurrent() }));
      } catch (error) { guard.assertCurrent(); /* configured spaces remain available during a service outage */ }
    }
    guard.assertCurrent();
    for (const space of spaces) space.configured = configured.has(space.space_id);
    if (!spaces.length) spaces = [...configured].map(sid => ({ space_id: sid, space_name: '', description: '', configured: true }));
    return { ok: true, configured_space_ids: allSpaceIds, spaces };
  }

  function parseSkillSpaces(payload) {
    const data = payload?.data || payload?.Data || {};
    const raw = data.SkillSpaces || data.skill_spaces || data.Spaces || data.spaces || data.Items || data.items || [];
    return raw.filter(item => item && typeof item === 'object').map(item => ({
      space_id: String(item.SkillSpaceId || item.skill_space_id || item.SpaceId || item.space_id || ''),
      space_name: String(item.SkillSpaceName || item.skill_space_name || item.SpaceName || item.space_name || ''),
      description: String(item.Description || item.description || ''),
    }));
  }

  // --- list_skills ------------------------------------------------------------

  async function listSkills({ space_id: spaceId } = {}, ctx) {
    const guard = ctx.guard;
    const res = resolveSpaceId(spaceId);
    const spaceIds = spaceId ? [spaceId] : allSpaceIds;
    const g = guard.check(); if (g) return { ok: false, error_type: g.code, error_message: g.message };
    try {
      const pairs = await iterRemoteSkills(res, guard);
      const g2 = guard.check(); if (g2) return { ok: false, error_type: g2.code, error_message: g2.message };
      const seen = new Set(), skills = [];
      for (const { spaceId: sid, skill } of pairs) {
        if (!skill.name) continue;
        const key = skill.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        skills.push(skillManifestItem(skill, sid));
        if (skills.length >= manifestLimit) break;
      }
      return { ok: true, skills, truncated: pairs.length > skills.length, skill_space_ids: spaceIds, space_id: spaceId ?? null };
    } catch (error) {
      return { ok: false, error_type: error.code || error.name || 'Error', error_message: error.message || String(error), skill_space_ids: spaceIds, space_id: spaceId ?? null };
    }
  }

  // --- load_skill / preview_skill --------------------------------------------

  async function findSkillByName(skillName, spaceId, guard) {
    const target = String(skillName || '').trim().toLowerCase();
    if (!target) return null;
    const pairs = await iterRemoteSkills(resolveSpaceId(spaceId), guard);
    const g = guard.check(); if (g) throw new SkillToolError(g.code, g.message);
    const available = [];
    for (const { spaceId: sid, skill } of pairs) {
      if (!skill.name) continue;
      available.push(skill.name);
      if (skill.name.trim().toLowerCase() === target) return { spaceId: sid, skill, available };
    }
    return { available };
  }

  async function loadSkill({ skill_name: skillName, space_id: spaceId } = {}, ctx) {
    const guard = ctx.guard;
    const target = String(skillName || '').trim().toLowerCase();
    if (!target) return { ok: false, error_message: 'skill_name is required' };
    const g = guard.check(); if (g) return { ok: false, error_type: g.code, error_message: g.message };
    try {
      const found = await findSkillByName(skillName, spaceId, guard);
      const g2 = guard.check(); if (g2) return { ok: false, error_type: g2.code, error_message: g2.message };
      if (!found?.skill) return { ok: false, error_message: `Skill not found: ${skillName}`, space_id: spaceId ?? null, available_skills: found?.available ?? [] };
      const { spaceId: sid, skill } = found;
      if (typeof loadSkillFn !== 'function') {
        return { ok: false, error_type: 'SKILL_LOADER_UNAVAILABLE',
          error_message: 'No skill loader is configured on this Host.',
          space_id: sid, skill_id: skill.skillId || '', version_id: skill.versionId || '' };
      }
      const g3 = guard.check(); if (g3) return { ok: false, error_type: g3.code, error_message: g3.message };
      const loaded = await loadSkillFn({ skillId: skill.skillId, versionId: skill.versionId, name: skill.name, spaceId: sid,
        contentHash: skill.contentHash || '', signal: guard.signal, assertCurrent: () => guard.assertCurrent() });
      const g4 = guard.check(); if (g4) return { ok: false, error_type: g4.code, error_message: g4.message };
      if (!loaded || !loaded.content) {
        return { ok: false, error_type: 'SKILL_MANIFEST_MISSING',
          error_message: `Skill "${skillName}" was found but its SKILL.md could not be loaded.`,
          space_id: sid, skill_id: skill.skillId || '', version_id: skill.versionId || '' };
      }
      if (loaded.skillId !== skill.skillId || loaded.versionId !== skill.versionId || loaded.spaceId !== sid ||
        skill.contentHash && loaded.contentHash !== skill.contentHash)
        return { ok: false, error_type: 'SKILL_LOADER_IDENTITY_MISMATCH',
          error_message: 'The loader did not attest the selected Skill identity, version and content hash.' };
      const rootDir = loaded.rootDir || '';
      const { hasScripts, files } = await scanScripts(rootDir);
      const g5 = guard.check(); if (g5) return { ok: false, error_type: g5.code, error_message: g5.message };
      return { ok: true, execution_context: 'outer_agent', name: skill.name, description: skill.description || '',
        space_id: sid, skill_id: skill.skillId || '', version_id: skill.versionId || '', version: skill.version || '',
        cache_hit: !!loaded.cacheHit, root_dir: rootDir, has_scripts_dir: hasScripts, script_files: files,
        instructions: loaded.content, usage: "Read these instructions and complete the user's task in the outer agent unless the skill explicitly requires isolated execution." };
    } catch (error) {
      return { ok: false, error_type: error.code || error.name || 'Error', error_message: error.message || String(error) };
    }
  }

  async function previewSkill({ skill_name: skillName, space_id: spaceId } = {}, ctx) {
    const guard = ctx.guard;
    const target = String(skillName || '').trim().toLowerCase();
    if (!target) return { ok: false, error_message: 'skill_name is required' };
    const g = guard.check(); if (g) return { ok: false, error_type: g.code, error_message: g.message };
    try {
      const found = await findSkillByName(skillName, spaceId, guard);
      const g2 = guard.check(); if (g2) return { ok: false, error_type: g2.code, error_message: g2.message };
      if (!found?.skill) return { ok: false, error_message: `Skill not found: ${skillName}`, space_id: spaceId ?? null, available_skills: found?.available ?? [] };
      const { spaceId: sid, skill } = found;
      return { ok: true, execution_context: 'manifest_preview', name: skill.name, description: skill.description || '',
        space_id: sid, skill_id: skill.skillId || '', version_id: skill.versionId || '', version: skill.version || '',
        cache_hit: false, has_scripts_dir: false, script_files: [], instructions: skill.description || '',
        usage: 'Manifest-level preview. For full SKILL.md instructions, use load_skill.' };
    } catch (error) {
      return { ok: false, error_type: error.code || error.name || 'Error', error_message: error.message || String(error) };
    }
  }

  // --- search_skills ----------------------------------------------------------

  async function searchSkills({ query, max_results: maxResults = 10, space_id: spaceId } = {}, ctx) {
    const guard = ctx.guard;
    const queryText = String(query || '').trim();
    if (!queryText) return { ok: false, error_message: 'query is required' };
    const g = guard.check(); if (g) return { ok: false, error_type: g.code, error_message: g.message };
    try {
      const pairs = await iterRemoteSkills(resolveSpaceId(spaceId), guard);
      const g2 = guard.check(); if (g2) return { ok: false, error_type: g2.code, error_message: g2.message };
      const spaceOf = {};
      for (const { spaceId: sid, skill } of pairs) {
        const key = skill.cacheKey || skill.skillId || skill.name;
        if (key && !(key in spaceOf)) spaceOf[key] = sid;
      }
      const refs = pairs.map(({ skill }) => skill);
      const matches = matchSkillRefs(refs, queryText, { limit: maxResults });
      const results = matches.map(match => ({
        name: match.skill.name, description: match.skill.description, version: match.skill.version,
        score: match.score, reason: match.reason, aliases: match.skill.aliases ?? [], tags: match.skill.tags ?? [],
        space_id: spaceOf[match.skill.cacheKey || match.skill.skillId || match.skill.name] || '',
      }));
      return { ok: true, query: queryText, space_id: spaceId ?? null, results };
    } catch (error) {
      return { ok: false, error_type: error.code || error.name || 'Error', error_message: error.message || String(error) };
    }
  }


  const handlers = { list_skill_spaces: listSkillSpaces, list_skills: listSkills, load_skill: loadSkill,
    preview_skill: previewSkill, search_skills: searchSkills };
  return { async execute(request) {
    const definition = formal.get(request?.call?.name);
    if (!definition) return { ok: false, error_type: 'skill_read_tool_unbound', executed: false };
    const rejection = toolInputRejection(definition, request.call);
    if (rejection) return { ...rejection, ok: false, executed: false };
    const signal = request.signal, assertCurrent = request.assertCurrent;
    invariant(signal instanceof AbortSignal && typeof assertCurrent === 'function', 'skill_read_authority_required');
    const body = ({ signal: _, assertCurrent: __, ...json }) => canonical(json);
    const sealed = body(request);
    const stable = () => {
      signal.throwIfAborted();
      invariant(request.signal === signal && request.assertCurrent === assertCurrent && body(request) === sealed,
        'skill_read_request_drifted');
    };
    const guard = { signal, check() {
      try {
        stable(); const verdict = assertCurrent();
        if (verdict && typeof verdict.then === 'function') Promise.resolve(verdict).catch(() => {});
        invariant(verdict === true, 'skill_read_authority_expired'); stable(); return null;
      } catch (error) { return { code: signal.aborted ? 'REQUEST_CANCELLED' : error.code || 'skill_read_authority_expired',
        message: signal.aborted ? 'Skill read cancelled' : 'Skill read authority or identity changed' }; }
    }, assertCurrent() {
      const failure = this.check(); if (failure) throw new SkillToolError(failure.code, failure.message); return true;
    } };
    try {
      guard.assertCurrent();
      const result = await raceAbort(signal, () => handlers[request.call.name](copy(request.call.arguments ?? {}), { guard }));
      guard.assertCurrent(); return result;
    } catch (error) { return { ok: false, error_type: signal.aborted ? 'REQUEST_CANCELLED' : error.code || 'SKILL_READ_FAILED', executed: false }; }
  } };
}

export function nativeSkillWorkflowToolDefinitions() { return copy(TOOL_DEFINITIONS.filter(definition => definition.name === 'execute_skills')); }
