import { readExecutionMode, readExecutionPolicy } from '../../execution-policy.mjs';

const CLOUD_LABELS = { 'read-only': '只读', 'workspace-write': '工作区内修改', 'danger-full-access': '完全访问' };
// Same wording as the Local DSH permission picker so the two surfaces stay aligned.
const PICKER_LABELS = { 'read-only': '仅可查看', 'workspace-write': '工作区内修改', 'danger-full-access': '完全权限' };

/** Routing is presentation only; the Host verifies ownership and runtime identity. */
export function selectCloudPermissionPresentation({ agentPreset } = {}) {
  if (typeof agentPreset !== 'string') return null;
  const match = /^agentkit-studio-agent-(ar-(?!local-)[A-Za-z0-9_-]+?)-r[1-9]\d*(?:-|_|$)/.exec(agentPreset);
  return match ? { agentId: match[1], agentPreset } : null;
}

export function createCloudPermissionPresentation({ ui = {}, hostRemote, window }) {
  const { React: { createElement: h, useEffect, useState }, buttonStyle, BRAND = {},
    Menu, MenuItemButton, IconChevronDownOutlineRegular } = ui;
  const canSwitch = typeof Menu === 'function' && typeof MenuItemButton === 'function' && typeof IconChevronDownOutlineRegular === 'function';
  return function CloudPermissionPresentation({ matched }) {
    const { agentId, agentPreset } = matched;
    const [receipt, setReceipt] = useState(null), [refresh, setRefresh] = useState(0);
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    useEffect(() => {
      const reset = () => { setReceipt(null); setRefresh(value => value + 1); };
      window.addEventListener('agentkit-studio:connection-reset', reset);
      return () => window.removeEventListener('agentkit-studio:connection-reset', reset);
    }, []);
    useEffect(() => {
      let active = true;
      setReceipt(null);
      hostRemote.agentExecutionPolicy(agentId).then(value => {
        if (!active) return;
        const valid = value?.agentId === agentId;
        setReceipt({ agentPreset, refresh,
          policy: valid ? readExecutionPolicy(value.executionPolicy) : null,
          modes: valid && Array.isArray(value.allowedPermissionModes) ? value.allowedPermissionModes.filter(readExecutionMode) : [],
          selected: valid ? readExecutionMode(value.selectedPermissionMode) : null,
          switching: valid && value.executionModeSwitching === true,
          readError: valid && value.executionPolicy != null ? null : undefined,
        });
      }).catch(() => { if (active) setReceipt({ agentPreset, refresh, policy: null, modes: [], selected: null, switching: false, readError: true }); });
      return () => { active = false; };
    }, [agentId, agentPreset, refresh]);
    const current = receipt?.agentPreset === agentPreset && receipt?.refresh === refresh ? receipt : null;
    const policy = current?.policy;
    if (canSwitch && current?.switching && current.modes.length) {
      const selected = current.selected || policy?.permissionMode || current.modes[0];
      const disabled = busy || current.modes.length < 2;
      const label = `云端 · ${PICKER_LABELS[selected] || PICKER_LABELS['read-only']}`;
      const title = `云端执行权限：${current.modes.map(mode => PICKER_LABELS[mode]).join(' / ')}。选择只影响该云端 Agent 的后续运行，不会补授已开始回合的权限；${policy?.approvalPolicy === 'never' ? '云端不等待人工审批' : '需要审批时由云端处理'}。`;
      const apply = async mode => {
        if (busy) return;
        setOpen(false); setBusy(true); setNotice('');
        try {
          const value = await hostRemote.setAgentExecutionMode?.(agentId, mode);
          const applied = readExecutionMode(value?.selectedPermissionMode);
          if (!value || value.agentId !== agentId || !applied) throw new Error('云端执行权限未确认');
          setReceipt(result => result?.agentPreset === agentPreset ? { ...result,
            selected: applied,
            modes: Array.isArray(value.allowedPermissionModes) ? value.allowedPermissionModes.filter(readExecutionMode) : result.modes } : result);
          if (applied !== mode) setNotice('已按部署声明上限调整');
        } catch (error) { setNotice(error?.message || '云端执行权限切换失败'); }
        finally { setBusy(false); }
      };
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        h(Menu, {
          open: open && !disabled,
          portal: true, compact: true,
          onClose: () => setOpen(false),
          anchor: h('button', {
            type: 'button', 'aria-label': '云端执行权限', 'aria-haspopup': 'menu', 'aria-expanded': open, disabled,
            title, 'aria-busy': busy,
            onClick: () => setOpen(value => !value),
            style: { ...buttonStyle(), display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '4px 8px' },
          }, h('span', null, busy ? '正在切换…' : label), h(IconChevronDownOutlineRegular, { size: 11 })),
        },
          h('div', { role: 'note', style: { padding: '8px 10px', maxWidth: '280px', color: BRAND.inkMuted || '#666', fontSize: '11px', lineHeight: 1.5 } },
            '选择该云端 Agent 后续运行的执行权限，受镜像声明的上限约束；云端不等待人工审批。'),
          ...current.modes.map(mode => h(MenuItemButton, { key: mode, onSelect: () => apply(mode) },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { style: { flex: 1, whiteSpace: 'nowrap' } }, PICKER_LABELS[mode]),
              mode === selected ? h('span', { 'aria-label': '已选择' }, '✓') : null))),
        ),
        notice ? h('span', { role: 'status', style: { color: BRAND.inkMuted || '#666', fontSize: '11px' } }, notice) : null);
    }
    const label = policy ? `云端 · ${CLOUD_LABELS[policy.permissionMode]}`
      : current ? '云端权限未知' : '正在核验云端权限';
    const title = policy ? `由云端运行策略控制；${policy.approvalPolicy === 'never' ? '不等待人工审批' : '需要审批时由云端处理'}。本机权限设置不会改变云端权限。点击重新核验。`
      : '当前未取得有效的云端权限声明，不能据此判断可写范围。本机权限设置不会改变云端权限。点击重新核验。';
    return h('button', { type: 'button', title, 'aria-label': label, 'aria-busy': current === null,
      onClick: () => { setReceipt(null); setRefresh(value => value + 1); },
      style: { ...buttonStyle(), fontSize: '11px', padding: '4px 8px' } }, label);
  };
}
