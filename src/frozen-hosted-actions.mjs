/** Existing AgentEngine Actions projected over the frozen Host's native DSH sessions. */
import { createHash, createHmac } from 'node:crypto';
import { runtimeError } from './runtime-responses-contract.mjs';
import { displayEvents } from './assistant-history.mjs';
import { readFrozenSessionMessages, readFrozenSessionEvents } from './frozen-session-history.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const identityHeaders = ['x-agentengine-identity-namespace', 'x-agentengine-business-tenant-id', 'x-agentengine-subject-type', 'x-agentengine-subject-id'];
export function frozenHostedPrincipal(headers) {
  const values = identityHeaders.map(key => headers[key]);
  if (values.some(value => typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value))) throw runtimeError('RUNTIME_TRUSTED_IDENTITY_REQUIRED', 401);
  return createHash('sha256').update(JSON.stringify(values.map(value => value.trim()))).digest('hex');
}
export function createFrozenHostedActions({ ctx, agentId, buildId, token, frozen, admit, model, models, bundleSha256, responses }) {
  const controller = ctx.get('sessionController');
  const scoped = (id, headers) => {
    if (!identifier(id)) throw runtimeError('RUNTIME_SESSION_ID_INVALID');
    return responses.parse({ input: 'session lookup', session_id: id, request_id: 'session-lookup', user: frozenHostedPrincipal(headers), account_id: 'hosted-v1' });
  };
  async function flush(id) {
    const sessions = ctx.get('sessions'), live = sessions?.get(id);
    if (live && !await sessions.flush(live)) throw runtimeError('RUNTIME_SESSION_PERSISTENCE_REQUIRED', 503);
  }
  async function ensure(id) {
    if (!await controller.projections({ sessionId: id }, AbortSignal.timeout(10000))) await ctx.get('agents').withoutInitiator(async () => {
      const admission = await admit(agentId, frozen);
      await controller.create({ sessionId: id, agentPreset: admission.presetId });
      if (admission.modelSelection) await controller.selectModel({ sessionId: id, ...admission.modelSelection, saveDefault: false });
    });
    await flush(id);
  }
  async function observe(publicId, headers, signal) {
    const nativeId = scoped(publicId, headers).sessionId;
    await flush(nativeId);
    // observeSession restores the same cold view as DSH, including interrupted-turn closers.
    let observation;
    try { observation = await ctx.get('sessionQuery').observeSession(nativeId, { signal, projectionMode: 'none' }); }
    catch (error) {
      if (['SESSION_QUERY_SESSION_NOT_FOUND', 'session/not-found', 'session/not_found', 'ENOENT'].includes(error?.code)) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
      throw error;
    }
    if (!observation) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
    return { nativeId, observation };
  }
  async function history(request, headers, signal, events) {
    const { nativeId, observation } = await observe(request.SessionId, headers, signal);
    try {
      const epoch = createHmac('sha256', token).update(JSON.stringify([buildId, nativeId, observation.header.createdAt])).digest('hex');
      const mappings = new Map(observation.events.filter(event => event.type === 'studio/hosted-request').map(event => [event.data.runId, event.data.invocationId]));
      const requestsByStart = new Map(); let start;
      for (const event of observation.events) {
        if (event.type === 'turn/start') start = event.seq + 1;
        if (start !== undefined && event.type === 'user/message' && event.data?.source?.rpcId && !requestsByStart.has(start)) requestsByStart.set(start, event.data.source.rpcId);
      }
      const safeEvents = displayEvents(observation.events);
      // Preserve native seq positions: hidden internal facts remain empty entries in a bounded slice.
      const safe = new Map(safeEvents.map(event => [event.seq, event]));
      const handle = { read: async (offset, length) => ({ events: observation.events.slice(offset, offset + length).map(event => safe.get(event.seq) || { seq: event.seq, type: 'internal', data: {} }) }) };
      return await (events ? readFrozenSessionEvents : readFrozenSessionMessages)({ handle,
        session: { sessionId: request.SessionId, nativeSessionId: nativeId, epoch }, latestSeq: observation.cursor + 1,
        request, signal, invocationId: async (_id, run, start) => {
          const nativeRun = run || requestsByStart.get(start);
          return nativeRun ? mappings.get(nativeRun) || nativeRun : null;
        } });
    } finally { observation[Symbol.dispose](); }
  }
  return {
    responsesInput(request, headers) {
      const allowed = ['AgentId', 'SessionId', 'ResponsesInput', 'Messages', 'InvocationId', 'Stream', 'ApiFormat', 'Model', 'Metadata', 'PreviousResponseId'];
      if (!request || Object.keys(request).some(key => !allowed.includes(key)) || request.ApiFormat && request.ApiFormat !== 'responses') throw runtimeError('RUNTIME_RUN_INPUT_UNSUPPORTED');
      if (!identifier(request.SessionId) || !identifier(request.InvocationId)) throw runtimeError('RUNTIME_RUN_INPUT_INVALID');
      const value = responses.parse({ input: request.ResponsesInput ?? request.Messages, session_id: request.SessionId,
        request_id: request.InvocationId, stream: request.Stream, model: request.Model, metadata: request.Metadata,
        previous_response_id: request.PreviousResponseId, user: frozenHostedPrincipal(headers), account_id: 'hosted-v1' });
      return { ...value, publicSessionId: request.SessionId, hosted: true };
    },
    async prepareRun(input) {
      await ensure(input.sessionId);
      const { agent } = await controller.resolveAgent(input.sessionId);
      if (!agent) throw runtimeError('RUNTIME_SESSION_NOT_FOUND', 404);
      if (!agent.session.snapshotEvents().some(event => event.type === 'studio/hosted-request' && event.data.runId === input.runId)) {
        agent.session.append('studio/hosted-request', { runId: input.runId, invocationId: input.requestId }, { ignorable: true });
      }
    },
    flushRun: input => flush(input.sessionId),
    async dispatch(action, request, headers, signal) {
      frozenHostedPrincipal(headers);
      if (action === 'GetAgentUiBootstrap') return { RuntimeIdentity: { format: 'agentkit.runtime-identity/v1', agentId, buildId, bundleSha256 },
        Capabilities: { Attachments: false, Approval: false, Thinking: false, MCP: false, StopRun: false, ResumeRun: false, BackgroundRun: false,
          KernelSessionEvents: false, WorkspaceFiles: false, SlashCommands: ['/new', '/clear', '/help'],
          HostedChat: { Enabled: true, ApiFormats: ['responses'] },
          RunLifecycle: { Enabled: false, Resume: false, Abort: false, Checkpoints: false, CheckpointResume: false },
          NativeDashboard: { Enabled: false }, NativeTerminal: { Enabled: false },
          HistoryRead: { Protocol: 'ksadk.history/v2', SessionContractVersion: 2, SupportsEpoch: true, SupportsSnapshot: true },
          Persistence: { Configured: true, Ready: true, Backend: 'dsh-native-disk', SharedAcrossPods: false } },
        ApiFormats: ['responses'], Model: { id: model }, Models: models.map(id => ({ id, name: id })) };
      if (action === 'ListAgentModels') return { Models: models.map(id => ({ id, name: id, source: 'frozen-build' })), Current: model, Source: 'frozen-build' };
      if (action === 'CreateSession') {
        const parsed = scoped(request.SessionId, headers); await ensure(parsed.sessionId);
        return { Session: { SessionId: request.SessionId, Version: 1 }, RuntimeSync: 'synced' };
      }
      if (action === 'ListSessionMessages') return history(request, headers, signal, false);
      if (action === 'ListSessionEvents') return history(request, headers, signal, true);
      // Directory deletion removes visibility, retaining the existing native transcript.
      if (action === 'DeleteSession') { scoped(request.SessionId, headers); return { Deleted: true, RuntimeSync: 'synced', RetainedNativeHistory: true }; }
      throw runtimeError('RUNTIME_ACTION_UNSUPPORTED', 404);
    },
  };
}
