/** Public explanations for stable Native terminal reasons. Never copy a raw
 * provider, tool or exception message into the task conversation. */
import { validateModelFailure } from '@kingsoftcloud/agentkit-harness-core';
const messages = Object.freeze({
  effect_outcome_unknown: '操作结果尚未确认。请核对原操作，不会自动重复执行。',
  provider_terminal_error: '模型请求未能完成，请查看运行诊断。',
  model_policy_abort: '模型请求被服务端策略拒绝，请检查模型与任务配置。',
  model_budget_exhausted: '本次运行已达到模型调用预算。',
  execution_budget_exhausted: '本次运行已达到执行时间预算。',
  tool_call_after_budget_exhaustion: '工具调用超过本次运行预算。',
  tool_call_after_finalization_reserve: '工具调用占用了收尾预留预算。',
  continuation_budget_exhausted: '本次运行没有足够预算继续完成任务。',
  context_port_missing: '上下文服务不可用，请检查运行配置。',
  context_compaction_unavailable: '上下文整理未能完成，请检查模型与上下文配置。',
  context_compaction_limit: '本次运行已达到上下文压缩次数上限，任务尚未完成。',
  context_compaction_no_progress: '多次压缩后任务仍无进展，已停止继续消耗模型预算。',
  context_summary_validation_exhausted: '上下文摘要未通过校验，已达到重试上限。',
  context_mandatory_state_over_budget: '任务必需的上下文超过可用预算，无法安全省略后继续。',
  context_finalization_budget_unavailable: '剩余上下文预算不足以完成任务收尾。',
  repeated_tool_error_no_progress: '工具连续失败且任务没有进展，请检查工具配置或输入。',
  verification_report_missing: '任务验证没有返回结果，无法确认完成。',
  child_owner_unavailable: '子任务执行端不可用，请核对原子任务状态。',
  child_receipt_unavailable: '子任务结果尚未确认，请核对原子任务。',
  background_children_unsettled: '后台子任务尚未结算，请核对后继续。',
  browser_session_unavailable: '浏览器会话不可用，请重新建立浏览器连接。',
  recovery_retry_exhausted: '原运行的恢复预算已耗尽，请核对执行记录。',
});

const modelReasons = new Set(['provider_terminal_error', 'provider_retryable_error_retry_exhausted',
  'malformed_tool_call_retry_exhausted', 'model_policy_abort']);
function modelFailureMessage(value) {
  if (!value) return null;
  try { validateModelFailure(value); } catch { return null; }
  if (value.code === 'http_authentication') return '模型服务拒绝身份认证，请检查模型凭据。';
  if (value.code === 'http_permission') return '模型请求被服务端权限或策略拒绝。';
  if (value.code === 'http_rate_limit') return '模型服务持续限流，本次运行的重试次数已耗尽。';
  if (value.code === 'host_binding') return '模型连接配置未能加载，请检查运行配置。';
  if (value.phase === 'request') return '模型请求在发送前未通过校验，请查看运行诊断。';
  if (value.code === 'stream_timeout' || value.code === 'http_timeout') return '等待模型服务响应超时，本次运行未能完成。';
  if (value.code === 'transport_error') return '与模型服务的连接中断，本次运行未能完成。';
  if (value.code === 'provider_error' || value.code === 'http_server') return '模型服务返回执行错误，本次运行未能完成。';
  if (value.phase === 'stream' || value.phase === 'buffered') return '模型响应未通过协议校验，本次运行已停止，请查看运行诊断。';
  return null;
}
export function nativePublicTerminalError(phase, reason, modelFailure) {
  if (phase !== 'failed' && phase !== 'interrupted') return null;
  return {
    code: phase === 'interrupted' ? 'NATIVE_EXECUTION_INTERRUPTED' : 'NATIVE_EXECUTION_NOT_COMPLETED',
    message: (modelReasons.has(reason) ? modelFailureMessage(modelFailure) : null) ?? (Object.hasOwn(messages, reason) ? messages[reason] : (phase === 'interrupted'
      ? '原运行需要核对后才能继续，不会自动重复可能产生副作用的操作。'
      : 'Native 运行未完成，请检查运行记录和配置。')),
  };
}
