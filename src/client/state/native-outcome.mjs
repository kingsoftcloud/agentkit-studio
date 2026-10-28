const phases = { created: '已准备', preparing_context: '整理上下文', requesting_model: '正在生成回复',
  compacting: '压缩上下文', verifying: '验证结果', executing_tools: '执行工具', awaiting_interaction: '等待审批或输入', paused: '已暂停',
  awaiting_reconciliation: '等待核对执行结果', reconciling_tool: '正在核对执行结果', interrupted: '执行中断，需要核对', finalizing: '收尾中' };

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
  if (status.outcome === 'blocked') return { label: '任务受阻', detail: status.error?.message || '本轮未能完成任务。请查看回复中的缺项，检查 Agent 的「绑定能力」及审批要求。' };
  if (status.phase === 'failed') return { label: '执行失败', detail: status.error?.message || '本轮执行未成功，请查看错误并核对结果后重试。' };
  if (status.phase === 'interrupted' && status.reason === 'effect_outcome_unknown')
    return { label: '执行中断，结果待核对', detail: '原操作结果尚未确认。请在运行与子任务中核对处置方式；不会自动重跑原操作。' };
  if (nativeRunIsInactive(status) && !['completed', 'paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(status.phase))
    return { label: '执行中断，等待恢复', detail: '原运行已没有活动执行者；恢复原任务后才会继续。已提交的回执保持不变。' };
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
