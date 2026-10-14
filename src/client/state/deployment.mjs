export const DEPLOYMENT_LABELS = { PREPARED: '待提交', UPLOADING: '上传运行包', UPLOAD_UNKNOWN: '上传结果待核对', UPLOADED: '已上传', CREATING: '创建中', CREATE_UNKNOWN: '创建结果待核对', PROVISIONING: '准备实例', CONFIGURING: '配置访问令牌', TOKEN_PENDING: '等待配置生效', STARTING: '启动中', UPDATING: '切换版本 · 等待入口确认', UPDATE_UNKNOWN: '更新结果待核对', READY: '就绪', AVAILABLE_UPDATING: '入口可用 · 平台更新中', ACTION_REQUIRED: '需要处理', FAILED: '失败', DELETING: '删除中', DELETE_UNKNOWN: '删除结果待核对', DELETED: '已删除' };

export const DEPLOYMENT_POLL_STATES = new Set(['UPDATING', 'UPDATE_UNKNOWN', 'PROVISIONING', 'CONFIGURING', 'TOKEN_PENDING', 'STARTING', 'AVAILABLE_UPDATING', 'DELETING', 'DELETE_UNKNOWN']);

export const DEPLOYMENT_ATTENTION_STATES = new Set(['CREATE_UNKNOWN', 'UPLOAD_UNKNOWN', 'UPDATE_UNKNOWN', 'DELETE_UNKNOWN', 'ACTION_REQUIRED', 'FAILED', 'TOKEN_PENDING']);

export function deliveryDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
