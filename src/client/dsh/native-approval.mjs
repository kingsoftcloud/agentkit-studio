import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { HARNESS_SERVICE_PRESET_SUFFIX } from '../../harness-service-preset.mjs';

const text = value => typeof value === 'string' && value.trim() && value.length <= 256;

function readSnapshot(value, agentId, sessionId) {
  if (value?.contract !== 'agentkit.studio-native-approval/v1' || value.agentId !== agentId || value.sessionId !== sessionId
    || !Array.isArray(value.pending)) throw Error('Native approval status is invalid');
  const pending = value.pending.filter(item => item && item.contract === value.contract
    && item.agentId === agentId && item.sessionId === sessionId && text(item.generation)
    && text(item.requestId) && text(item.runId) && text(item.interactionId) && text(item.hostInteractionId)
    && text(item.callId) && text(item.toolName) && Array.isArray(item.choices)
    && item.choices.includes('allow') && item.choices.includes('deny')
    && Number.isSafeInteger(item.expiresAt) && item.expiresAt > Date.now());
  return { ...value, pending };
}

/** Studio's real Native approval controls. The Kernel remains the command owner. */
export function createNativeApprovalPanel({
  ui: { React: { createElement: h, useEffect, useState, Fragment }, Button, RiskConfirmation, buttonStyle },
  hostRemote, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval,
}) {
  const Action = Button || 'button';
  const button = (label, onClick, disabled) => h(Action, { type: 'button', onClick, disabled,
    ...(Button ? { variant: 'outline', size: 'sm' } : { style: buttonStyle() }) }, label);

  return function NativeApprovalPanel({ agentId: initialAgentId, sessionId, useSessions, requestApprovalDecision }) {
    const session = useSessions?.(state => state?.byId?.[sessionId]);
    const presetId = session?.projectionValues?.agentPreset;
    const independent = typeof presetId === 'string' && presetId.endsWith(HARNESS_SERVICE_PRESET_SUFFIX);
    const [agentId, setAgentId] = useState(initialAgentId || '');
    const [status, setStatus] = useState(null), [error, setError] = useState('');
    const [busy, setBusy] = useState(''), [dialog, setDialog] = useState(null), [acknowledged, setAcknowledged] = useState(false);

    useEffect(() => {
      let active = true;
      if (independent) { setAgentId(''); return () => { active = false; }; }
      if (initialAgentId) { setAgentId(initialAgentId); return () => { active = false; }; }
      setAgentId('');
      if (!sessionId) return () => { active = false; };
      (async () => {
        const first = await hostRemote.agents({ source: 'local', pageSize: 100 });
        const rows = first?.items || [], id = agentFromSessionPreset(presetId, rows);
        if (active && id) setAgentId(id);
      })().catch(() => {});
      return () => { active = false; };
    }, [hostRemote, independent, initialAgentId, presetId, sessionId]);

    useEffect(() => {
      let active = true;
      setStatus(null); setError(''); setDialog(null); setAcknowledged(false);
      if (independent || !agentId || !sessionId) return () => { active = false; };
      const load = async () => {
        try {
          const value = readSnapshot(await hostRemote.nativeApprovalStatus({ agentId, sessionId }), agentId, sessionId);
          if (active) { setStatus(value); setError(''); }
        } catch (reason) { if (active) setError(reason?.message || '原生审批状态读取失败，请刷新。'); }
      };
      void load();
      const timer = setInterval(load, 1500);
      return () => { active = false; clearInterval(timer); };
    }, [agentId, hostRemote, independent, sessionId]);

    useEffect(() => {
      if (dialog && !status?.pending?.some(item => item.requestId === dialog.requestId)) {
        setDialog(null); setAcknowledged(false);
      }
    }, [dialog, status]);

    const decide = async (request, decision) => {
      if (busy || !request || !agentId || !sessionId) return;
      setBusy(request.requestId); setError('');
      try {
        const publicResult = typeof requestApprovalDecision === 'function'
          ? await requestApprovalDecision({ sessionId, requestId: request.requestId,
            decision: decision === 'allow' ? 'allowed-once' : 'rejected' })
          : null;
        const result = publicResult === null
          ? await hostRemote.decideNativeApproval({ agentId, sessionId, runId: request.runId,
            interactionId: request.interactionId, requestId: request.requestId, expectedGeneration: request.generation, decision })
          : publicResult;
        if (result?.accepted !== true) throw Error('审批请求已失效，请刷新后核对。');
        setStatus(current => current ? { ...current, pending: current.pending.filter(item => item.requestId !== request.requestId) } : current);
      } catch (reason) {
        setError(reason?.message || '审批决定未送达，请刷新核对原生运行状态。');
      } finally { setBusy(''); }
    };

    const pending = status?.pending || [];
    if (!pending.length) return error ? h('span', { role: 'alert', style: { fontSize: '12px' } }, error) : null;
    const current = dialog && pending.find(item => item.requestId === dialog.requestId);
    return h(Fragment, null,
      ...pending.map(request => h('section', { key: request.requestId, 'aria-label': `原生待审批：${request.toolName}`,
        style: { border: '1px solid var(--border, #ddd)', borderRadius: '10px', padding: '8px 10px', marginRight: '8px', maxWidth: '360px' } },
        h('strong', null, `${request.toolName} 请求一次性授权`),
        request.reason ? h('p', { style: { margin: '6px 0', fontSize: '12px', overflowWrap: 'anywhere' } }, request.reason) : null,
        h('div', { style: { display: 'flex', gap: '6px' } },
          button('允许一次', () => { setDialog(request); setAcknowledged(false); }, Boolean(busy) || !RiskConfirmation),
          button('拒绝', () => void decide(request, 'deny'), Boolean(busy))),
      )),
      RiskConfirmation ? h(RiskConfirmation, { open: Boolean(current), title: '允许原生工具这一次',
        description: current ? `${current.toolName}${current.reason ? `：${current.reason}` : ''}` : '',
        acknowledgeLabel: '我已核对这次操作及其影响', cancelLabel: '返回', closeLabel: '关闭审批确认',
        confirmLabel: '确认允许一次', acknowledged, disabled: Boolean(busy) || !current,
        onAcknowledgedChange: setAcknowledged,
        onCancel: () => { setDialog(null); setAcknowledged(false); },
        onConfirm: () => { if (!current || !acknowledged || busy) return; const request = current;
          setDialog(null); setAcknowledged(false); void decide(request, 'allow'); },
      }) : null,
      error ? h('span', { role: 'alert', style: { fontSize: '12px' } }, error) : null,
    );
  };
}
