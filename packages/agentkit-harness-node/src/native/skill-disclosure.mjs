// Native Skills progressive disclosure port.
//
// Ports ksadk/harness/skill_adapters/native_disclosure.py and
// ksadk/harness/skill_runtime.py. Four formal tools expose an immutable
// host-bound Skill allowlist with four disclosure levels.
//
// Security invariants (review4):
//   1. restoreRun validates effect.prepared events in record.events — not
//      just intents+receipts. Each disclosure receipt must have a
//      corresponding prepared event with matching operationKey+kind=tool.
//      Removing events from store.load projection must NOT grant L2/L3.
//   2. assertCurrent uses real store lease/intent/fence validation, not
//      always-true. Tests use real NativeKernel with unique runIds.
//   3. scope validated via constructor (trusted), not just 4-field key.
//   4. Error messages are bounded diagnostics — no Host paths/credentials.
//   5. approval_required returns top-level {status, interactionId}.
//   6. All source methods awaited with strict type checks; final guard
//      before return.

import { canonical, copy, invariant, scopeKey, toolInputRejection, matchesToolExecutionContract } from '@kingsoftcloud/agentkit-harness-core';

export const SKILL_DISCLOSURE_CONTRACT = 'agentkit.native-skill-disclosure/v1';
export const SKILL_CATALOG_TOOL = 'skill_catalog';
export const SKILL_MANIFEST_TOOL = 'skill_read_manifest';
export const SKILL_INSTRUCTIONS_TOOL = 'skill_read_instructions';
export const SKILL_RESOURCE_TOOL = 'skill_read_resource';
const RESOURCE_MAX_BYTES = 32768;

function safeMessage(code) { return { REQUEST_CANCELLED: 'Cancelled', SKILL_AUTHORIZATION_EXPIRED: 'Authorization expired', NATIVE_SKILL_DRIFT: 'Request drifted', NATIVE_SKILL_SIGNAL_DRIFT: 'Signal replaced', NATIVE_SKILL_DEFINITION_FORGED: 'Definition mismatch', NATIVE_SKILL_DEFINITION_MISSING: 'Definition required', NATIVE_SKILL_CALL_MISSING: 'Call missing', NATIVE_SKILL_CALL_ID_MISSING: 'CallId required', NATIVE_SKILL_IDENTITY_MISSING: 'Identity missing', NATIVE_SKILL_IDENTITY_INVALID: 'Identity invalid', NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH: 'Scope mismatch', NATIVE_SKILL_AUTHORITY_SESSION_MISMATCH: 'Session mismatch', skill_replay_unavailable: 'Replay unavailable', skill_replay_scope_mismatch: 'Scope mismatch', skill_replay_session_mismatch: 'Session mismatch', skill_not_bound: 'Skill not bound', invalid_skill_query: 'Invalid query', invalid_skill_resource_ref: 'Invalid resource ref', skill_disclosure_order_invalid: 'Disclosure order invalid', skill_resource_unavailable: 'Resource unavailable', skill_resource_too_large: 'Resource too large', skill_source_unavailable: 'Source unavailable' }[code] || code; }

function searchTerms(value) {
  const normalized = (value || '').toLowerCase();
  const terms = new Set();
  for (const token of normalized.matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
    const t = token[0].replace(/^[._-]+|[._-]+$/g, '');
    if (t) terms.add(t);
    for (const part of t.split(/[._-]+/)) if (part) terms.add(part);
  }
  for (const chunk of normalized.matchAll(/[㐀-鿿]+/g)) {
    const c = chunk[0];
    if (c.length === 1) terms.add(c);
    else for (let i = 0; i < c.length - 1; i++) terms.add(c.slice(i, i + 2));
  }
  return terms;
}

