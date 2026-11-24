const phases = { created: '已准备', preparing_context: '整理上下文', requesting_model: '正在生成回复',
  compacting: '压缩上下文', verifying: '验证结果', executing_tools: '执行工具', awaiting_interaction: '等待审批或输入', paused: '已暂停',
  awaiting_reconciliation: '等待核对执行结果', reconciling_tool: '正在核对执行结果', interrupted: '执行中断，需要核对', finalizing: '收尾中' };

// Stable ledger reasons, never raw provider/tool exception text. These are
// explanations only; canResume still comes from the current Host authority.
const pauseReasons = {
  child_paused: ['子任务已暂停，等待处理', '原子任务及已提交结果已保留。请在“运行与子任务”中核对暂停原因，明确恢复或取消原子任务。'],
  approval_rejected: ['审批被拒绝，已暂停', '这次操作没有获得批准，尚未执行。已停止继续申请和生成，等待补充指导或明确恢复。'],
  approval_cancelled: ['审批已取消，已暂停', '这次审批被取消，操作尚未执行。原任务已保留，不会自动重新申请。'],
  approval_unavailable: ['审批通道不可用，已暂停', '尚未取得审批结果，操作没有获得批准。请先恢复审批通道再核对原任务。'],
  output_budget_exhausted: ['输出恢复额度已耗尽，已暂停', '同一响应多次达到输出上限，已保留已提交的工具结果和回复片段。'],
  provider_unavailable: ['模型服务暂不可用，已暂停', '模型请求的本轮重试已耗尽，原运行和已提交结果已保留。'],
  context_summary_unavailable: ['上下文整理暂不可用，已暂停', '上下文摘要暂未生成，原运行已保留，没有丢弃必需上下文。'],
  context_source_unavailable: ['上下文读取暂不可用，已暂停', '必需的上下文读取尚未成功，原运行和已提交结果已保留。'],
};
const failureReasons = {
  continuation_budget_exhausted: ['输出续写额度已耗尽', '本轮输出续写与重启额度已耗尽，任务没有完成。请核对模型输出上限和运行记录。'],
  model_budget_exhausted: ['模型调用预算已耗尽', '本轮已达到模型调用总预算，不能通过恢复补回已经消耗的预算。'],
  execution_budget_exhausted: ['执行时间预算已耗尽', '本轮已达到执行时间预算，任务没有完成。'],
  provider_retryable_error_retry_exhausted: ['模型请求重试已耗尽', '模型服务持续未能完成请求，任务没有完成。'],
  context_compaction_limit: ['上下文压缩次数已耗尽', '本轮已达到上下文压缩次数上限，任务尚未完成。'],
  context_mandatory_state_over_budget: ['必需上下文超过预算', '任务必需的上下文超过可用预算，无法安全省略后继续。'],
};

/** The committed phase survives a crash; only the owner control state says work is still being driven. */
export function nativeRunIsInactive(status, transportRunning = true) {
  return status?.state ? status.state !== 'recovering' : !transportRunning;
}

/** Execution phase and task evidence are separate facts. No inferred success. */
export function nativeRunPresentation(status) {
  if (!status?.runId || !status.phase) return null;
  if (status.phase === 'interrupted' && status.reason === 'effect_outcome_unknown'
    && status.backgroundInterruptionReview?.contract === 'agentkit.background-interruption-review/v1'
    && status.backgroundInterruptionReview.confirmedStopped === true && status.state === 'closed')
    return { label: '已结束等待，原结果未知', detail: '已核对原操作停止并关闭本轮；未知结果与原回执保持不变，没有重跑原命令。' };
  if (status.phase === 'canceled') return { label: '已取消', detail: '本轮执行已停止；已经发生的文件或外部修改不会因此自动撤销。' };
  if (status.phase === 'paused' && Object.hasOwn(pauseReasons, status.reason)) {
    const [label, detail] = pauseReasons[status.reason];
    if (status.reason === 'child_paused') return { label, detail };
    return { label, detail: detail + (status.canResume === true
      ? '请在运行与子任务中核对后恢复原运行；不会重新执行已提交的操作。'
      : '请在运行与子任务中核对原因及当前可用操作。') };
  }
  if (status.phase === 'failed' && Object.hasOwn(failureReasons, status.reason)) {
    const [label, detail] = failureReasons[status.reason];
    return { label, detail: status.error?.message || detail };
  }
  if (status.outcome === 'blocked') return { label: '任务受阻', detail: status.error?.message || '本轮未能完成任务。请查看回复中的缺项，检查 Agent 的「绑定能力」及审批要求。' };
  if (status.phase === 'failed') return { label: '执行失败', detail: status.error?.message || '本轮执行未成功，请查看错误并核对结果后重试。' };
  if (status.phase === 'interrupted' && status.reason === 'effect_outcome_unknown')
    return { label: '执行中断，结果待核对', detail: '原操作结果尚未确认。请在运行与子任务中核对处置方式；不会自动重跑原操作。' };
  if (nativeRunIsInactive(status) && !['completed', 'paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(status.phase))
    return status.canResume === true
      ? { label: '执行中断，等待恢复', detail: '原运行已没有活动执行者；恢复原任务后才会继续。已提交的回执保持不变。' }
      : { label: '任务已中断', detail: status.error?.message || '原运行已停止。请查看运行记录和当前可用操作。' };
  if (['preparing_context', 'compacting'].includes(status.phase)
    && status.modelRetryWait?.contract === 'agentkit.native-model-retry-wait/v1'
    && Number.isFinite(status.modelRetryWait.notBefore) && status.modelRetryWait.notBefore > 0)
    return { label: '等待模型重试', detail: '模型请求正在按重试策略等待；任务尚未停止。' };
  if (status.phase !== 'completed') return { label: phases[status.phase] || '处理中', detail: '' };
  if (status.outcome === 'failed' || status.outcome === 'budget_exhausted') return { label: '任务未完成', detail: '本轮已结束，任务未完成。请查看错误、预算和结果记录。' };
  if (status.outcome === 'verified') return { label: '任务已验证', detail: '任务已通过本次配置的验证检查；验证范围以结果证据为准。' };
  if (status.outcome === 'partial' && status.reason === 'required_verification_incomplete')
    return { label: '部分已验证', detail: '部分检查已通过，其余任务要求尚未获得验证证据；请核对回复和实际结果。' };
  if (status.outcome === 'partial') return { label: '部分完成', detail: '部分要求已有通过证据，整体结果仍需核对；请查看回复及结果。' };
  if (status.verificationRequired === true || status.verificationRequired !== false && status.reason === 'required_verification_incomplete')
    return { label: '本轮已结束 · 结果未验证', detail: '本任务配置了必需的验证检查，目前尚无全部通过的证据。' };
  return { label: '本轮已结束', detail: '本轮执行已结束，已返回回复。' };
}
