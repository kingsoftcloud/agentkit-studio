import { createAssistantBrowserGraph } from '../dsh/assistant-browser-graph.mjs';
import { interceptAssistantLink } from '../dsh/assistant-links.mjs';

/** A page-owned closeable pane. Assistant changes unmount this occurrence and release its graph. */
export function createAssistantBrowser({ ui, nativeModules, window }) {
  const { React: { createElement: h, useEffect, useRef, useState }, BRAND, Button } = ui;
  function BrowserPane({ url }) {
    const container = useRef(null);
    const [error, setError] = useState('');
    useEffect(() => {
      const lifetime = new AbortController(); let graph;
      void (async () => {
        try {
          graph = await createAssistantBrowserGraph({ modules: nativeModules(), window, url, container: container.current, signal: lifetime.signal });
          if (lifetime.signal.aborted) await graph.dispose();
        } catch (reason) { if (!lifetime.signal.aborted) setError(reason.message || '内置浏览器暂时不可用。'); }
      })();
      return () => { lifetime.abort(); void graph?.dispose(); };
    }, [url]);
    return h('div', { style: { minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' } },
      error ? h('p', { role: 'alert', style: { color: BRAND.danger, padding: '12px 16px', fontSize: '13px' } }, error) : null,
      h('div', { ref: container, style: { minHeight: 0, flex: 1 } }));
  }
  return function AssistantBrowser({ agentId, children }) {
    const sequence = useRef(0);
    const [target, setTarget] = useState(null), [notice, setNotice] = useState('');
    // Identity gating hides the old graph during the render that switches assistant.
    const active = target?.agentId === agentId ? target : null;
    const capture = event => interceptAssistantLink(event, { applicationOrigin: window.location.origin,
      open(url) { setNotice(''); setTarget({ agentId, url, id: ++sequence.current }); },
      refuse() { setNotice('此链接不能在助理浏览器中打开。'); } });
    return h('div', { 'data-assistant-browser-layout': true, onClickCapture: capture, onAuxClickCapture: capture,
      style: { display: 'flex', height: '100%', minHeight: 0, minWidth: 0, position: 'relative' } },
      h('style', null, '@media (max-width: 900px) { [data-assistant-browser-pane] { position: absolute; inset: 0; width: auto !important; z-index: 2; } }'),
      h('div', { style: { flex: '1 1 0', minWidth: 0, minHeight: 0 } }, children),
      notice ? h('div', { role: 'alert', style: { position: 'absolute', bottom: '16px', left: '24px', right: '24px', color: BRAND.danger, background: BRAND.surface, padding: '10px 14px', fontSize: '13px' } }, notice) : null,
      active ? h('aside', { 'data-assistant-browser-pane': true, 'aria-label': '助理浏览器', style: { width: '46%', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: BRAND.surface, borderLeft: `1px solid ${BRAND.border}` } },
        h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${BRAND.border}`, fontSize: '13px' } },
          h('span', null, '浏览器'), h(Button || 'button', { type: 'button', 'aria-label': '关闭浏览器', onClick: () => setTarget(null), ...(Button ? { variant: 'ghost', size: 'sm' } : {}) }, '关闭')),
        h(BrowserPane, { key: active.id, url: active.url })) : null);
  };
}
