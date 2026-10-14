import { readStartChecks } from '../state/start-checks.mjs';

export function createStartChecks({
  ui: { React: { createElement: h, useEffect, useRef, useState }, buttonStyle },
  hostRemote, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
  function StartChecks() {
    const [state, setState] = useState({ expanded: false, phase: 'idle', rows: [], checkedAt: '' });
    const lifetime = useRef({ active: true, expanded: false, revision: 0 });
    const refresh = async () => {
      const revision = ++lifetime.current.revision;
      setState(current => ({ ...current, phase: 'checking', rows: [], checkedAt: '' }));
      const rows = await readStartChecks(hostRemote);
      if (!lifetime.current.active || revision !== lifetime.current.revision) return;
      setState(current => ({ ...current, phase: 'done', rows, checkedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
    };
    const toggle = () => {
      lifetime.current.expanded = !lifetime.current.expanded;
      setState(current => ({ ...current, expanded: lifetime.current.expanded }));
      if (lifetime.current.expanded) void refresh();
      else lifetime.current.revision += 1;
    };
    useEffect(() => {
      lifetime.current.active = true;
      const changed = () => { if (lifetime.current.expanded) void refresh(); };
      window.addEventListener('agentkit-studio:model-credential-changed', changed);
      window.addEventListener('agentkit-studio:credential-recheck', changed);
      return () => {
        lifetime.current.active = false; lifetime.current.revision += 1;
        window.removeEventListener('agentkit-studio:model-credential-changed', changed);
        window.removeEventListener('agentkit-studio:credential-recheck', changed);
      };
    }, []);
    return h('div', { className: 'agentkit-start-checks-entry' },
      h('div', { className: 'agentkit-check-toggle' }, h('button', { type: 'button', onClick: toggle, 'aria-expanded': state.expanded, style: buttonStyle() }, state.expanded ? '收起检查' : '开始前检查')),
      state.expanded ? h('section', { className: 'agentkit-start-checks', 'aria-label': '开始前检查', 'aria-busy': state.phase === 'checking' },
      h('div', { className: 'agentkit-form-heading' },
        h('div', null, h('h3', null, '开始前检查'), h('p', null, '查看当前配置，确认下一步。')),
        h('button', { type: 'button', onClick: refresh, disabled: state.phase === 'checking', style: buttonStyle() }, state.phase === 'checking' ? '检查中…' : '重新检查')),
      h('div', { role: 'status', 'aria-live': 'polite' }, state.phase === 'checking' ? h('p', { className: 'agentkit-form-note' }, '正在读取 Host、凭证和运行目标…') :
        state.rows.map(row => h('div', { key: row.id, className: 'agentkit-check-row', 'data-check-state': row.status },
          h('div', null, h('div', { className: 'agentkit-check-label' }, row.label), h('div', { className: 'agentkit-form-note' }, row.detail)),
          h('div', { className: 'agentkit-check-actions' }, h('span', { className: 'agentkit-check-state' }, { confirmed: '已确认', missing: '缺少配置', unknown: '未知' }[row.status]),
            row.action === 'credentials' ? h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:credential-onboarding')), style: buttonStyle() }, '配置模型') : null)))),
      h('p', { className: 'agentkit-form-note' }, '目录登记和凭证配置不代表工具执行或模型调用已通过验证。', state.checkedAt ? ` 检查于 ${state.checkedAt}` : '')) : null);
  }
  return StartChecks;
}
