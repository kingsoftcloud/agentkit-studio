/** AgentEngine metadata Actions over one installed DSH runtime. */
import { randomUUID } from 'node:crypto';
import { createManagedSessionRegistry, managedSessionKey } from './managed-session-registry.mjs';
import { managedRuntimePrincipal } from './managed-runtime-identity.mjs';
import { readManagedSessionMessages, readManagedSessionEvents } from './managed-session-history.mjs';
import { runtimeError } from './runtime-responses-contract.mjs';
import { managedRuntimeBootstrap } from './managed-runtime-capabilities.mjs';
import { businessInvocationId, normalizeBusinessInvocation } from './providers/business-invocation-context.mjs';

const BUSINESS_USER_INPUT = '__agentkit_business_user_id';
const BUSINESS_SESSION_INPUT = '__agentkit_business_session_id';

/** Accept the Responses compatibility input for one approval decision. */
function approvalResponseItem(value) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') return null;
  const item = value[0];
  if (item.type !== 'mcp_approval_response') return null;
  const fields = Object.keys(item);
  if (fields.some(key => !['type', 'approval_request_id', 'approve'].includes(key))
    || typeof item.approval_request_id !== 'string' || !/^appr_[a-f0-9]{32}$/.test(item.approval_request_id)
    || typeof item.approve !== 'boolean') throw runtimeError('RESPONSES_APPROVAL_RESPONSE_INVALID');
  return { requestId: item.approval_request_id, approve: item.approve };
}

