import { redactError } from './tool-detail.mjs';

const summaries = {
  invalid_delivery_scope: '交付范围声明无效，尚未更新',
  web_definition_mismatch: '网页工具的接入配置不一致，尚未执行',
  web_search_not_configured: '网页搜索服务尚未配置',
  capture_limit_exceeded: '工作区变更清单超出观测上限，命令未执行',
  command_policy_blocked: '命令不符合当前执行规则，尚未执行',
  policy_denied: '当前权限规则未允许这次操作',
  command_evidence_incomplete: '命令回执尚不完整，需要核对执行结果',
  studio_native_browser_unavailable: '本地浏览器不可用，尚未完成网页验证',
  child_capability_unavailable: '该子智能体缺少任务所需工具，尚未启动',
  child_capability_request_invalid: '子任务所需工具声明无效，尚未启动',
  child_role_unavailable: '所选子智能体不可用，尚未启动',
  canceled: '操作已停止',
  selector_ambiguous: '选择器匹配多个元素，请选择唯一目标',
  selector_not_found: '未找到指定元素，请核对当前页面',
  selector_not_visible: '指定元素当前不可见',
  selector_not_actionable: '指定元素当前无法交互',
  selector_resolution_failed: '无法解析或读取指定目标',
};

/** Detailed evidence remains expandable; compact rows do not dump wire JSON. */
export function toolErrorSummary(error, { locale } = {}) {
  let value;
  try { value = typeof error === 'string' ? JSON.parse(error) : error; } catch { /* plain error */ }
  if (value && typeof value === 'object') {
    const code = value.error_type ?? value.code ?? value.error_code ?? value.error?.code;
    if (String(locale ?? '').startsWith('zh')) return summaries[code] ?? '工具调用失败，点击查看具体原因';
    return 'Tool call failed; expand for details';
  }
  return redactError(error);
}
