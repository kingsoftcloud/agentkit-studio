import { canonical, configure, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeConversationPrefixSeed } from '../../providers/native-conversation-fork.mjs';
import { conversationDigest, nativeConversationRewindMarkers, NATIVE_CONVERSATION_REWIND_SOURCE } from '../../providers/native-conversation-rewind.mjs';
import { readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
export function validateNativeConversationRequest(request, rewind = false) {
  const keys = ['agentId', 'sessionId', ...(rewind ? ['expectedHeadRunId', 'targetMessageId', 'commandId', 'expectedGeneration'] : [])];
  invariant(request && !Array.isArray(request) && Object.keys(request).sort().join(',') === keys.sort().join(',')
    && keys.filter(key => key !== 'expectedGeneration').every(key => text(request[key]))
    && (!rewind || Number.isSafeInteger(request.expectedGeneration) && request.expectedGeneration >= 0), 'STUDIO_NATIVE_CONVERSATION_INVALID');
}

/** The Session's append-only replacement is the branch commit. Its data-only
 * seed is frozen before the next Run; the old Native ledger is never truncated. */
export function createStudioNativeConversation({ ctx, store, workspaceId, lifetime, agentEvents }) {
  const inspect = async (request, signal) => {
    signal.throwIfAborted();
    const found = await ctx.get('sessionController').resolveAgent(request.sessionId);
    signal.throwIfAborted(); if (found.error) throw found.error;
    const agent = found.agent, session = agent?.session;
    invariant(session?.id === request.sessionId && typeof session.snapshotEvents === 'function'
      && Array.isArray(session.surface?.nodes) && ctx.get('agents')?.get?.(agent.id) === agent,
    'studio_native_conversation_session_unavailable');
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    const head = store.sessionHead(scope, request.sessionId);
    if (!head) return { agent, session, scope, record: null };
    const record = store.load(scope, head.runId), capsule = readNativeRecoveryBinding(record,
      { ...request, runId: head.runId });
    const preset = ctx.get('sessionProjections')?.stateOf(session, 'agentPreset');
    invariant(text(preset) && typeof agentEvents === 'function', 'studio_native_conversation_preset_unavailable');
    const binding = await agentEvents(ctx, agent).serial('agentkit/native-recovery-binding', {});
    signal.throwIfAborted(); assertNativeRecoveryPreset(capsule, binding);
    invariant(agent.session === session && ctx.get('agents')?.get?.(agent.id) === agent
      && ctx.get('sessionProjections').stateOf(session, 'agentPreset') === preset
      && store.sessionHead(scope, request.sessionId)?.runId === head.runId, 'studio_native_conversation_changed');
    const refreshed = store.load(scope, head.runId);
    invariant(canonical(refreshed.configuration) === canonical(record.configuration), 'studio_native_conversation_changed');
    return { agent, session, scope, record: refreshed };
  };
  const selection = session => {
    const events = session.snapshotEvents(), nodes = [...session.surface.nodes];
    const inputs = nodes.map(seq => events[seq]).filter(event => event?.type === 'user/message'
      && ['user', 'user-rpc'].includes(event.data.source?.kind));
    return { events, nodes, inputs, markers: nativeConversationRewindMarkers(events)
      .filter(event => event.data.source.nativeRewind.sessionId === String(session.id) && session.isOwnSeq(event.seq)) };
  };
  const safe = ({ agent, record }) => Boolean(record && !record.configuration.childOwnerBinding
    && (!record.lease || record.lease.expiresAt <= Date.now()) && agent.status === 'idle' && !agent.externalTurns?.pending()
    && terminal(record.snapshot.phase) && record.snapshot.phase !== 'interrupted'
    && !record.intents.some(intent => intent.status === 'running'
      && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey && receipt.status === 'committed'))
    && !record.receipts.some(receipt => receipt.status === 'uncertain'
      || receipt.result.results?.some(result => result.status === 'uncertain'))
    && record.snapshot.children.every(child => ['completed', 'failed', 'canceled'].includes(child.state))
    && record.snapshot.backgroundCommands.every(command => command.notified));
  const response = (request, marker) => ({ contract: 'agentkit.studio-native-conversation-rewind/v1',
    agentId: request.agentId, sessionId: request.sessionId, commandId: marker.commandId,
    generation: marker.generation, state: 'applied', surfacePersisted: true });
  const status = async (request, callerSignal) => {
    validateNativeConversationRequest(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const current = await inspect(request, signal), selected = selection(current.session);
    return { contract: 'agentkit.studio-native-conversation/v1', agentId: request.agentId, sessionId: request.sessionId,
      headRunId: current.record?.snapshot.runId ?? null, generation: selected.markers.at(-1)?.data.source.nativeRewind.generation ?? 0,
      canRewind: safe(current), inputs: selected.inputs.slice(-64).map(event => ({ messageId: event.data.id,
        text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 240) || '附件输入' })) };
  };
  const rewind = async (request, callerSignal) => {
    validateNativeConversationRequest(request, true); const original = copy(request), bytes = canonical(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const current = await inspect(original, signal), { agent, session, scope, record } = current;
    const selected = selection(session), previous = selected.markers.find(event => event.data.source.nativeRewind.commandId === original.commandId);
    if (previous) {
      invariant(previous.data.source.nativeRewind.requestDigest === conversationDigest(original), 'command_replay_conflict');
      invariant(await ctx.get('sessions').flush(session) === true, 'native_conversation_rewind_not_durable');
      return response(original, previous.data.source.nativeRewind);
    }
    invariant(safe(current), 'studio_native_conversation_rewind_requires_idle');
    invariant(record.snapshot.runId === original.expectedHeadRunId
      && (selected.markers.at(-1)?.data.source.nativeRewind.generation ?? 0) === original.expectedGeneration,
    'native_conversation_rewind_head_conflict');
    const target = selected.inputs.find(event => event.data.id === original.targetMessageId);
    invariant(target, 'native_conversation_rewind_target_not_active');
    const removed = selected.nodes.slice(selected.nodes.indexOf(target.seq));
    const seed = nativeConversationPrefixSeed({ store, scope, profile: record.configuration.profile,
      tools: record.configuration.tools, policies: record.configuration, prefix: selected.events.slice(0, target.seq),
      sourceEvents: selected.events, identityNamespace: `rewind:${original.commandId}`, parentSessionId: original.sessionId });
    const marker = { contract: 'native-conversation-rewind/v1', commandId: original.commandId, sessionId: original.sessionId,
      expectedHeadRunId: original.expectedHeadRunId, targetMessageId: original.targetMessageId,
      generation: original.expectedGeneration + 1, requestDigest: conversationDigest(original), seed };
    // Validate the data-only seed against the actual admitted tool/policy set.
    configure({ ...record.configuration, conversationSeed: seed, conversationRewind: { contract: marker.contract,
      commandId: marker.commandId, expectedHeadRunId: marker.expectedHeadRunId, generation: marker.generation, markerDigest: conversationDigest(marker) } });
    signal.throwIfAborted();
    invariant(canonical(request) === bytes && agent.session === session && ctx.get('agents')?.get?.(agent.id) === agent && safe(current)
      && canonical(session.snapshotEvents()) === canonical(selected.events)
      && store.sessionHead(scope, original.sessionId)?.runId === original.expectedHeadRunId, 'studio_native_conversation_changed');
    session.append('user/message', { id: `ak-native-rewind-${conversationDigest(original)}`, role: 'user',
      source: { kind: NATIVE_CONVERSATION_REWIND_SOURCE, form: 'notice', summary: '已回退对话，工作区文件保留', nativeRewind: marker },
      content: [{ type: 'text', text: '对话已回退到所选输入之前。工作区文件保留当前状态；继续修改前请重新读取相关文件。' }] },
    { surfaceOp: { op: 'replace', startSeq: removed[0], endSeq: removed.at(-1) }, sourceEventSeqs: removed });
    invariant(await ctx.get('sessions').flush(session) === true, 'native_conversation_rewind_not_durable');
    return response(original, marker);
  };
  return { status, rewind };
}
