import { assistantLiveApprovals, sameAssistantApproval } from '../state/assistant-approvals.mjs';

/** Native risk confirmation for live cloud questions; historic audit rows stay inert. */
export function createAssistantApprovals({ ui, window }) {
  const { React: { createElement: h, useState, useEffect }, BRAND, Button, RiskConfirmation, buttonStyle } = ui;
  const Action = Button || 'button';
  return function AssistantApprovals({ view, agentId, busy, decision, onDecide }) {
    const [dialog, setDialog] = useState(null), [acknowledged, setAcknowledged] = useState(false), [, updateClock] = useState(0);
    const live = assistantLiveApprovals(view);
    const current = dialog?.agentId === agentId ? live.find(row => sameAssistantApproval(row, dialog.request) && row.canAllow === true && row.choices.includes('allowed-once')) : null;
    const firstExpiry = live.reduce((time, row) => Math.min(time, row.expiresAt), Infinity);
    useEffect(() => {
      if (!Number.isFinite(firstExpiry)) return;
      const timer = window.setTimeout(() => updateClock(value => value + 1), Math.max(0, firstExpiry - Date.now()));
      return () => window.clearTimeout(timer);
    }, [firstExpiry]);
    const close = () => { setDialog(null); setAcknowledged(false); };
    useEffect(() => { if (dialog && !current) { setDialog(null); setAcknowledged(false); } }, [dialog, Boolean(current)]);
    const button = (label, onClick, disabled) => h(Action, { type: 'button', onClick, disabled, ...(Button ? { variant: 'outline', size: 'sm' } : { style: buttonStyle() }) }, label);
    return h(ui.React.Fragment, null,
      ...live.map(request => {
        const deciding = sameAssistantApproval(request, decision) && ['requesting', 'accepted'].includes(decision.phase);
        return h('section', { key: `${request.generation}:${request.requestId}`, 'aria-label': `待审批：${request.toolName}`, style: { border: `1px solid ${BRAND.border}`, borderRadius: '12px', padding: '12px 14px', marginBottom: '12px' } },
          h('div', { style: { fontSize: '14px', fontWeight: 500, overflowWrap: 'anywhere' } }, `${request.toolName} 请求授权`),
          request.presentation ? h('p', { style: { color: BRAND.inkMuted, fontSize: '13px', lineHeight: 1.6, overflowWrap: 'anywhere' } }, request.presentation) : null,
          deciding ? h('p', { role: 'status', style: { color: BRAND.inkMuted, fontSize: '12px' } }, decision.phase === 'accepted' ? '决定已送达，等待云端处理。' : '正在发送决定…') : null,
          h('div', { style: { display: 'flex', gap: '8px' } },
            request.canAllow === true && request.choices.includes('allowed-once') ? button('允许这一次', () => { setAcknowledged(false); setDialog({ agentId, request }); }, busy || deciding || !RiskConfirmation) : null,
            button('拒绝', () => void onDecide(request, 'rejected'), busy || deciding)));
      }),
      RiskConfirmation ? h(RiskConfirmation, { open: Boolean(current), title: '允许这一次操作',
        description: current ? `${current.toolName}${current.presentation ? `：${current.presentation}` : ''}。批准只用于当前请求，后续是否执行仍由云端决定。` : '',
        acknowledgeLabel: '我已核对这次操作及其影响', cancelLabel: '返回', closeLabel: '关闭审批确认', confirmLabel: '确认允许这一次',
        acknowledged, disabled: busy || !current, onAcknowledgedChange: setAcknowledged, onCancel: close,
        onConfirm: () => { if (!current || !acknowledged || busy) return; const request = current; close(); void onDecide(request, 'allowed-once'); } }) : null);
  };
}
