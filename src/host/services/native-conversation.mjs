import { canonical, configure, copy, invariant, terminal } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeConversationPrefixSeed } from '../../providers/native-conversation-fork.mjs';
import { conversationDigest, nativeConversationRewindMarkers, NATIVE_CONVERSATION_REWIND_SOURCE } from '../../providers/native-conversation-rewind.mjs';
import { readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';
import { awaitA2aControl } from '../../providers/native-a2a-controls.mjs';
import { nativeConversationRetainedCommands } from '../../providers/native-conversation-tasks.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 256;
export function validateNativeConversationRequest(request, rewind = false) {
  const keys = ['agentId', 'sessionId', ...(rewind ? ['expectedHeadRunId', 'targetMessageId', 'commandId', 'expectedGeneration'] : [])];
  const both = request?.scope === 'both';
  if (both && rewind) keys.push('scope', ...(rewind === 'preview' ? [] : ['workspacePreviewToken']));
  invariant(request && !Array.isArray(request) && Object.keys(request).sort().join(',') === keys.sort().join(',')
    && keys.filter(key => key !== 'expectedGeneration').every(key => text(request[key]))
    && (!rewind || Number.isSafeInteger(request.expectedGeneration) && request.expectedGeneration >= 0)
    && (rewind !== 'preview' || both)
    && (!both || rewind === 'preview' || /^[a-f0-9]{64}$/.test(request.workspacePreviewToken)), 'STUDIO_NATIVE_CONVERSATION_INVALID');
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
    return { agent, session, scope, record: refreshed, binding };
  };
  const selection = session => {
    const events = session.snapshotEvents(), nodes = [...session.surface.nodes];
    const inputs = nodes.map(seq => events[seq]).filter(event => event?.type === 'user/message'
      && ['user', 'user-rpc'].includes(event.data.source?.kind));
    return { events, nodes, inputs, markers: nativeConversationRewindMarkers(events)
      .filter(event => event.data.source.nativeRewind.sessionId === String(session.id) && session.isOwnSeq(event.seq)) };
  };
  const safe = ({ agent, record }, commandsSettled = false) => Boolean(record && !record.configuration.childOwnerBinding
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
    && (commandsSettled || record.snapshot.backgroundCommands.every(command => command.notified)));
  const canCleanCommands = current => current.binding?.nativeTools?.commandBinding?.backend === 'local_process'
    && typeof current.binding?.nativeTools?.conversationCommands === 'function';
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
    generation: marker.generation, state: 'applied', surfacePersisted: true,
    ...(marker.workspaceCleanup ? { workspaceCleanup: copy(marker.workspaceCleanup) } : {}) });
  const status = async (request, callerSignal) => {
    validateNativeConversationRequest(request);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    const current = await inspect(request, signal), selected = selection(current.session);
    const canRewind = safe(current) || safe(current, true) && canCleanCommands(current) || Boolean(control(current));
    const recovery = current.binding.nativeTools?.conversationWorkspaceRecovery?.(current.agent);
    return { contract: 'agentkit.studio-native-conversation/v1', agentId: request.agentId, sessionId: request.sessionId,
      headRunId: current.record?.snapshot.runId ?? null, generation: selected.markers.at(-1)?.data.source.nativeRewind.generation ?? 0,
      canRewind, canRewindWorkspace: Boolean(canRewind && typeof current.binding?.nativeTools?.conversationWorkspace === 'function'),
      ...(recovery ? { workspaceRecovery: { agentId: request.agentId, sessionId: request.sessionId, scope: 'both',
        commandId: recovery.commandId, targetMessageId: recovery.targetMessageId, expectedHeadRunId: recovery.expectedHeadRunId,
        expectedGeneration: recovery.expectedGeneration, workspacePreviewToken: recovery.workspacePreviewToken } } : {}),
      requiresStop: Boolean(canRewind && (control(current)
        || canCleanCommands(current) && current.record.snapshot.backgroundCommands.some(row => !row.notified))),
      inputs: selected.inputs.slice(-64).map(event => ({ messageId: event.data.id,
        text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 240) || '附件输入' })) };
  };
  const apply = async (request, original, callerSignal, previewOnly = false) => {
    const bytes = canonical(original);
    const signal = AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
    let current = await inspect(original, signal);
    const workspaceRecovery = current.binding.nativeTools?.conversationWorkspaceRecovery?.(current.agent);
    invariant(!workspaceRecovery || workspaceRecovery.commandId === original.commandId, 'studio_native_workspace_control_recovery_required');
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
    const { workspacePreviewToken: _previewToken, ...cancelIdentity } = original;
    const cancel = { commandId: `native-rewind-cancel-${conversationDigest({ sessionId: original.sessionId, commandId: original.commandId })}`,
      kind: 'cancel', payload: { dshCancelReason: { kind: 'user' }, nativeConversationRewindRequestDigest: conversationDigest(cancelIdentity) } };
    const previousCancel = record.commands.find(row => row.command.commandId === cancel.commandId);
    invariant(!previousCancel || canonical(previousCancel.command) === canonical(cancel), 'command_replay_conflict');
    let seed = nativeConversationPrefixSeed({ store, scope, profile: record.configuration.profile,
      tools: record.configuration.tools, policies: record.configuration, prefix: selected.events.slice(0, target.seq),
      sourceEvents: selected.events, identityNamespace: `rewind:${original.commandId}`, parentSessionId: original.sessionId });
    const marker = { contract: 'native-conversation-rewind/v1', commandId: original.commandId, sessionId: original.sessionId,
      expectedHeadRunId: original.expectedHeadRunId, targetMessageId: original.targetMessageId,
      generation: original.expectedGeneration + 1, requestDigest: conversationDigest(original), seed };
    // Validate the data-only seed against the actual admitted tool/policy set.
    configure({ ...record.configuration, conversationSeed: seed, conversationRewind: { contract: marker.contract,
      commandId: marker.commandId, expectedHeadRunId: marker.expectedHeadRunId, generation: marker.generation, markerDigest: conversationDigest(marker) } });
    invariant(canonical(request) === bytes, 'studio_native_conversation_changed');
    if (!safe(current, true)) {
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
      invariant(safe(current, true), 'native_conversation_rewind_stop_unsettled');
    }
    if (original.scope === 'both') {
      seed = nativeConversationPrefixSeed({ store, scope, profile: current.record.configuration.profile,
        tools: current.record.configuration.tools, policies: current.record.configuration, prefix: selected.events.slice(0, target.seq),
        sourceEvents: selected.events, identityNamespace: `rewind:${original.commandId}`, parentSessionId: original.sessionId });
      marker.seed = seed;
    }
    const cleanup = current.record.snapshot.backgroundCommands.length > 0 && canCleanCommands(current);
    const publish = async publishSignal => {
      const frozen = canonical(current.record), frozenEvents = canonical(selected.events);
      const cleanupSignal = AbortSignal.any([publishSignal, AbortSignal.timeout(stopTimeoutMs)]);
      const assertCurrent = () => {
        cleanupSignal.throwIfAborted();
        invariant(canonical(request) === bytes && agent.session === session && ctx.get('agents')?.get?.(agent.id) === agent
          && safe(current, true) && canonical(session.snapshotEvents()) === frozenEvents
          && store.sessionHead(scope, original.sessionId)?.runId === original.expectedHeadRunId
          && canonical(store.load(scope, original.expectedHeadRunId)) === frozen, 'studio_native_conversation_changed');
        return true;
      };
      if (cleanup) {
        const retainedRefs = nativeConversationRetainedCommands({ store, scope, record: current.record, seed,
          prefix: selected.events.slice(0, target.seq), sourceEvents: selected.events });
        const commands = current.binding.nativeTools.conversationCommands(agent, { scope, store });
        invariant(commands?.contract === 'agentkit.native-conversation-command-control/v1'
          && typeof commands.settle === 'function', 'native_conversation_command_control_unavailable');
        marker.commandCleanup = await awaitA2aControl(() => commands.settle({ record: current.record, retainedRefs,
          requestDigest: marker.requestDigest, signal: cleanupSignal, assertCurrent }), cleanupSignal);
        assertCurrent();
        invariant(marker.commandCleanup?.contract === commands.contract && marker.commandCleanup.requestDigest === marker.requestDigest
          && canonical(marker.commandCleanup.retained.map(row => row.ref)) === canonical(retainedRefs)
          && marker.commandCleanup.retained.every(row => current.record.snapshot.backgroundCommands.some(original => canonical(original) === canonical(row)))
          && canonical(marker.commandCleanup.stopped.map(row => row.ref)) === canonical(current.record.snapshot.backgroundCommands
            .filter(row => !retainedRefs.some(ref => canonical(ref) === canonical(row.ref))).map(row => row.ref))
          && marker.commandCleanup.stopped.every(row => ['completed', 'failed', 'canceled', 'timed_out', 'output_limit'].includes(row.status)),
        'native_conversation_command_cleanup_invalid');
        configure({ ...record.configuration, conversationSeed: seed, conversationRewind: { contract: marker.contract,
          commandId: marker.commandId, expectedHeadRunId: marker.expectedHeadRunId, generation: marker.generation,
          markerDigest: conversationDigest(marker), retainedBackgroundCommands: marker.commandCleanup.retained } });
      }
      const commandsSettled = Boolean(marker.commandCleanup);
      invariant(safe(current, commandsSettled), 'native_conversation_rewind_stop_unsettled');
      if (original.scope === 'both') {
        assertCurrent();
        const workspace = current.binding.nativeTools.conversationWorkspace?.(agent, { scope, store });
        invariant(workspace, 'native_conversation_workspace_control_unavailable');
        const { workspacePreviewToken, ...identity } = original;
        const operation = { ...identity, scope: copy(scope), contract: 'agentkit.native-conversation-workspace-control/v1',
          requestDigest: marker.requestDigest, sourceDigest: conversationDigest(current.record),
          selectionDigest: conversationDigest({ seed, prefix: selected.events.slice(0, target.seq) }),
          ...(workspacePreviewToken ? { workspacePreviewToken } : {}) };
        const options = { signal: cleanupSignal, assertCurrent, record: current.record, seed,
          prefix: selected.events.slice(0, target.seq), sourceEvents: selected.events };
        if (previewOnly) return workspace.preview(operation, options);
        marker.workspaceCleanup = workspace.apply(operation, options); assertCurrent();
        invariant(marker.workspaceCleanup?.contract === operation.contract && marker.workspaceCleanup.requestDigest === marker.requestDigest,
          'native_conversation_workspace_cleanup_invalid');
      }
      const removed = selected.nodes.slice(selected.nodes.indexOf(target.seq));
      publishSignal.throwIfAborted();
      invariant(canonical(request) === bytes && agent.session === session && ctx.get('agents')?.get?.(agent.id) === agent && safe(current, commandsSettled)
        && canonical(session.snapshotEvents()) === canonical(selected.events)
        && store.sessionHead(scope, original.sessionId)?.runId === original.expectedHeadRunId, 'studio_native_conversation_changed');
      session.append('user/message', { id: `ak-native-rewind-${conversationDigest(original)}`, role: 'user',
        source: { kind: NATIVE_CONVERSATION_REWIND_SOURCE, form: 'notice', summary: original.scope === 'both' ? '已回退对话和文件' : '已回退对话，工作区文件保留', nativeRewind: marker },
        content: [{ type: 'text', text: original.scope === 'both' ? '对话和文件已回退到所选输入之前；继续修改前请重新读取相关文件。'
          : '对话已回退到所选输入之前。工作区文件保留当前状态；继续修改前请重新读取相关文件。' }] },
      { surfaceOp: { op: 'replace', startSeq: removed[0], endSeq: removed.at(-1) }, sourceEventSeqs: removed });
      invariant(await ctx.get('sessions').flush(session) === true, 'native_conversation_rewind_not_durable');
      return response(original, marker);
    };
    if (cleanup || original.scope === 'both') {
      invariant(typeof agent.runMaintenance === 'function', 'native_conversation_command_maintenance_unavailable');
      return agent.runMaintenance(maintenanceSignal => publish(AbortSignal.any([signal, maintenanceSignal])));
    }
    return publish(signal);
  };
  const rewind = async (request, callerSignal, previewOnly = false) => {
    validateNativeConversationRequest(request, previewOnly ? 'preview' : true);
    const original = copy(request), bytes = canonical(original), key = canonical({ agentId: original.agentId, sessionId: original.sessionId });
    const existing = pending.get(key);
    if (existing) {
      invariant(existing.bytes === bytes, existing.commandId === original.commandId ? 'command_replay_conflict' : 'native_conversation_rewind_in_progress');
      return awaitA2aControl(() => existing.promise, AbortSignal.any([lifetime.signal, ...(callerSignal ? [callerSignal] : [])]));
    }
    const entry = { bytes, commandId: original.commandId };
    entry.promise = apply(request, original, callerSignal, previewOnly).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    pending.set(key, entry);
    return entry.promise;
  };
  return { status, rewind, previewWorkspace: (request, signal) => rewind(request, signal, true),
    isRewinding: request => pending.has(canonical({ agentId: request.agentId, sessionId: request.sessionId })) };
}
