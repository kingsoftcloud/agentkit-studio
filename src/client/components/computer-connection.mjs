import { observeComputerConnection } from '../state/computer-connection.mjs';

export function createComputerConnection({ ui, hostRemote, actions, window, document = window.document }) {
  const { React: { createElement: h, useState, useEffect, useRef }, BRAND, buttonStyle } = ui;
  return function ComputerConnection({ assistantName }) {
    const [open, setOpen] = useState(false), [state, setState] = useState({ status: 'checking' }), [opening, setOpening] = useState(false);
    const [failure, setFailure] = useState('');
    const root = useRef(null), trigger = useRef(null);
    useEffect(() => observeComputerConnection({ read: signal => hostRemote.computerConnection(signal), publish: setState, events: window }), []);
    useEffect(() => {
      if (!open) return;
      const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
      const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
      document.addEventListener('pointerdown', outside);
      document.addEventListener('keydown', escape, true);
      return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
    }, [open]);
    const local = Boolean(window.dshDesktop) || (() => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(window.location.href).hostname); } catch { return false; } })();
    const connected = state.status === 'connected';
    const label = connected ? local ? '本机已连接' : 'Studio 已连接' : state.status === 'checking' ? '正在检查连接' : '本机连接已断开';
    const system = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[state.computer?.platform] || state.computer?.platform;
    const note = { color: BRAND.inkMuted, fontSize: '12px', lineHeight: 1.65, margin: '5px 0 0' };
    return h('div', { ref: root, style: { position: 'relative' } },
      h('button', { ref: trigger, type: 'button', 'aria-label': '助理连接信息', 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => setOpen(value => !value), style: { ...buttonStyle(), display: 'flex', alignItems: 'center', gap: '8px', borderRadius: '18px', padding: '7px 12px' } },
        h('span', { 'aria-hidden': true, style: { width: '7px', height: '7px', borderRadius: '50%', background: connected ? BRAND.accentStrong : BRAND.inkMuted } }), label),
      open ? h('section', { role: 'dialog', 'aria-label': '助理连接信息', style: { position: 'absolute', right: 0, top: 'calc(100% + 10px)', width: 'min(340px, calc(100vw - 32px))', zIndex: 30, border: '1px solid ' + BRAND.border, borderRadius: '18px', boxShadow: '0 12px 40px #00000018', padding: '20px', background: BRAND.surface, color: BRAND.ink } },
        h('div', { style: { fontWeight: 650, fontSize: '15px' } }, '个人助理'),
        h('p', { style: note }, assistantName ? `云端助理 · ${assistantName}` : '尚未选择云端助理'),
        h('div', { style: { borderTop: '1px solid ' + BRAND.border, marginTop: '16px', paddingTop: '14px' } },
          h('p', { style: { ...note, margin: '0 0 8px' } }, local ? '这台电脑' : 'Studio 运行设备'),
          h('strong', null, connected ? state.computer.name : '连接待确认'),
          h('p', { role: 'status', style: note }, label, connected ? ` · ${system} · ${state.computer.arch}` : ''),
          h('p', { style: note }, connected ? '可在本机会话中，使用已配置的工具处理任务。云端助理尚未接入本机执行。' : '恢复 Studio 连接后，会自动重新检查设备状态。'),
          failure ? h('p', {role: 'alert', style: note}, failure) : null,
          connected && state.computer.localSessions ? h('button', { type: 'button', disabled: opening, style: { ...buttonStyle(), marginTop: '12px', width: '100%' }, onClick: async () => {
            setFailure(''); setOpening(true); try { await actions.bindAgent({ workspaceFree: true, throwOnError: true }); setOpen(false); } catch { setFailure('本机会话未能打开，请恢复连接后重试。'); } finally { setOpening(false); }
          } }, opening ? '正在打开…' : '打开本机会话') : null),
        h('button', { type: 'button', style: { ...buttonStyle(), width: '100%', marginTop: '16px', borderColor: 'transparent' }, onClick: () => { setOpen(false); window.dispatchEvent(new window.CustomEvent('agentkit-studio:open-settings')); } }, '在系统设置中管理助理')) : null);
  };
}
