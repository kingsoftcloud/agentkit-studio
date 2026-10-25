import { canonical, configure, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeConversationPrefixSeed } from '../../providers/native-conversation-fork.mjs';
import { conversationDigest, nativeConversationRewindMarkers, NATIVE_CONVERSATION_REWIND_SOURCE } from '../../providers/native-conversation-rewind.mjs';
import { readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
export function validateNativeConversationRequest(request, rewind = false) {
  const keys = ['agentId', 'sessionId', ...(rewind ? ['expectedHeadRunId', 'targetMessageId', 'commandId', 'expectedGeneration'] : [])];
  invariant(request && !Array.isArray(request) && Object.keys(request).sort().join(',') === keys.sort().join(',')
    && keys.filter(key => key !== 'expectedGeneration').every(key => text(request[key]))
    && (!rewind || Number.isSafeInteger(request.expectedGeneration) && request.expectedGeneration >= 0), 'STUDIO_NATIVE_CONVERSATION_INVALID');
}

/** The Session's append-only replacement is the branch commit. Its data-only
 * seed is frozen before the next Run; the old Native ledger is never truncated. */
export function createStudioNativeConversation({ ctx, store, workspaceId, lifetime, agentEvents, activeControl = () => null,
  stopTimeoutMs = 30_000 }) {
  invariant(Number.isSafeInteger(stopTimeoutMs) && stopTimeoutMs > 0 && stopTimeoutMs <= 90_000,
    'studio_native_conversation_stop_timeout_invalid');
  const pending = new Map();
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
      && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey
        && (['committed', 'not_dispatched'].includes(receipt.status) || intent.kind === 'model' && receipt.status === 'uncertain')))
    // A canceled provider request may have unknown usage, but cannot have
    // dispatched tools. Preserve its receipt; never forgive an unknown effect.
    && !record.receipts.some(receipt => receipt.status === 'uncertain'
      && record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind !== 'model'
      || receipt.result.results?.some(result => result.status === 'uncertain'))
    && record.snapshot.children.every(child => ['completed', 'failed', 'canceled'].includes(child.state))
    && record.snapshot.childBudgetReservations.every(item => item.settledUsageDigest !== null)
    && !['effect_outcome_unknown', 'child_owner_unavailable'].includes(record.snapshot.reason)
    && record.snapshot.backgroundCommands.every(command => command.notified));
  const control = ({ agent, session, scope, record }) => {
    const live = record && activeControl({ agentId: scope.agentId, sessionId: session.id });
    return live && !record.configuration.childOwnerBinding && agent.status === 'running'
      && live.runId === record.snapshot.runId && live.sessionId === session.id
      && canonical(live.scope) === canonical(scope) && (!live.store || live.store === store)
      && typeof live.kernel?.submit === 'function' && typeof agent.cancel === 'function'
      && typeof agent.whenIdle === 'function' ? live : null;
  };
  const response = (request, marker) => ({ contract: 'agentkit.studio-native-conversation-rewind/v1',
    agentId: request.agentId, sessionId: request.sessionId, commandId: marker.commandId,
    generation: marker.generation, state: 'applied', surfacePersisted: true });
  const status = async (request, callerSignal) => {
    validateNativeConversationRequest(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const current = await inspect(request, signal), selected = selection(current.session);
    return { contract: 'agentkit.studio-native-conversation/v1', agentId: request.agentId, sessionId: request.sessionId,
      headRunId: current.record?.snapshot.runId ?? null, generation: selected.markers.at(-1)?.data.source.nativeRewind.generation ?? 0,
      canRewind: safe(current) || Boolean(control(current)), requiresStop: Boolean(control(current)),
      inputs: selected.inputs.slice(-64).map(event => ({ messageId: event.data.id,
        text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 240) || '附件输入' })) };
  };
  const apply = async (request, original, callerSignal) => {
    const bytes = canonical(original);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    let current = await inspect(original, signal);
    const { agent, session, scope, record } = current;
    let selected = selection(session);
    const previous = selected.markers.find(event => event.data.source.nativeRewind.commandId === original.commandId);
    if (previous) {
      invariant(previous.data.source.nativeRewind.requestDigest === conversationDigest(original), 'command_replay_conflict');
      invariant(await ctx.get('sessions').flush(session) === true, 'native_conversation_rewind_not_durable');
      return response(original, previous.data.source.nativeRewind);
    }
    invariant(record?.snapshot.runId === original.expectedHeadRunId
      && (selected.markers.at(-1)?.data.source.nativeRewind.generation ?? 0) === original.expectedGeneration,
    'native_conversation_rewind_head_conflict');
    const target = selected.inputs.find(event => event.data.id === original.targetMessageId);
    invariant(target, 'native_conversation_rewind_target_not_active');
    const cancel = { commandId: `native-rewind-cancel-${conversationDigest({ sessionId: original.sessionId, commandId: original.commandId })}`,
      kind: 'cancel', payload: { dshCancelReason: { kind: 'user' }, nativeConversationRewindRequestDigest: conversationDigest(original) } };
    const previousCancel = record.commands.find(row => row.command.commandId === cancel.commandId);
    invariant(!previousCancel || canonical(previousCancel.command) === canonical(cancel), 'command_replay_conflict');
    const seed = nativeConversationPrefixSeed({ store, scope, profile: record.configuration.profile,
      tools: record.configuration.tools, policies: record.configuration, prefix: selected.events.slice(0, target.seq),
      sourceEvents: selected.events, identityNamespace: `rewind:${original.commandId}`, parentSessionId: original.sessionId });
    const marker = { contract: 'native-conversation-rewind/v1', commandId: original.commandId, sessionId: original.sessionId,
      expectedHeadRunId: original.expectedHeadRunId, targetMessageId: original.targetMessageId,
      generation: original.expectedGeneration + 1, requestDigest: conversationDigest(original), seed };
    // Validate the data-only seed against the actual admitted tool/policy set.
    configure({ ...record.configuration, conversationSeed: seed, conversationRewind: { contract: marker.contract,
      commandId: marker.commandId, expectedHeadRunId: marker.expectedHeadRunId, generation: marker.generation, markerDigest: conversationDigest(marker) } });
    invariant(canonical(request) === bytes, 'studio_native_conversation_changed');
    if (!safe(current)) {
      const live = control(current);
      invariant(live, 'studio_native_conversation_rewind_requires_idle');
      live.assertCurrent?.(); signal.throwIfAborted();
      // Persist with the real executor before aborting the host owner. No
      // replacement driver, lease stealing, or public caller-supplied ports.
      if (!terminal(record.snapshot.phase)) {
        invariant(live.kernel.submit(scope, record.snapshot.runId, cancel).status !== 'rejected', 'native_conversation_rewind_cancel_rejected');
        live.wake?.(); agent.cancel({ kind: 'user' });
      }
      await awaitA2aControl(() => agent.whenIdle(), AbortSignal.any([signal, AbortSignal.timeout(stopTimeoutMs)]));
      current = await inspect(original, signal);
      invariant(current.agent === agent && current.session === session
        && current.record?.snapshot.runId === original.expectedHeadRunId, 'native_conversation_rewind_head_conflict');
      const settled = selection(session);
      invariant(canonical(selected.events.slice(0, target.seq)) === canonical(settled.events.slice(0, target.seq))
        && canonical(selected.nodes.filter(seq => seq < target.seq)) === canonical(settled.nodes.filter(seq => seq < target.seq))
        && canonical(selected.inputs.map(event => event.data.id)) === canonical(settled.inputs.map(event => event.data.id))
        && (settled.markers.at(-1)?.data.source.nativeRewind.generation ?? 0) === original.expectedGeneration,
      'studio_native_conversation_changed');
      selected = settled;
      invariant(safe(current), 'native_conversation_rewind_stop_unsettled');
    }
    const removed = selected.nodes.slice(selected.nodes.indexOf(target.seq));
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
  const rewind = async (request, callerSignal) => {
    validateNativeConversationRequest(request, true);
    const original = copy(request), bytes = canonical(original), key = canonical({ agentId: original.agentId, sessionId: original.sessionId });
    const existing = pending.get(key);
    if (existing) {
      invariant(existing.bytes === bytes, existing.commandId === original.commandId ? 'command_replay_conflict' : 'native_conversation_rewind_in_progress');
      return awaitA2aControl(() => existing.promise, AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]));
    }
    const entry = { bytes, commandId: original.commandId };
    entry.promise = apply(request, original, callerSignal).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    pending.set(key, entry);
    return entry.promise;
  };
  return { status, rewind };
}