export async function createManagedRuntimeActions({ ctx, runtime, admit, model, models, directory, approval, executionPolicy, allowedPermissionModes, env = process.env }) {
  const registry = await createManagedSessionRegistry(directory);
  const controller = ctx.get('sessionController'), sessions = ctx.get('sessions'), persistence = ctx.get('sessionPersistence');
  if (!controller || !sessions || !persistence) throw runtimeError('RUNTIME_SESSION_PERSISTENCE_REQUIRED', 503);
  const retiring = new Set();
  const declaredMcp = runtime.declaration?.resources?.mcp_servers;
  // Business identity is a general capability: whenever the caller supplies
  // RunAgent.UserId/SessionId it is forwarded to the bound MCP servers. Only a
  // deployment that partitions data or audits by business user opts into
  // requiring it, because demanding UserId from every existing MCP caller
  // would be a breaking change for the Agents that never had that contract.
  const requiresBusinessIdentity = Array.isArray(declaredMcp) && declaredMcp.length > 0
    && /^(?:1|true|yes|on|require|required)$/i.test(String(env?.AGENTKIT_MCP_BUSINESS_IDENTITY ?? '').trim());
  let cancelSession = () => {}, cancelRun = () => false;
  function principal(headers, input = {}) {
    if ((input.AgentId && input.AgentId !== runtime.identity.agentId) || (headers['x-auth-agent-id'] && headers['x-auth-agent-id'] !== runtime.identity.agentId)) throw runtimeError('RUNTIME_AGENT_NOT_FOUND', 404);
    return managedRuntimePrincipal(headers);
  }
  async function requireSession(id, owner, { deleting = false } = {}) {
    const record = await registry.read(id);
    // Session identity is Agent-scoped, not Version-scoped: an accepted
    // UpdateAgent mints a new VersionId while the DSH transcript and this
    // registry stay on the same Agent state root. The Hosted UI must keep
    // listing and opening sessions recorded by an earlier version.
    if (!record || record.owner !== owner.digest) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
    if (record.phase === 'deleted') throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
    if (!deleting && (retiring.has(record.nativeSessionId) || record.phase !== 'ready')) throw runtimeError('RUNTIME_SESSION_UNAVAILABLE', 409);
    return record;
  }
  async function flush(nativeId) {
    const live = sessions.get(nativeId);
    if (live && !await sessions.flush(live)) throw runtimeError('RUNTIME_SESSION_PERSISTENCE_REQUIRED', 503);
  }
  async function settle(nativeId) {
    const agent = ctx.get('agents').list().find(item => item.session.id === nativeId);
    if (agent) {
      let timer;
      try { await Promise.race([agent.whenIdle(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(runtimeError('RUNTIME_TERMINAL_UNCONFIRMED', 503)), 20000); timer.unref();
      })]); } finally { clearTimeout(timer); }
    }
    await flush(nativeId);
  }
  async function ensure(id, nativeId, owner, signal, businessUserId, businessSessionId) {
    return registry.serial(id, async () => {
      let record = await registry.read(id);
      if (record) {
        if (record.owner !== owner.digest || record.nativeSessionId !== nativeId) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
        if ((businessUserId && record.businessUserId && record.businessUserId !== businessUserId)
          || (businessSessionId && record.businessSessionId && record.businessSessionId !== businessSessionId)) {
          throw runtimeError('RUNTIME_BUSINESS_SESSION_CONFLICT', 409);
        }
        if (record.phase === 'deleted' || record.phase === 'deleting' || retiring.has(nativeId)) throw runtimeError('RUNTIME_SESSION_UNAVAILABLE', 409);
        // The business session is attribution only: it is bound on the first
        // RunAgent that names it, and a later turn may omit it without
        // rewriting the binding.
        if ((businessUserId && !record.businessUserId) || (businessSessionId && !record.businessSessionId)) {
          record = { ...record,
            ...(businessUserId && !record.businessUserId ? { businessUserId } : {}),
            ...(businessSessionId && !record.businessSessionId ? { businessSessionId } : {}) };
          await registry.write(record);
        }
        if (record.versionId !== runtime.identity.versionId) {
          // Keep the immutable session identity, refresh only the version that
          // currently serves it so later payloads describe the running Host.
          record = { ...record, versionId: runtime.identity.versionId };
          await registry.write(record);
        }
      } else {
        if (await controller.projections({ sessionId: nativeId }, signal)) throw runtimeError('RUNTIME_SESSION_METADATA_UNAVAILABLE', 503);
        record = { format: 'agentengine.dsh-session/v1', sessionId: id, nativeSessionId: nativeId,
          versionId: runtime.identity.versionId, owner: owner.digest, userId: owner.userId,
          ...(businessUserId ? { businessUserId } : {}),
          ...(businessSessionId ? { businessSessionId } : {}),
          epoch: randomUUID(), phase: 'creating', createdAt: new Date().toISOString() };
        await registry.write(record);
      }
      const projection = await controller.projections({ sessionId: nativeId }, signal);
      if (!projection && record.phase === 'ready') throw runtimeError('RUNTIME_SESSION_HISTORY_UNAVAILABLE', 503);
      if (!projection) await ctx.get('agents').withoutInitiator(async () => {
        const admission = await admit(runtime.identity.agentId, runtime.agent);
        const created = await controller.create({ sessionId: nativeId, agentPreset: admission.presetId });
        if (created.sessionId !== nativeId) throw runtimeError('RUNTIME_SESSION_ID_CONFLICT', 409);
        if (admission.modelSelection) await controller.selectModel({ sessionId: nativeId, ...admission.modelSelection, saveDefault: false });
      });
      await flush(nativeId);
      const stat = await persistence.stat(nativeId, { signal });
      if (!stat) throw runtimeError('RUNTIME_SESSION_PERSISTENCE_REQUIRED', 503);
      const nativeCreatedAt = new Date(stat.header.createdAt).toISOString();
      if (record.phase === 'ready' && record.nativeCreatedAt !== nativeCreatedAt) throw runtimeError('HISTORY_RELOAD_REQUIRED', 409);
      if (record.phase !== 'ready') { record = { ...record, phase: 'ready', nativeCreatedAt }; await registry.write(record); }
      return record;
    });
  }
  async function sessionPayload(record, signal) {
    const projection = await controller.projections({ sessionId: record.nativeSessionId }, signal);
    if (!projection || projection.kind === 'migration-required') throw runtimeError('RUNTIME_SESSION_HISTORY_UNAVAILABLE', 503);
    const title = projection.values?.title;
    const updatedAt = projection.values?.sessionListMetadata?.lastPromptAt ?? record.createdAt;
    return { SessionId: record.sessionId, AgentId: runtime.identity.agentId, UserId: record.userId,
      VersionId: runtime.identity.versionId, Version: 1, CreatedAt: record.createdAt, UpdatedAt: new Date(updatedAt).toISOString(),
      Title: typeof title === 'string' ? title : '', TitleSource: title ? 'runtime' : '', RuntimeSync: 'synced',
      State: {}, Continuity: { Level: 'runtime', Path: 'native-session', Runtime: runtime.identity.runtimeName } };
  }
  async function history(record, request, signal, events = false) {
    await flush(record.nativeSessionId);
    let observation;
    try {
      observation = await ctx.get('sessionQuery').observeSession(record.nativeSessionId, { signal, projectionMode: 'none' });
    } catch {
      signal?.throwIfAborted();
      throw runtimeError('RUNTIME_SESSION_HISTORY_UNAVAILABLE', 503);
    }
    try {
      if (new Date(observation.header.createdAt).toISOString() !== record.nativeCreatedAt) throw runtimeError('HISTORY_RELOAD_REQUIRED', 409);
      // A cold DSH observation includes native interrupted-turn closers that
      // are absent from disk. Read events and their cursor from this same view.
      const handle = { read: async (offset, length) => ({ events: observation.events.slice(offset, offset + length) }) };
      return await (events ? readManagedSessionEvents : readManagedSessionMessages)({ handle, session: record, latestSeq: observation.cursor + 1, request,
        invocationId: registry.invocationId, signal });
    } finally { observation[Symbol.dispose](); }
  }
  return {
    setRunControl: value => { cancelSession = value.cancelSession; cancelRun = value.cancelRun; },
    async parseResponses(payload, headers, responses, signal, { runAgent = false } = {}) {
      const owner = principal(headers);
      // Business identity is Host authority: `responsesInput()` mints these
      // private fields for the RunAgent action only. A direct `/v1/responses`
      // caller cannot claim a business user or session, and the public
      // `session_id` is never relabelled as a business session.
      const rawBusinessUserId = runAgent ? payload?.[BUSINESS_USER_INPUT] : undefined;
      const businessUserId = rawBusinessUserId === undefined ? undefined : businessInvocationId(rawBusinessUserId);
      if (rawBusinessUserId !== undefined && !businessUserId) throw runtimeError('RUNTIME_BUSINESS_USER_ID_INVALID');
      const rawBusinessSessionId = runAgent ? payload?.[BUSINESS_SESSION_INPUT] : undefined;
      const publicPayload = payload && typeof payload === 'object'
        ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== BUSINESS_USER_INPUT && key !== BUSINESS_SESSION_INPUT))
        : payload;
      const businessSessionId = rawBusinessSessionId;
      // `publicPayload` already dropped both private fields, so the public
      // Responses contract sees only its own keys.
      const inputPayload = publicPayload;
      const approvalInput = approvalResponseItem(inputPayload?.input);
      if (approvalInput) {
        const platformId = inputPayload?.session_id ?? inputPayload?.conversation;
        if (typeof platformId !== 'string' || !managedSessionKey(platformId)) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
        const record = await requireSession(platformId, owner);
        const decided = responses.parse({ input: 'approval decision', stream: inputPayload.stream,
          session_id: record.sessionId, request_id: inputPayload.request_id ?? `approval-${approvalInput.requestId}`,
          ...(inputPayload.model === undefined ? {} : { model: inputPayload.model }) }, headers, { principal: owner.key });
        // Resume replays the binding the original RunAgent established and omits
        // business attribution that call never named. The invocation id is a
        // platform correlation id, so it is always present.
        const businessInvocation = normalizeBusinessInvocation({
          userId: record.businessUserId, sessionId: record.businessSessionId, requestId: decided.requestId,
          agentId: runtime.identity.agentId, nativeSessionId: record.nativeSessionId,
        });
        if (requiresBusinessIdentity && (!businessInvocation?.userId || !businessInvocation?.sessionId)) throw runtimeError('RUNTIME_BUSINESS_ID_REQUIRED');
        return { ...decided, input: '', approval: approvalInput, platformSession: record, principalDigest: owner.digest, businessInvocation };
      }
      const input = responses.parse(inputPayload, headers, { principal: owner.key });
      let record;
      if (input.previous || input.sessionLabel.startsWith('conv_')) {
        record = (await registry.list()).find(item => item.nativeSessionId === input.sessionId && item.owner === owner.digest);
        if (!record) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
        record = await requireSession(record.sessionId, owner);
      } else {
        // Require-mode admission fails before a record is created, but an
        // existing binding is reused instead of demanding the caller restate it.
        const existing = requiresBusinessIdentity ? await registry.read(input.sessionLabel) : null;
        if (requiresBusinessIdentity && (!businessUserId || !businessSessionId) && !existing?.businessUserId) throw runtimeError('RUNTIME_BUSINESS_ID_REQUIRED');
        record = await ensure(input.sessionLabel, input.sessionId, owner, signal, businessUserId, businessSessionId);
      }
      if (businessUserId && record.businessUserId && record.businessUserId !== businessUserId) throw runtimeError('RUNTIME_BUSINESS_SESSION_CONFLICT', 409);
      if (businessSessionId && record.businessSessionId && record.businessSessionId !== businessSessionId) throw runtimeError('RUNTIME_BUSINESS_SESSION_CONFLICT', 409);
      // Resume replays the binding the original RunAgent established. The
      // platform session is never substituted for a business session: when no
      // RunAgent ever named one, the field is simply absent.
      const effectiveBusinessUserId = businessUserId ?? record.businessUserId;
      const effectiveBusinessSessionId = businessSessionId ?? record.businessSessionId;
      if (requiresBusinessIdentity && (!effectiveBusinessUserId || !effectiveBusinessSessionId)) throw runtimeError('RUNTIME_BUSINESS_ID_REQUIRED');
      const businessInvocation = normalizeBusinessInvocation({
        userId: effectiveBusinessUserId, sessionId: effectiveBusinessSessionId,
        requestId: input.requestId, agentId: runtime.identity.agentId, nativeSessionId: record.nativeSessionId,
      });
      if (!businessInvocation) throw runtimeError('RUNTIME_BUSINESS_INVOCATION_INVALID');
      await registry.request(record, input.runId, input.requestId);
      return { ...input, platformSession: record, principalDigest: owner.digest, businessInvocation };
    },
    async checkRun(input) {
      const record = await requireSession(input.platformSession.sessionId, { digest: input.principalDigest });
      if (requiresBusinessIdentity && !input.businessInvocation?.userId) throw runtimeError('RUNTIME_BUSINESS_ID_REQUIRED');
      if (input.businessInvocation?.userId && record.businessUserId !== input.businessInvocation.userId) throw runtimeError('RUNTIME_BUSINESS_SESSION_CONFLICT', 409);
    },
    authorizeCancel: (headers, target) => {
      if (principal(headers).digest !== target.principalDigest) throw runtimeError('RUNTIME_RUN_NOT_ACTIVE', 404);
    },
    responsesInput(request) {
      const allowed = ['AgentId', 'SessionId', 'UserId', 'AccountId', 'Messages', 'ResponsesInput', 'PreviousResponseId', 'InvocationId', 'Stream', 'ApiFormat', 'Metadata', 'Model', 'Background'];
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !allowed.includes(key))
        || (request.AgentId && request.AgentId !== runtime.identity.agentId) || (request.ApiFormat && request.ApiFormat !== 'responses') || request.Background === true) throw runtimeError('RUNTIME_RUN_INPUT_UNSUPPORTED');
      const businessUserId = request.UserId === undefined ? undefined : businessInvocationId(request.UserId);
      if (request.UserId !== undefined && !businessUserId) throw runtimeError('RUNTIME_BUSINESS_USER_ID_INVALID');
      return { input: request.ResponsesInput ?? request.Messages, session_id: request.SessionId, previous_response_id: request.PreviousResponseId,
        request_id: request.InvocationId, stream: request.Stream, model: request.Model, metadata: request.Metadata,
        ...(businessUserId === undefined ? {} : { [BUSINESS_USER_INPUT]: businessUserId }),
        ...(request.SessionId === undefined ? {} : { [BUSINESS_SESSION_INPUT]: request.SessionId }) };
    },
    async dispatch(action, request, headers, responses, signal) {
      const owner = principal(headers, request);
      const fields = {
        GetAgentUiBootstrap: ['Name', 'SessionId'], ListAgentModels: ['Name'], CreateSession: ['SessionId'],
        GetSession: ['SessionId'], DeleteSession: ['SessionId'], ListSessions: ['Page', 'PageSize'],
        CancelRun: ['SessionId', 'InvocationId', 'ResponseId', 'ClientToken'],
        SubmitInteraction: ['SessionId', 'RunId', 'InteractionId', 'ExpectedRevision', 'Action', 'Response', 'IdempotencyKey'],
        ListSessionMessages: ['SessionId', 'Limit', 'AfterSeqId', 'BeforeSeqId', 'HistoryEpoch', 'SnapshotSeqId', 'CursorSource', 'IncludeReasoning', 'IncludeToolEvents', 'IncludeAttachments'],
        ListSessionEvents: ['SessionId', 'Limit', 'AfterSeqId', 'BeforeSeqId', 'HistoryEpoch', 'SnapshotSeqId', 'CursorSource', 'EventTypes', 'EventOrder', 'Offset', 'CheckpointIds'],
      }[action];
      if (!fields) throw runtimeError('RUNTIME_ACTION_UNSUPPORTED', 404);
      if (Object.keys(request).some(key => !['AgentId', 'UserId', ...fields].includes(key))) throw runtimeError('RUNTIME_ACTION_INPUT_UNSUPPORTED');
      if (action === 'GetAgentUiBootstrap') return managedRuntimeBootstrap(runtime, model, { executionPolicy, allowedPermissionModes });
      if (action === 'ListAgentModels') return { Models: models.map(name => ({ id: name, name, source: 'managed-manifest' })), Current: model, Source: 'managed-manifest' };
      if (action === 'CreateSession') {
        const id = request.SessionId || `sess-${randomUUID()}`;
        if (!managedSessionKey(id)) throw runtimeError('RUNTIME_SESSION_ID_INVALID');
        const parsed = responses.parse({ input: 'session creation', session_id: id, request_id: 'session-create' }, {}, { principal: owner.key });
        return { Session: await sessionPayload(await ensure(id, parsed.sessionId, owner, signal), signal), RuntimeSync: 'synced' };
      }
      if (action === 'ListSessions') {
        const page = request.Page ?? 1, size = request.PageSize ?? 20;
        if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 1000) throw runtimeError('RUNTIME_SESSION_PAGE_INVALID');
        const rows = (await registry.list()).filter(item => item.owner === owner.digest && item.phase === 'ready');
        const payloads = await Promise.all(rows.map(record => sessionPayload(record, signal)));
        payloads.sort((a, b) => b.UpdatedAt.localeCompare(a.UpdatedAt) || a.SessionId.localeCompare(b.SessionId));
        return { Sessions: payloads.slice((page - 1) * size, page * size), Total: rows.length,
          Page: page, PageSize: size, DataSource: 'runtime', Degraded: false, SessionContractVersion: 2 };
      }
      if (action === 'DeleteSession') return registry.serial(request.SessionId, async () => {
        const record = await registry.read(request.SessionId);
        if (!record || record.owner !== owner.digest) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
        if (record.phase === 'deleted') return { Deleted: true, RuntimeSync: 'synced', RetainedNativeHistory: true };
        retiring.add(record.nativeSessionId);
        await registry.write({ ...record, phase: 'deleting' });
        cancelSession(record.nativeSessionId);
        controller.cancel({ sessionId: record.nativeSessionId });
        await settle(record.nativeSessionId);
        await registry.write({ ...record, phase: 'deleted' });
        return { Deleted: true, RuntimeSync: 'synced', RetainedNativeHistory: true };
      });
      const record = await requireSession(request.SessionId, owner);
      if (action === 'SubmitInteraction') {
        if (typeof request.RunId !== 'string' || typeof request.InteractionId !== 'string'
          || typeof request.Action !== 'string' || !Number.isSafeInteger(request.ExpectedRevision)
          || typeof request.IdempotencyKey !== 'string' || !request.IdempotencyKey || request.IdempotencyKey.length > 256
          || (request.Response !== undefined && (typeof request.Response !== 'object' || request.Response === null || Array.isArray(request.Response)))) {
          throw runtimeError('RUNTIME_ACTION_INPUT_UNSUPPORTED');
        }
        if (!approval) throw runtimeError('RUNTIME_INTERACTION_UNAVAILABLE', 409);
        return approval.resolve({ sessionId: record.sessionId, nativeSessionId: record.nativeSessionId,
          runId: request.RunId, interactionId: request.InteractionId, expectedRevision: request.ExpectedRevision,
          action: request.Action, response: request.Response, idempotencyKey: request.IdempotencyKey });
      }
      if (action === 'CancelRun') {
        if (!managedSessionKey(request.InvocationId)) throw runtimeError('RUNTIME_REQUEST_ID_INVALID');
        const parsed = responses.parse({ input: 'cancellation', session_id: record.sessionId, request_id: request.InvocationId }, {}, { principal: owner.key });
        if (request.ResponseId && request.ResponseId !== parsed.responseId) throw runtimeError('RUNTIME_RUN_NOT_ACTIVE', 404);
        if (!cancelRun(parsed.runId, record.nativeSessionId, owner.digest)) throw runtimeError('RUNTIME_RUN_NOT_ACTIVE', 404);
        return { SessionId: record.sessionId, InvocationId: request.InvocationId, Cancelled: true, CancellationRequested: true };
      }
      if (action === 'GetSession') return { Session: await sessionPayload(record, signal) };
      if (action === 'ListSessionMessages') return history(record, request, signal);
      if (action === 'ListSessionEvents') {
        if ((request.EventOrder === 'session_seq' && request.Offset !== undefined && request.Offset !== 0) || (request.EventOrder && request.EventOrder !== 'session_seq')
          || (request.CheckpointIds !== undefined && (!Array.isArray(request.CheckpointIds) || request.CheckpointIds.length))
          || (request.EventTypes !== undefined && (!Array.isArray(request.EventTypes) || request.EventTypes.some(type => typeof type !== 'string')))) throw runtimeError('RUNTIME_HISTORY_INPUT_UNSUPPORTED');
        return history(record, request, signal, true);
      }
      throw runtimeError('RUNTIME_ACTION_UNSUPPORTED', 404);
    },
    flushRun: input => flush(input.sessionId),
    settleRun: input => settle(input.sessionId),
  };
}
