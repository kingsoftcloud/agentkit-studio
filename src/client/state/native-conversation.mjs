const check = (value, message) => { if (!value) throw Error(message); };

/** Native conversation rewind. A pending rewind keeps its commandId and full payload until confirmed. */
export function createNativeConversationState({ hostRemote, agentId, sessionId, newCommandId = () => globalThis.crypto.randomUUID() }) {
  const identity = { agentId, sessionId }, lifetime = new AbortController(), listeners = new Set();
  let disposed = false, refreshVersion = 0, state = { status: null, loading: false, sending: false, pending: null, preview: null, previewRequest: null, error: '' };
  const set = change => { if (!disposed) { state = { ...state, ...change }; for (const listener of listeners) listener(state); } };
  const validateStatus = value => {
    check(value?.contract === 'agentkit.studio-native-conversation/v1' && value.agentId === agentId && value.sessionId === sessionId
      && (value.headRunId === null || typeof value.headRunId === 'string' && value.headRunId.trim() && value.headRunId.length <= 256)
      && Number.isSafeInteger(value.generation) && value.generation >= 0
      && typeof value.canRewind === 'boolean'
      && (value.canRewindWorkspace === undefined || typeof value.canRewindWorkspace === 'boolean' && (!value.canRewindWorkspace || value.canRewind))
      && (value.requiresStop === undefined || typeof value.requiresStop === 'boolean' && (!value.requiresStop || value.canRewind))
      && (!value.canRewind || typeof value.headRunId === 'string')
      && Array.isArray(value.inputs) && value.inputs.length <= 64
      && new Set(value.inputs.map(input => input?.messageId)).size === value.inputs.length
      && value.inputs.every(input => input && typeof input.messageId === 'string' && input.messageId.trim() && input.messageId.length <= 256
        && typeof input.text === 'string'),
    '对话记录与原会话不一致，请刷新核对。');
    return value;
  };
  const validateRewind = (value, pending) => {
    check(value?.contract === 'agentkit.studio-native-conversation-rewind/v1' && value.agentId === agentId && value.sessionId === sessionId
      && value.commandId === pending.commandId && value.state === 'applied' && value.surfacePersisted === true
      && value.generation === pending.expectedGeneration + 1,
    '回退响应与原请求不一致，请确认后重试。');
    if (pending.scope === 'both') check(value.workspaceCleanup?.contract === 'agentkit.native-conversation-workspace-control/v1'
      && value.workspaceCleanup.previewToken === pending.workspacePreviewToken
      && Array.isArray(value.workspaceCleanup.changedPaths) && value.workspaceCleanup.changedPaths.every(path => typeof path === 'string'),
    '文件回退结果与已确认预览不一致，请重试原请求核实。');
    return value;
  };
  async function refresh() {
    if (disposed || state.loading) return;
    const version = ++refreshVersion;
    set({ loading: true, preview: null, previewRequest: null });
    try {
      const status = validateStatus(await hostRemote.nativeConversationStatus(identity, lifetime.signal));
      if (version === refreshVersion) {
        const recovery = status.workspaceRecovery;
        if (recovery) check(recovery.agentId === agentId && recovery.sessionId === sessionId && recovery.scope === 'both'
          && typeof recovery.commandId === 'string' && typeof recovery.targetMessageId === 'string'
          && typeof recovery.expectedHeadRunId === 'string' && Number.isSafeInteger(recovery.expectedGeneration)
          && /^[a-f0-9]{64}$/.test(recovery.workspacePreviewToken), '文件回退恢复记录无效。');
        set({ status, error: recovery ? '文件回退尚未确认，请重试原请求完成核实或补偿。' : '',
          ...(!state.pending && recovery ? { pending: recovery } : {}) });
      }
    } catch { if (version === refreshVersion) set({ error: '对话状态读取失败，请刷新。' }); }
    finally { if (version === refreshVersion) set({ loading: false }); }
  }
  async function send() {
    if (disposed || state.sending || !state.pending) return;
    const pending = state.pending;
    set({ sending: true, error: '' });
    try {
      validateRewind(await hostRemote.rewindNativeConversation(pending, lifetime.signal), pending);
      ++refreshVersion;
      set({ pending: null, loading: false });
      await refresh();
    } catch (error) {
      if (['native_conversation_rewind_head_conflict', 'native_conversation_rewind_target_not_active',
        'studio_native_conversation_rewind_requires_idle', 'checkpoint_rewind_conflict', 'checkpoint_control_compensated'].includes(error?.code)) {
        // These Host errors are raised before append; a definitive rejection
        // must not trap the panel in retries of an impossible stale request.
        ++refreshVersion; set({ pending: null, loading: false });
        await refresh();
        set({ error: error.code === 'checkpoint_control_compensated'
          ? '未完成的文件回退已补偿，对话未回退。请重新预览后操作。'
          : pending.scope === 'both' ? '对话或文件状态已变化，请核对刷新后的记录并重新预览。'
            : '对话状态已变化，本次回退未执行。请核对刷新后的记录。' });
      } else if (error?.code === 'native_conversation_rewind_stop_unsettled') {
        set({ error: '当前任务已停止，但仍有执行结果或任务待核实，回退尚未提交。处理后可重试原请求。' });
      } else set({ error: pending.scope === 'both'
        ? '组合回退尚未确认，文件可能已恢复。请重试原请求核实，请勿重复发起。'
        : '回退请求尚未确认。可确认原回退请求，请勿重复发起。' });
    }
    finally { set({ sending: false }); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    retry: send,
    async previewWorkspace(messageId) {
      if (disposed || state.pending || state.sending || !state.status?.canRewindWorkspace
        || !state.status.inputs.some(input => input.messageId === messageId)) return;
      const request = { ...identity, expectedHeadRunId: state.status.headRunId, expectedGeneration: state.status.generation,
        targetMessageId: messageId, commandId: newCommandId(), scope: 'both' };
      set({ sending: true, error: '', preview: null, previewRequest: null });
      try {
        const preview = await hostRemote.previewNativeConversationWorkspace(request, lifetime.signal);
        check(preview?.contract === 'agentkit.native-conversation-workspace-control/v1' && /^[a-f0-9]{64}$/.test(preview.previewToken)
          && typeof preview.canApply === 'boolean' && Array.isArray(preview.files) && preview.files.length <= 100
          && preview.files.every(file => typeof file.path === 'string' && ['restore', 'delete'].includes(file.action))
          && Array.isArray(preview.unsafeFiles), '文件回退预览无效，请刷新。');
        set({ preview, previewRequest: request });
      } catch { set({ error: '未获得可确认的文件预览，文件和对话尚未回退；相关任务可能已停止。请刷新核对。' }); }
      finally { set({ sending: false }); }
    },
    confirmWorkspace() {
      if (disposed || state.sending || state.pending || !state.preview?.canApply || !state.previewRequest) return;
      set({ pending: { ...state.previewRequest, workspacePreviewToken: state.preview.previewToken }, preview: null, previewRequest: null });
      return send();
    },
    cancelPreview() { if (!state.sending) set({ preview: null, previewRequest: null }); },
    rewind(messageId) {
      if (disposed || state.pending || state.sending || !state.status?.canRewind) return;
      const target = state.status.inputs.find(input => input.messageId === messageId);
      if (!target) return;
      set({ pending: { ...identity, expectedHeadRunId: state.status.headRunId, expectedGeneration: state.status.generation,
        targetMessageId: messageId, commandId: newCommandId() } });
      return send();
    },
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); },
  };
}
