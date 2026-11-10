/** Native engine runs render through the engine's OWN view: a self-contained
 * page the engine delivered, loaded into a scripts-only sandboxed iframe.
 * Studio groups the run's events from the Session and relays them; it does
 * not interpret event kinds, so new engine presentation needs no Studio change. */

export const NATIVE_ENGINE_EVENT = 'agentkit/native-engine-event';
export const NATIVE_ENGINE_VIEW_KIND = 'agentkit-native-engine-run';
export const ENGINE_VIEW_CONTRACT = 'agentkit.engine-view/v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EVENTS = 2000;

function parse(event) {
  if (!event || event.type !== NATIVE_ENGINE_EVENT || event.ignorable !== true || !Number.isSafeInteger(event.seq)) return null;
  const data = event.data;
  if (!data || typeof data.runId !== 'string' || !data.runId || !data.event || !Number.isSafeInteger(data.event.seq)) return null;
  return { runId: data.runId, view: SHA256.test(String(data.view)) ? data.view : null, event: data.event };
}

export const nativeEngineViewDefinition = {
  kind: NATIVE_ENGINE_VIEW_KIND, target: 'chat',
  match(event) {
    const parsed = parse(event);
    return parsed ? { id: parsed.runId, role: 'start' } : null;
  },
  start(_context, match) {
    const parsed = parse(match.event);
    return { first: match, latest: match, view: parsed?.view ?? null, events: parsed ? [parsed.event] : [], last: parsed?.event.seq ?? 0 };
  },
  update(context, match) {
    const state = context.state, parsed = parse(match.event);
    if (!parsed || parsed.event.seq <= state.last) return state;
    return { ...state, latest: match, view: state.view ?? parsed.view, events: [...state.events, parsed.event].slice(-MAX_EVENTS), last: parsed.event.seq };
  },
  buildViewNode(context) {
    if (!context.state) return null;
    const { first, view, events, last } = context.state;
    const location = context.start?.location || first.location;
    const current = context.current.get('chat');
    if (current?.data?.last === last && current?.data?.view === view && current?.location === location) return current;
    return { key: context.key, id: context.id, kind: NATIVE_ENGINE_VIEW_KIND, target: 'chat', anchorSeq: first.event.seq, location,
      visibility: 'visible', data: { runId: context.id, view, events, last } };
  },
};

/** The keyed renderer. `fetchView(sha256)` resolves to the view HTML. */
export function createNativeEngineView({ React, fetchView = defaultFetchView }) {
  const { createElement: h, useEffect, useRef, useState } = React;
  return function NativeEngineView({ node }) {
    const data = node?.data || {};
    const frame = useRef(null);
    const sent = useRef(0);
    const [html, setHtml] = useState(null);
    const [ready, setReady] = useState(false);
    const [height, setHeight] = useState(160);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      let live = true;
      setHtml(null); setReady(false); setFailed(false); sent.current = 0;
      if (!data.view) return () => { live = false; };
      fetchView(data.view).then(text => { if (live) setHtml(text); }, () => { if (live) setFailed(true); });
      return () => { live = false; };
    }, [data.view]);
    useEffect(() => {
      const onMessage = message => {
        if (!frame.current || message.source !== frame.current.contentWindow) return;
        const value = message.data;
        if (!value || value.contract !== ENGINE_VIEW_CONTRACT) return;
        if (value.type === 'ready') { sent.current = 0; setReady(true); }
        else if (value.type === 'height' && Number.isFinite(value.height)) setHeight(Math.max(48, Math.min(4000, Math.ceil(value.height))));
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);
    useEffect(() => {
      if (!ready || !frame.current?.contentWindow) return;
      const events = (data.events || []).filter(event => event.seq > sent.current);
      if (!events.length) return;
      frame.current.contentWindow.postMessage({ contract: ENGINE_VIEW_CONTRACT, type: 'events', runId: data.runId, events }, '*');
      sent.current = events.at(-1).seq;
    }, [ready, data.last, data.runId]);
    if (!data.view || failed) return h('p', { style: { margin: '4px 0', opacity: 0.7, fontSize: 13 } },
      failed ? '引擎任务视图加载失败，任务本身不受影响。' : '此引擎版本未提供任务视图。');
    if (!html) return null;
    return h('iframe', { ref: frame, title: '任务过程', sandbox: 'allow-scripts', srcDoc: html, referrerPolicy: 'no-referrer',
      style: { width: '100%', height, border: 0, display: 'block', background: 'transparent' } });
  };
}

const viewCache = new Map();
function defaultFetchView(sha256) {
  if (!viewCache.has(sha256)) viewCache.set(sha256, fetch(`api/agentkit.native-engine.view?${new URLSearchParams({ sha256 })}`, { credentials: 'same-origin' })
    .then(response => { if (!response.ok) throw new Error(`view ${response.status}`); return response.text(); })
    .catch(error => { viewCache.delete(sha256); throw error; }));
  return viewCache.get(sha256);
}

export function mountNativeEngineView(ctx, { React, fetchView } = {}) {
  if (!ctx?.uiConversation?.events?.register || !ctx.slots?.inject || !ctx.slots?.register) throw new Error('native_engine_view_mount_invalid');
  const View = createNativeEngineView({ React, ...(fetchView ? { fetchView } : {}) });
  const dispose = ctx.uiConversation.events.register(nativeEngineViewDefinition);
  let renderer;
  try { renderer = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: NATIVE_ENGINE_VIEW_KIND }, View)); }
  catch (error) { dispose(); throw error; }
  return { dispose() { renderer(); dispose(); }, View, kind: NATIVE_ENGINE_VIEW_KIND };
}
