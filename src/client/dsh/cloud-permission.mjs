import { readExecutionPolicy } from '../../execution-policy.mjs';

/** Routing is presentation only; the Host verifies ownership and runtime identity. */
export function selectCloudPermissionPresentation({ agentPreset } = {}) {
  if (typeof agentPreset !== 'string') return null;
  const match = /^agentkit-studio-agent-(ar-(?!local-)[A-Za-z0-9_-]+?)-r[1-9]\d*(?:-|_|$)/.exec(agentPreset);
  return match ? { agentId: match[1], agentPreset } : null;
}

export function createCloudPermissionPresentation({ ui: { React: { createElement: h, useEffect, useState }, buttonStyle }, hostRemote, window }) {
  return function CloudPermissionPresentation({ matched }) {
    const { agentId, agentPreset } = matched;
    const [receipt, setReceipt] = useState(null), [refresh, setRefresh] = useState(0);
    useEffect(() => {
      const reset = () => { setReceipt(null); setRefresh(value => value + 1); };
      window.addEventListener('agentkit-studio:connection-reset', reset);
      return () => window.removeEventListener('agentkit-studio:connection-reset', reset);
    }, []);
    useEffect(() => {
      let active = true;
      setReceipt(null);
      hostRemote.agentExecutionPolicy(agentId).then(value => {
        if (active) setReceipt({ agentPreset, refresh, policy: value?.agentId === agentId ? readExecutionPolicy(value.executionPolicy) : null });
      }).catch(() => { if (active) setReceipt({ agentPreset, refresh, policy: null }); });
      return () => { active = false; };
    }, [agentId, agentPreset, refresh]);
    const current = receipt?.agentPreset === agentPreset && receipt?.refresh === refresh ? receipt : null;
    const policy = current?.policy;
    const label = policy ? `云端 · ${{ 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完全访问' }[policy.permissionMode]}`
      : current ? '云端权限未知' : '正在核验云端权限';
    const title = policy ? `由云端运行策略控制；${policy.approvalPolicy === 'never' ? '不等待人工审批' : '需要审批时由云端处理'}。本机权限设置不会改变云端权限。点击重新核验。`
      : '当前未取得有效的云端权限声明，不能据此判断可写范围。本机权限设置不会改变云端权限。点击重新核验。';
    return h('button', { type: 'button', title, 'aria-label': label, 'aria-busy': current === null,
      onClick: () => { setReceipt(null); setRefresh(value => value + 1); },
      style: { ...buttonStyle(), fontSize: '11px', padding: '4px 8px' } }, label);
  };
}