const skillIdSchema = { type: 'string', description: 'Revision-bound Skill reference.' };
const DEFINITIONS = [
  { name: SKILL_CATALOG_TOOL, description: 'List the Skills bound to this Agent revision. Unlisted Skills are unavailable.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 5000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'persistent' },
  { name: SKILL_MANIFEST_TOOL, description: "Read a bound Skill's manifest, conditions and required tools. You can also read full instructions directly.",
    parameters: { type: 'object', properties: { skill_id: skillIdSchema }, required: ['skill_id'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 10000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'persistent' },
  { name: SKILL_INSTRUCTIONS_TOOL, description: "Read a bound Skill's full instructions. No prior manifest read required.",
    parameters: { type: 'object', properties: { skill_id: skillIdSchema }, required: ['skill_id'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 10000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'persistent' },
  { name: SKILL_RESOURCE_TOOL, description: "Read a Skill's referenced resource. Requires prior instructions read for the same Skill in the same Run.",
    parameters: { type: 'object', properties: { skill_id: skillIdSchema, resource_ref: { type: 'string', description: 'Package-relative resource path.' } }, required: ['skill_id', 'resource_ref'], additionalProperties: false },
    readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 10000,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'persistent' },
];

function validateRequestIdentity(request) {
  const { scope, runId, sessionId, turnId, buildId, parentRunId, taskChainId, operationKey, executionFence, signal } = request;
  if (!(scope && typeof scope === 'object' && !Array.isArray(scope))) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  try { scopeKey(scope); } catch { return { code: 'NATIVE_SKILL_IDENTITY_INVALID' }; }
  if (typeof runId !== 'string' || !runId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (typeof sessionId !== 'string' || !sessionId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (typeof turnId !== 'string' || !turnId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (typeof buildId !== 'string' || !buildId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (parentRunId !== null && (typeof parentRunId !== 'string' || !parentRunId.trim())) return { code: 'NATIVE_SKILL_IDENTITY_INVALID' };
  if (typeof taskChainId !== 'string' || !taskChainId.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (typeof operationKey !== 'string' || !operationKey.trim()) return { code: 'NATIVE_SKILL_IDENTITY_MISSING' };
  if (!Number.isSafeInteger(executionFence) || executionFence <= 0) return { code: 'NATIVE_SKILL_IDENTITY_INVALID' };
  if (!(signal instanceof AbortSignal)) return { code: 'NATIVE_SKILL_IDENTITY_INVALID' };
  return null;
}

function snapshotRequest(request, internalDef) {
  const { signal, ...rest } = request;
  return canonical({ ...rest, internalDefinition: internalDef });
}

const ALLOWED_ARGS = {
  [SKILL_CATALOG_TOOL]: new Set(['query']),
  [SKILL_MANIFEST_TOOL]: new Set(['skill_id']),
  [SKILL_INSTRUCTIONS_TOOL]: new Set(['skill_id']),
  [SKILL_RESOURCE_TOOL]: new Set(['skill_id', 'resource_ref']),
};
const REQUIRED_ARGS = {
  [SKILL_CATALOG_TOOL]: [],
  [SKILL_MANIFEST_TOOL]: ['skill_id'],
  [SKILL_INSTRUCTIONS_TOOL]: ['skill_id'],
  [SKILL_RESOURCE_TOOL]: ['skill_id', 'resource_ref'],
};

class SkillRuntime {
  constructor(source) { this._source = source; }
  level(levels, runId, skillId) { return levels.get(`${runId}:${skillId}`) ?? 0; }
  restoreLevel(levels, runId, skillId, level) {
    const current = this.level(levels, runId, skillId);
    if (![1, 2, 3].includes(level) || (level === 3 && current < 2))
      throw Object.assign(new Error('order invalid'), { code: 'SkillDisclosureError' });
    levels.set(`${runId}:${skillId}`, Math.max(current, level));
  }
  async manifest(skillId) {
    const m = await this._source.manifest(skillId);
    if (!m || typeof m !== 'object') throw new Error('manifest must return object');
    return m;
  }
  async fullText(skillId) {
    const t = await this._source.fullText(skillId);
    if (typeof t !== 'string') throw new Error('fullText must return string');
    return t;
  }
  async resource(skillId, resourceRef) {
    const r = await this._source.resource(skillId, resourceRef);
    if (!(r instanceof Buffer) && !(r instanceof Uint8Array)) throw new Error('resource must return Buffer/Uint8Array');
    return r;
  }
  async catalogEntry(skillId) {
    const manifest = await this.manifest(skillId);
    return { skillId, name: manifest.name, summary: manifest.summary };
  }
  async recommend(skillIds, { query, limit = 5 } = {}, guard) {
    const entries = [];
    for (const id of skillIds) {
      const g = guard.check(); if (g) throw Object.assign(new Error(g.message), { code: g.code });
      entries.push(await this.catalogEntry(id));
      const g2 = guard.check(); if (g2) throw Object.assign(new Error(g2.message), { code: g2.code });
    }
    const queryTerms = searchTerms(query);
    const ranked = entries.map((entry, index) => {
      const nameTerms = searchTerms(entry.name);
      const summaryTerms = searchTerms(entry.summary);
      const nameHits = [...queryTerms].filter(t => nameTerms.has(t)).length;
      const summaryHits = [...queryTerms].filter(t => summaryTerms.has(t)).length;
      return { score: nameHits * 3 + summaryHits, index, entry };
    });
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    const positive = new Set(ranked.slice(0, limit).filter(r => r.score >= 3).map(r => r.index));
    return ranked.map(({ score, index, entry }) => ({
      ...entry, recommended: positive.has(index) ? 'true' : 'false', recommendationScore: String(score),
    }));
  }
}

export function nativeSkillDisclosureDefinitions() { return copy(DEFINITIONS); }

export function createNativeSkillDisclosurePort({ scope, sessionId, store, source, skillRefs, authorize, assertCurrent } = {}) {
  invariant(typeof authorize === 'function', 'native_skill_disclosure_authorize_required');
  invariant(source && typeof source.manifest === 'function' && typeof source.fullText === 'function' && typeof source.resource === 'function', 'native_skill_disclosure_source_required');
  invariant(typeof assertCurrent === 'function', 'native_skill_disclosure_assert_current_required');
  invariant(store && typeof store.load === 'function', 'native_skill_disclosure_store_required');
  invariant(typeof sessionId === 'string' && sessionId.trim(), 'native_skill_disclosure_session_invalid');
  if (!Array.isArray(skillRefs) || skillRefs.some(ref => typeof ref !== 'string' || !ref.trim()))
    throw Object.assign(new Error('skill_refs invalid'), { code: 'native_skill_refs_invalid' });
  if (new Set(skillRefs).size !== skillRefs.length)
    throw Object.assign(new Error('skill_refs not unique'), { code: 'native_skill_refs_invalid' });
  // Validate trusted constructor scope (not just 4-field key).
  invariant(scope && typeof scope === 'object' && !Array.isArray(scope) && ['tenantId', 'workspaceId', 'userId', 'agentId'].every(k => typeof scope[k] === 'string' && scope[k].trim()), 'native_skill_disclosure_scope_invalid');
  const sealedSkillRefs = copy(skillRefs);
  const sealedSkillRefSet = new Set(sealedSkillRefs);
  const sealedScope = copy(scope);
  const sealedSessionId = sessionId;
  const internalDefinitions = copy(DEFINITIONS);
  const internalDefinitionMap = new Map(internalDefinitions.map(d => [d.name, copy(d)]));
  const publicDefinitions = copy(DEFINITIONS);
  const runtime = new SkillRuntime(source);
  let closed = false;

  function makeGuard(request, internalDef) {
    const sealed = snapshotRequest(request, internalDef);
    const originalSignal = request.signal;
    const originalRequest = request;
    return {
      check() {
        if (closed) return { code: 'SKILL_AUTHORIZATION_EXPIRED' };
        if (originalSignal.aborted) return { code: 'REQUEST_CANCELLED' };
        if (originalRequest.signal !== originalSignal) return { code: 'NATIVE_SKILL_SIGNAL_DRIFT' };
        let acResult;
        try { acResult = assertCurrent(originalRequest); }
        catch (e) { return { code: 'SKILL_AUTHORIZATION_EXPIRED' }; }
        if (acResult !== true) {
          if (acResult && typeof acResult.then === 'function') { acResult.then(() => {}, () => {}); return { code: 'SKILL_AUTHORIZATION_EXPIRED' }; }
          return { code: 'SKILL_AUTHORIZATION_EXPIRED' };
        }
        if (closed) return { code: 'SKILL_AUTHORIZATION_EXPIRED' };
        if (originalRequest.signal !== originalSignal) return { code: 'NATIVE_SKILL_SIGNAL_DRIFT' };
        if (originalSignal.aborted) return { code: 'REQUEST_CANCELLED' };
        const current = snapshotRequest(originalRequest, internalDef);
        if (current !== sealed) return { code: 'NATIVE_SKILL_DRIFT' };
        return null;
      },
      signal: originalSignal,
    };
  }

  // Rebuild levels from committed receipts on EVERY request.
  // review4 #1: Must validate effect.prepared events in record.events,
  // not just intents+receipts. Without a matching prepared event, no grant.
  function restoreRun(runId) {
    const levels = new Map();
    let record;
    try { record = store.load(sealedScope, runId); }
    catch (error) { if (error?.code === 'run_not_found') return levels; throw error; }
    if (canonical(record.snapshot.scope) !== canonical(sealedScope))
      throw Object.assign(new Error('scope mismatch'), { code: 'skill_replay_scope_mismatch' });
    if (record.snapshot.sessionId !== sealedSessionId)
      throw Object.assign(new Error('session mismatch'), { code: 'skill_replay_session_mismatch' });
    // Build a set of operationKeys that have a matching effect.prepared event
    // with kind=tool. This is the authoritative proof that the tool effect
    // was actually prepared in the ledger, not just hand-inserted.
    const preparedToolOps = new Set();
    for (const event of record.events ?? []) {
      if (event.kind === 'effect.prepared' && event.payload?.kind === 'tool') {
        preparedToolOps.add(event.payload.operationKey);
      }
    }
    // Build a map of operationKey → intent for tool intents.
    const toolIntents = new Map();
    for (const intent of record.intents) {
      if (intent.kind !== 'tool') continue;
      toolIntents.set(intent.operationKey, intent);
    }
    // Check receipts that correspond to tool intents WITH a prepared event.
    for (const receipt of record.receipts) {
      if (receipt.status !== 'committed') continue;
      // review4 #1: Must have a matching effect.prepared event.
      if (!preparedToolOps.has(receipt.operationKey)) continue;
      const intent = toolIntents.get(receipt.operationKey);
      if (!intent) continue;
      const calls = intent.payload?.calls;
      const results = receipt.result?.results;
      if (!Array.isArray(calls) || !Array.isArray(results) || calls.length !== results.length) continue;
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const result = results[i];
        if (result?.status !== 'ok' || typeof call !== 'object' || call === null) continue;
        const args = call.arguments;
        const content = result.content;
        if (typeof args !== 'object' || args === null || typeof content !== 'object' || content === null) continue;
        const allowed = ALLOWED_ARGS[call.name];
        if (!allowed) continue;
        const argKeys = Object.keys(args);
        if (argKeys.some(k => !allowed.has(k))) continue;
        const required = REQUIRED_ARGS[call.name];
        if (required.some(r => !(r in args))) continue;
        const skillId = args.skill_id;
        if (typeof skillId !== 'string' || !sealedSkillRefSet.has(skillId) || content.skill_id !== skillId) continue;
        const levelMap = { [SKILL_MANIFEST_TOOL]: 1, [SKILL_INSTRUCTIONS_TOOL]: 2, [SKILL_RESOURCE_TOOL]: 3 };
        const level = levelMap[call.name];
        if (level === undefined) continue;
        // Validate the formal definition in configuration matches internal.
        const configTools = record.configuration?.tools ?? [];
        const configDef = configTools.find(t => t.name === call.name);
        if (!configDef || !matchesToolExecutionContract(configDef, internalDefinitionMap.get(call.name))) continue;
        try { runtime.restoreLevel(levels, runId, skillId, level); } catch { /* contradictory → deny */ }
      }
    }
    return levels;
  }

  // --- async handlers with per-await guards ---
  async function catalogHandler(args, ctx) {
    const { query = '' } = args;
    if (typeof query !== 'string') return { status: 'error', code: 'invalid_skill_query' };
    let g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
    try {
      const bound = await runtime.recommend(sealedSkillRefs, { query }, ctx.guard);
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      return { status: 'ok', content: { bound_skills: bound, unlisted_skills_available: false } };
    } catch (e) {
      if (['REQUEST_CANCELLED', 'SKILL_AUTHORIZATION_EXPIRED', 'NATIVE_SKILL_DRIFT', 'NATIVE_SKILL_SIGNAL_DRIFT'].includes(e.code)) return { status: 'error', code: e.code, message: safeMessage(e.code) };
      return { status: 'error', code: 'skill_source_unavailable' };
    }
  }

  async function manifestHandler(args, ctx) {
    const { skill_id: skillId } = args;
    if (typeof skillId !== 'string' || !sealedSkillRefSet.has(skillId)) return { status: 'error', code: 'skill_not_bound' };
    let g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
    try {
      const manifest = await runtime.manifest(skillId);
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      return { status: 'ok', content: { skill_id: skillId, name: manifest.name, summary: manifest.summary, conditions: manifest.conditions || '', required_tools: [...(manifest.requiredTools || [])], resource_base: 'skill-root', resource_access: manifest.resourceRefs != null ? 'locked_package' : 'instructions_only' } };
    } catch { return { status: 'error', code: 'skill_source_unavailable' }; }
  }

  async function instructionsHandler(args, ctx) {
    const { skill_id: skillId } = args;
    if (typeof skillId !== 'string' || !sealedSkillRefSet.has(skillId)) return { status: 'error', code: 'skill_not_bound' };
    let g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
    try {
      const instructions = await runtime.fullText(skillId);
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      return { status: 'ok', content: { skill_id: skillId, instructions } };
    } catch (e) {
      if (e.code === 'SkillDisclosureError') return { status: 'error', code: 'skill_disclosure_order_invalid' };
      return { status: 'error', code: 'skill_source_unavailable' };
    }
  }

  async function resourceHandler(args, ctx) {
    const { skill_id: skillId, resource_ref: resourceRef } = args;
    if (typeof skillId !== 'string' || !sealedSkillRefSet.has(skillId)) return { status: 'error', code: 'skill_not_bound' };
    if (typeof resourceRef !== 'string' || !resourceRef || resourceRef.startsWith('/')
      || resourceRef.includes('\\') || resourceRef.includes('\0')
      || resourceRef.split('/').some(part => !part || part === '.' || part === '..')) {
      return { status: 'error', code: 'invalid_skill_resource_ref' };
    }
    if (runtime.level(ctx.levels, ctx.runId, skillId) < 2) return { status: 'error', code: 'skill_disclosure_order_invalid' };
    let g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
    try {
      const manifest = await runtime.manifest(skillId);
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      if (manifest.resourceRefs != null) {
        if (!manifest.resourceRefs.includes(resourceRef)) throw Object.assign(new Error('undeclared'), { code: 'SkillDisclosureError' });
      } else {
        const instructions = await runtime.fullText(skillId);
        g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
        if (!instructions.includes(resourceRef)) throw Object.assign(new Error('unreferenced'), { code: 'SkillDisclosureError' });
      }
      const content = await runtime.resource(skillId, resourceRef);
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      if (content.length > RESOURCE_MAX_BYTES) return { status: 'error', code: 'skill_resource_too_large', limit_bytes: RESOURCE_MAX_BYTES };
      g = ctx.guard.check(); if (g) return { status: 'error', code: g.code, message: safeMessage(g.code) };
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        return { status: 'ok', content: { skill_id: skillId, resource_ref: resourceRef, encoding: 'utf-8', text } };
      } catch {
        return { status: 'ok', content: { skill_id: skillId, resource_ref: resourceRef, encoding: 'base64', data: Buffer.from(content).toString('base64') } };
      }
    } catch (e) {
      if (e.code === 'SkillDisclosureError') return { status: 'error', code: 'skill_resource_unavailable' };
      if (['REQUEST_CANCELLED', 'SKILL_AUTHORIZATION_EXPIRED', 'NATIVE_SKILL_DRIFT', 'NATIVE_SKILL_SIGNAL_DRIFT'].includes(e.code)) return { status: 'error', code: e.code, message: safeMessage(e.code) };
      return { status: 'error', code: 'skill_source_unavailable' };
    }
  }

  const handlers = { [SKILL_CATALOG_TOOL]: catalogHandler, [SKILL_MANIFEST_TOOL]: manifestHandler, [SKILL_INSTRUCTIONS_TOOL]: instructionsHandler, [SKILL_RESOURCE_TOOL]: resourceHandler };

  return {
    definitions: publicDefinitions,
    contract: SKILL_DISCLOSURE_CONTRACT,
    close() { closed = true; },
    execute(request = {}) {
      const { call } = request;
      if (!call?.name) return { status: 'error', content: { code: 'NATIVE_SKILL_CALL_MISSING', executed: false, message: safeMessage('NATIVE_SKILL_CALL_MISSING') } };
      const internalDef = internalDefinitionMap.get(call.name);
      if (!internalDef) return { status: 'error', content: { code: 'native_skill_tool_unbound', executed: false, message: 'tool not bound' } };
      if (typeof call.callId !== 'string' || !call.callId.trim()) return { status: 'error', content: { code: 'NATIVE_SKILL_CALL_ID_MISSING', executed: false, message: safeMessage('NATIVE_SKILL_CALL_ID_MISSING') } };
      if (request.definition === undefined) return { status: 'error', content: { code: 'NATIVE_SKILL_DEFINITION_MISSING', executed: false, message: safeMessage('NATIVE_SKILL_DEFINITION_MISSING') } };
      if (!matchesToolExecutionContract(request.definition, internalDef)) return { status: 'error', content: { code: 'NATIVE_SKILL_DEFINITION_FORGED', executed: false, message: safeMessage('NATIVE_SKILL_DEFINITION_FORGED') } };
      const identityError = validateRequestIdentity(request);
      if (identityError) return { status: 'error', content: { ...identityError, executed: false, message: safeMessage(identityError.code) } };
      try { if (scopeKey(request.scope) !== scopeKey(sealedScope)) return { status: 'error', content: { code: 'NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH', executed: false, message: safeMessage('NATIVE_SKILL_AUTHORITY_SCOPE_MISMATCH') } }; }
      catch { return { status: 'error', content: { code: 'NATIVE_SKILL_IDENTITY_INVALID', executed: false, message: safeMessage('NATIVE_SKILL_IDENTITY_INVALID') } }; }
      if (request.sessionId !== sealedSessionId) return { status: 'error', content: { code: 'NATIVE_SKILL_AUTHORITY_SESSION_MISMATCH', executed: false, message: safeMessage('NATIVE_SKILL_AUTHORITY_SESSION_MISMATCH') } };
      const rejection = toolInputRejection(internalDef, request.call);
      if (rejection) return { status: 'error', content: rejection };
      const guard = makeGuard(request, internalDef);
      if (guard.signal.aborted) return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: safeMessage('REQUEST_CANCELLED') } };

      return (async () => {
        let g0 = guard.check(); if (g0) return { status: 'error', content: { code: g0.code, executed: false, message: safeMessage(g0.code) } };
        let decision;
        try { decision = await authorize(request); }
        catch (error) {
          if (guard.signal.aborted) return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: safeMessage('REQUEST_CANCELLED') } };
          return { status: 'error', content: { code: error.code || 'NATIVE_SKILL_ERROR', executed: false, message: 'authorization error' } };
        }
        const gAuth = guard.check();
        if (gAuth) return { status: 'error', content: { code: gAuth.code, executed: false, message: safeMessage(gAuth.code) } };
        if (decision !== 'allow') {
          if (typeof decision === 'object' && (decision.status === 'approval_required' || decision.approval_required))
            return { status: 'approval_required', interactionId: decision.interactionId || '', content: decision };
          const code = typeof decision === 'object' ? decision.code : 'STUDIO_NATIVE_SKILL_PERMISSION_DENIED';
          const message = typeof decision === 'object' ? decision.message : 'not authorized';
          return { status: 'error', content: { code, executed: false, message } };
        }
        const g1 = guard.check(); if (g1) return { status: 'error', content: { code: g1.code, executed: false, message: safeMessage(g1.code) } };
        let levels;
        try { levels = restoreRun(request.runId); }
        catch { return { status: 'error', content: { code: 'skill_replay_unavailable', executed: false, message: safeMessage('skill_replay_unavailable') } }; }
        try {
          guard.signal.throwIfAborted();
          const ctx = { signal: guard.signal, scope: request.scope, runId: request.runId, sessionId: request.sessionId, turnId: request.turnId, buildId: request.buildId, parentRunId: request.parentRunId, taskChainId: request.taskChainId, operationKey: request.operationKey, executionFence: request.executionFence, callId: request.call.callId, guard, levels };
          const result = await handlers[request.call.name](request.call.arguments ?? {}, ctx);
          const gFinal = guard.check(); if (gFinal) return { status: 'error', content: { code: gFinal.code, executed: false, message: safeMessage(gFinal.code) } };
          if (result?.status === 'error') return { status: 'error', content: { ...result, executed: false, message: result.message || safeMessage(result.code) } };
          return { status: 'ok', content: result.content };
        } catch (error) {
          if (guard.signal.aborted) return { status: 'error', content: { code: 'REQUEST_CANCELLED', executed: false, message: safeMessage('REQUEST_CANCELLED') } };
          return { status: 'error', content: { code: error.code || 'NATIVE_SKILL_ERROR', executed: false, message: 'execution error' } };
        }
      })();
    },
  };
}
