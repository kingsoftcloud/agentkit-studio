const check = (value, message) => { if (!value) throw Error(message); };
const counters = ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost'];
const optionalCounters = ['cachedInputTokens', 'reasoningTokens'];
const validUsage = usage => usage && typeof usage === 'object' && !Array.isArray(usage)
  && Object.keys(usage).every(key => [...counters, ...optionalCounters].includes(key))
  && [...counters, ...optionalCounters.filter(key => key in usage)].every(key => typeof usage[key] === 'number'
    && Number.isFinite(usage[key]) && usage[key] >= 0 && (key === 'cost' || Number.isSafeInteger(usage[key])));

/** Reads never resume work. A lost response retains the original Run identity. */
export function createNativeRecoveryState({ hostRemote, agentId, sessionId, newCommandId = () => globalThis.crypto.randomUUID() }) {
  const identity = { agentId, sessionId }, lifetime = new AbortController(), listeners = new Set();
  let disposed = false, state = { status: null, loading: false, sending: false, pending: null, error: '' };
  const set = change => { if (!disposed) { state = { ...state, ...change }; for (const listener of listeners) listener(state); } };
  const validate = (value, runId) => {
    check(value?.contract === 'agentkit.studio-native-recovery/v1' && value.agentId === agentId && value.sessionId === sessionId
      && ['available', 'recovering', 'reconciliation_required', 'failed', 'closed'].includes(value.state)
      && typeof value.canResume === 'boolean' && (!value.canResume || typeof value.runId === 'string' && value.runId.trim())
      && (!runId || value.runId === runId), '恢复记录与原会话或运行不一致，请刷新核对。');
    if (value.error != null) check(typeof value.error?.code === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value.error.code)
      && typeof value.error.message === 'string' && value.error.message.length > 0 && value.error.message.length <= 512,
    '运行错误记录无法识别，请刷新核对。');
    if (value.outcome != null) check(['verified', 'unverified', 'partial', 'blocked', 'failed', 'budget_exhausted'].includes(value.outcome), '任务结果状态无法识别，请刷新核对。');
    if (value.verificationRequired !== undefined) check(typeof value.verificationRequired === 'boolean', '任务验证要求无法识别，请刷新核对。');
    if (value.canReviewBackground !== undefined) check(typeof value.canReviewBackground === 'boolean'
      && (!value.canReviewBackground || !value.managed && value.phase === 'interrupted'
        && value.reason === 'effect_outcome_unknown' && Number.isSafeInteger(value.backgroundReviewEventSeq)
        && value.backgroundReviewEventSeq >= 0), '后台操作核对权限无法识别，请刷新核对。');
    if (value.backgroundInterruptionReview !== undefined) {
      const review = value.backgroundInterruptionReview;
      check(review?.contract === 'agentkit.background-interruption-review/v1' && review.confirmedStopped === true
        && typeof review.commandId === 'string' && !!review.commandId.trim() && review.commandId.length <= 256
        && review.eventSeq === value.backgroundReviewEventSeq && value.phase === 'interrupted'
        && value.reason === 'effect_outcome_unknown', '后台操作处置记录无法识别，请刷新核对。');
    }
    if (value.capabilities != null) check(Array.isArray(value.capabilities.toolNames)
      && value.capabilities.toolNames.every(name => typeof name === 'string' && name.length > 0 && name.length <= 256), '能力清单无法识别，请刷新核对。');
    const receiptWait = value.receiptWait;
    if (value.managed !== undefined) check(value.managed?.contract === 'agentkit.studio-managed-native-recovery/v1'
      && value.managed.controlAuthority === 'server' && ['open', 'closed', 'pending'].includes(value.managed.owner)
      && ['accepted', 'settled', 'discarded'].includes(value.managed.commandState)
      && ['queued', 'running', 'idle'].includes(value.managed.executionState)
      && typeof value.managed.commandId === 'string' && value.managed.commandId.trim() && value.managed.commandId.length <= 256
      && typeof value.managed.retryAcceptedCommand === 'boolean'
      && (!value.canResume || value.managed.retryAcceptedCommand) && value.canReconcile === false,
    '托管运行的控制权限与原记录不一致，请刷新核对。');
    const grant = value.managed?.executionGrant;
    if (grant !== undefined) check(grant?.contract === 'agentkit.managed-native-execution-grants/v1'
      && typeof grant.grantId === 'string' && grant.grantId === grant.grantId.trim() && grant.grantId.length > 0 && grant.grantId.length <= 512
      && ['active', 'suspended', 'revoked', 'missing'].includes(grant.state)
      && [grant.revision, grant.admissionRevision].every(revision => grant.state === 'missing' ? revision === null : Number.isSafeInteger(revision) && revision >= 1)
      && (grant.attemptEpoch === null || Number.isSafeInteger(grant.attemptEpoch) && grant.attemptEpoch >= 1)
      && (grant.expiresAt === null || typeof grant.expiresAt === 'string' && Number.isFinite(Date.parse(grant.expiresAt)))
      && typeof grant.admissionAllowed === 'boolean' && typeof grant.qualified === 'boolean'
      && (grant.blockedReason === null || ['not_found', 'scope_mismatch', 'revoked', 'attempt_epoch_mismatch', 'expired',
        'clock_unverified', 'suspended', 'admission_paused'].some(reason => grant.blockedReason === `execution_grant_${reason}`))
      && (!grant.blockedReason || !value.canResume && !value.managed.retryAcceptedCommand),
    '执行授权与原托管运行不一致，请刷新核对。');
    if (value.managed?.commandState === 'discarded') check(value.state === 'closed' && value.phase === 'discarded'
      && !value.canResume && !value.managed.retryAcceptedCommand && value.managed.owner === 'closed'
      && !grant?.qualified, '已丢弃的托管命令不能重新执行。');
    if (receiptWait !== undefined) check(receiptWait?.contract === 'agentkit.native-a2a-receipt-wait/v1'
      && value.phase === 'awaiting_reconciliation'
      && ['operationKey', 'callId'].every(key => typeof receiptWait[key] === 'string' && receiptWait[key].trim()
        && receiptWait[key] === value.reconciliation?.[key]), '回执等待与原运行不一致，请刷新核对。');
    if (value.canReconcile !== undefined) check(typeof value.canReconcile === 'boolean'
      && (!value.canReconcile || (value.state === 'reconciliation_required' && (!value.canResume || receiptWait)
        || value.state === 'recovering' && !value.canResume)
        && value.phase === 'awaiting_reconciliation' && typeof value.runId === 'string' && value.runId.trim()
        && value.reconciliation?.contract === 'agentkit.tool-receipt-observation/v1'
        && ['operationKey', 'callId'].every(key => typeof value.reconciliation[key] === 'string'
          && value.reconciliation[key].trim() && value.reconciliation[key].length <= 256)),
    '核对记录与原运行不一致，请刷新核对。');
    if (value.canRepairWorkspace !== undefined) check(typeof value.canRepairWorkspace === 'boolean'
      && (!value.canRepairWorkspace || !value.managed && value.canReconcile === true
        && value.phase === 'awaiting_reconciliation'), '文件修复权限与原运行不一致，请刷新核对。');
    if (value.a2aTasks !== undefined) check(Array.isArray(value.a2aTasks) && value.a2aTasks.length <= 10000
      && value.a2aTasks.every(task => task?.runId === value.runId && ['runId', 'operationKey', 'callId']
        .every(key => typeof task[key] === 'string' && task[key].trim() && task[key].length <= 256)),
    '远端任务清单与原运行不一致，请刷新核对。');
    const memory = value.cloudMemory;
    if (memory != null) {
      const id = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256;
      const base = ['contract', 'sessionId', 'runId', 'state'];
      const fields = [...base, 'resourceId', 'operationId', 'requestId', 'messageIds', 'phase', 'receiptRequestId', 'extraction', 'createdAt', 'completedAt'];
      check(memory.contract === 'agentkit.studio-native-cloud-memory-status/v1' && memory.runId === value.runId
        && memory.sessionId === sessionId && ['accepted', 'unconfirmed', 'outcome_unknown', 'unavailable'].includes(memory.state)
        && Object.keys(memory).every(key => (memory.state === 'unavailable' ? base : fields).includes(key))
        && (memory.state === 'unavailable' || id(memory.resourceId) && /^[0-9a-f]{64}$/.test(memory.operationId)
          && id(memory.requestId) && Array.isArray(memory.messageIds) && memory.messageIds.length > 0 && memory.messageIds.length <= 20
          && memory.messageIds.every(id) && memory.extraction === 'not_confirmed'
          && memory.phase === (memory.state === 'unconfirmed' ? 'prepared' : 'finished')
          && (memory.state === 'accepted' ? id(memory.receiptRequestId) : memory.receiptRequestId === null)
          && Number.isSafeInteger(memory.createdAt) && memory.createdAt >= 0
          && (memory.phase === 'prepared' ? memory.completedAt === null : Number.isSafeInteger(memory.completedAt) && memory.completedAt >= 0)),
      '云记忆提交记录与原运行不一致，请刷新核对。');
    }
    const extraction = value.memoryExtraction;
    if (extraction !== undefined) {
      const id = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256;
      check(extraction?.contract === 'agentkit.studio-native-memory-extraction/v1'
        && extraction.agentId === agentId && extraction.sessionId === sessionId
        && (extraction.cursor === null || id(extraction.cursor))
        && Array.isArray(extraction.jobs) && extraction.jobs.length <= 100
        && extraction.jobs.every(job => id(job.jobId) && id(job.parentRunId)
          && ['queued', 'running', 'success', 'no-op', 'error', 'aborted', 'superseded'].includes(job.status)
          && (job.usage === null || validUsage(job.usage))
          && (job.errorCode === null || id(job.errorCode))
          && Number.isSafeInteger(job.createdAt) && job.createdAt >= 0
          && Number.isSafeInteger(job.updatedAt) && job.updatedAt >= job.createdAt),
      '自动记忆提炼记录与原会话不一致，请刷新核对。');
    }
    const accounting = value.accounting;
    if (accounting != null) {
      check(accounting.contract === 'agentkit.studio-native-usage/v1' && accounting.runId === value.runId
        && Number.isSafeInteger(accounting.snapshotRevision) && accounting.snapshotRevision >= 0
        && ['final', 'incomplete', 'complete'].every(key => typeof accounting[key] === 'boolean')
        && accounting.complete === (accounting.final && !accounting.incomplete)
        && [accounting.own, accounting.descendant, accounting.total].every(validUsage)
        && [...counters, ...optionalCounters].every(key => (accounting.total[key] ?? 0)
          === (accounting.own[key] ?? 0) + (accounting.descendant[key] ?? 0)), '运行用量与原记录不一致，请刷新核对。');
    }
    return value;
  };
  async function refresh() {
    if (disposed || state.loading) return;
    set({ loading: true });
    try {
      const status = validate(await hostRemote.nativeRecoveryStatus(identity, lifetime.signal));
      set({ status, error: '' });
    } catch { set({ error: '恢复状态读取失败，请刷新。' }); }
    finally { set({ loading: false }); }
  }
  async function send() {
    if (disposed || state.sending || !state.pending) return;
    const pending = state.pending;
    set({ sending: true, error: '' });
    try {
      const { repairWorkspace, reviewBackground, ...request } = pending;
      const operation = reviewBackground ? hostRemote.reviewNativeBackground : repairWorkspace ? hostRemote.repairNativeWorkspace
        : pending.operationKey ? hostRemote.reconcileNativeTool : hostRemote.resumeNativeRun;
      const status = validate(await operation(request, lifetime.signal), pending.runId);
      set({ status, pending: null });
      await refresh();
    } catch { set({ error: '恢复请求尚未确认。可确认原运行的请求，请勿创建替代任务。' }); }
    finally { set({ sending: false }); }
  }
  return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, retry: send,
    resume() {
      if (disposed || state.pending || !state.status?.canResume) return;
      set({ pending: { ...identity, runId: state.status.runId } }); return send();
    },
    reconcile() {
      if (disposed || state.pending || !state.status?.canReconcile) return;
      set({ pending: { ...identity, runId: state.status.runId, operationKey: state.status.reconciliation.operationKey,
        commandId: newCommandId() } }); return send();
    },
    repairWorkspace() {
      if (disposed || state.pending || !state.status?.canRepairWorkspace) return;
      set({ pending: { ...identity, runId: state.status.runId, operationKey: state.status.reconciliation.operationKey,
        commandId: newCommandId(), repairWorkspace: true } }); return send();
    },
    reviewBackground() {
      if (disposed || state.pending || !state.status?.canReviewBackground) return;
      set({ pending: { ...identity, runId: state.status.runId,
        commandId: state.status.backgroundInterruptionReview?.commandId ?? newCommandId(),
        eventSeq: state.status.backgroundReviewEventSeq, confirmedStopped: true, reviewBackground: true } }); return send();
    },
    dispose() { disposed = true; lifetime.abort(); listeners.clear(); },
  };
}
