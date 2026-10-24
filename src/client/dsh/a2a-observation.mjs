/** Durable remote observations use their own business node and keyed Chat
 * renderer. Session seq anchors the view; per-call seq starts at one. These
 * facts never become model messages, local tool calls or approval decisions. */

export const A2A_OBSERVATION_CONTRACT = 'agentkit.a2a-session-event/v1';
export const A2A_OBSERVATION_KIND = 'agentkit-a2a-observation';
const SOURCE_KEY = /^[a-f0-9]{64}$/u;
const MAX_PARTS = 64;
const MAX_TEXT = 2000;
const MAX_EVENTS = 128;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;

/** Validate the non-surface envelope + canonical event. Returns parsed or
 * null to safely ignore malformed input (no throw). */
function parseObservation(event) {
  if (!event || typeof event !== 'object') return null;
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return null;
  if (event.ignorable !== true) return null; // must be a non-surface event
  // A2A observations are ignorable Session events; they must not carry the
  // surface operations that owned messages/artifacts carry.
  if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  if (data.contract !== A2A_OBSERVATION_CONTRACT) return null;
  if (typeof data.sourceKey !== 'string' || !SOURCE_KEY.test(data.sourceKey)) return null;
  const owner = data.owner;
  if (!owner || typeof owner !== 'object') return null;
  if (!identity(owner.agentId) || !identity(owner.sessionId)
    || (owner.kind !== 'native' && owner.kind !== 'dsh')) return null;
  if (!identity(data.eventId)) return null;
  if (!Number.isSafeInteger(data.sourceSeq) || data.sourceSeq < 1) return null;
  if (typeof data.eventJson !== 'string' || !data.eventJson || data.eventJson.length > 8 * 1024 * 1024) return null;
  let canonical;
  try { canonical = JSON.parse(data.eventJson); }
  catch { return null; }
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return null;
  if (canonical.schema_version !== 2) return null;
  if (typeof canonical.event_id !== 'string' || !canonical.event_id) return null;
  if (canonical.event_id !== data.eventId) return null; // envelope eventId must match canonical
  if (typeof canonical.event_type !== 'string' || !canonical.event_type) return null;
  // run.* events are run-scope facts, not per-item observations; reject here.
  if (canonical.event_type.startsWith('run.')) return null;
  if (!Number.isSafeInteger(canonical.seq) || canonical.seq < 1) return null;
  if (canonical.seq !== data.sourceSeq) return null; // envelope sourceSeq must match canonical seq
  if (!identity(canonical.run_id) || !identity(canonical.scope_id)) return null;
  return { envelope: data, canonical };
}

/** Stable grouping identity: same sourceKey + canonical item/interaction. */
function groupId(envelope, canonical) {
  const entity = canonical.item_id || canonical.interaction_id || canonical.continuation_id;
  if (typeof entity !== 'string' || !entity) return null;
  return `${envelope.sourceKey}:${entity}`;
}

const entityLabel = {
  message: '远端消息', artifact: '远端制品', tool_call: '远端工具调用',
  tool_result: '远端工具结果', interaction: '远端交互提示', data: '远端数据',
  item: '远端条目', scope: '调用作用域',
  continuation: '远端任务继续状态',
};
const stateLabel = {
  working: '处理中', completed: '已完成', failed: '失败', interrupted: '已中断',
  submitted: '已提交', input_required: '等待补充输入', cancelled: '已取消', requested: '等待回复', resolved: '已回复',
  created: '等待继续', resumed: '已继续',
};

/** Build/merge a per-item accumulated snapshot from started/updated/replaced/
 * completed events, retaining accepted text/tool/input facts. */
function applyEventToSnapshot(snapshot, canonical) {
  let next = snapshot ? { parts: [...snapshot.parts], texts: [...snapshot.texts], tools: [...snapshot.tools] }
    : { parts: [], texts: [], tools: [] };
  const type = canonical.event_type;
  if (type === 'item.snapshot_replaced' || type === 'item.completed' || type === 'item.started') {
    const value = type === 'item.started' ? canonical.initial : canonical.snapshot;
    const parts = Array.isArray(value?.parts) ? value.parts : [];
    next = { parts: parts.slice(0, MAX_PARTS), texts: [], tools: [] };
    extract(next, next.parts);
  } else if (type === 'item.updated') {
    const update = canonical.update;
    if (update && typeof update === 'object') {
      const parts = next.parts.slice();
      if (canonical.op === 'replace') {
        const idx = parts.findIndex(p => p.part_id === update.part_id);
        if (idx >= 0) parts[idx] = update; else parts.push(update);
      } else parts.push(update);
      next = { parts: parts.slice(0, MAX_PARTS), texts: [], tools: [] };
      extract(next, next.parts);
    }
  }
  return next;
}
function extract(into, parts) {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.content_type === 'text' && typeof part.text === 'string') into.texts.push(part.text);
    else if (part.content_type === 'tool_call') into.tools.push({ kind: 'call', call_id: part.call_id, name: part.name, arguments: part.arguments });
    else if (part.content_type === 'tool_result') into.tools.push({ kind: 'result', call_id: part.call_id, result: part.result, is_error: part.is_error === true });
    else if (part.content_type === 'data') into.tools.push({ kind: 'data', data: part.data });
  }
}

function classifyStatus(canonical, snapshot) {
  const type = canonical.event_type;
  const descriptor = snapshot?.parts.find(part => part?.data?.schema === 'execution.scope/v1')?.data;
  if (descriptor && typeof descriptor.status === 'string') return descriptor.status;
  if (type === 'item.completed') return 'completed';
  if (type === 'item.failed') return 'failed';
  if (type === 'interaction.requested') return 'requested';
  if (type === 'interaction.resolved') return 'resolved';
  if (type === 'continuation.created') return 'created';
  if (type === 'continuation.resumed') return 'resumed';
  if (type === 'item.started') return 'working';
  if (type === 'item.updated' || type === 'item.snapshot_replaced') return 'working';
  return null;
}

/** Redact: replace ALL secret-like tokens, and never surface internal/host
 * URLs or file paths as actionable text. Applied recursively to strings. */
const SECRET = /(?:bearer|token|secret|password|passwd|api[_-]?key|access[_-]?key|secret[_-]?key|authorization|credential)[\s:="']+[A-Za-z0-9._~+/=-]+/giu;
const URLISH = /\b(?:https?|file|ftp):\/\/[^\s"'<>]+/giu;
const HEX64 = /\b[a-f0-9]{64,}\b/giu;
function redact(text) {
  if (typeof text !== 'string') return '';
  let out = text.replace(SECRET, '[已隐藏]');
  out = out.replace(URLISH, () => '[内部链接已隐藏]');
  out = out.replace(HEX64, '[已隐藏]');
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out;
}
function redactValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return redact(JSON.stringify(value, (key, item) => /token|secret|password|passwd|api.?key|authorization|credential/iu.test(key)
    ? '[已隐藏]' : item)); } catch { return '[无法展示]'; }
}

/** Read-only React component factory. Plain-text elements only; no buttons,
 * no anchors, no inputs, no auto-fetch. */
export function createA2aObservationView({ React } = {}) {
  if (!React || typeof React.createElement !== 'function') return null;
  const h = React.createElement, Fragment = React.Fragment || ((props) => props.children);
  const muted = { color: 'var(--ink-muted, #888)', fontSize: '12px' };
  const box = { border: '1px solid var(--border, #ddd)', borderRadius: '8px', padding: '10px 12px', marginTop: '8px' };

  function renderContent(canonical, snapshot, entity) {
    if (entity === 'interaction') {
      const req = canonical.request || {};
      const kind = canonical.interaction_kind || req.request_type || 'structured_input';
      const prompt = typeof req.prompt === 'string' ? req.prompt : '';
      const detail = redactValue(req.detail);
      return h(Fragment, null,
        h('p', { style: muted }, `远端${kind === 'approval' ? '审批' : '补充输入'}提示（仅展示，不代为决定）`),
        prompt ? h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, redact(prompt)) : null,
        detail ? h('p', { style: muted }, redact(detail)) : null);
    }
    if (entity === 'scope') {
      // ExecutionScopeDescriptor is a data part in the snapshot.
      const parts = snapshot?.parts || [];
      const desc = parts.find(p => p?.content_type === 'data')?.data;
      if (desc && typeof desc === 'object') {
        const agent = desc.agent || {}, status = desc.status || '';
        return h(Fragment, null,
          status ? h('p', null, `状态：${stateLabel[status] || status}`) : null,
          agent.name ? h('p', { style: muted }, `Agent：${redact(agent.name)}`) : null,
          agent.version_id ? h('p', { style: muted }, `版本：${redact(agent.version_id)}`) : null);
      }
      return null;
    }
    const kids = [];
    const files = (snapshot?.parts || []).filter(part => part?.content_type === 'artifact');
    if (files.length) kids.push(h('details', { key: 'files' }, h('summary', { style: muted }, '附件（仅展示，不自动访问）'),
      ...files.map((part, index) => h('p', { key: index }, redactValue({ name: part.name || '附件',
        mediaType: part.mime_type || part.data?.mime_type || '', ...(typeof part.data?.base64 === 'string' ? { base64Characters: part.data.base64.length } : {}) })))));
    if (snapshot?.texts?.length) {
      kids.push(h('details', { key: 'text' }, h('summary', { style: muted }, '文本'),
        ...snapshot.texts.map((t, i) => h('p', { key: i, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0' } }, redact(t)))));
    }
    if (snapshot?.tools?.length) {
      kids.push(h('details', { key: 'tools' }, h('summary', { style: muted }, '工具（仅展示，不发起调用）'),
        ...snapshot.tools.map((tool, i) => h('p', { key: i, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '4px 0' } },
          tool.kind === 'call' ? `调用 ${redact(String(tool.name || ''))}：${redactValue(tool.arguments)}`
          : tool.kind === 'result' ? `结果${tool.is_error ? '（错误）' : ''}：${redactValue(tool.result)}`
          : `数据：${redactValue(tool.data)}`))));
    }
    return kids.length ? h(Fragment, null, ...kids) : null;
  }

  return function A2aObservationView({ node }) {
    const data = node?.data;
    if (!data || typeof data !== 'object') return null;
    const owner = data.owner || {};
    const snapshot = data.snapshot || { parts: [], texts: [], tools: [] };
    const last = data.lastCanonical || {};
    const status = data.status || classifyStatus(last, snapshot) || '';
    const entity = data.entity || last.item_kind || (last.event_type?.startsWith('interaction.') ? 'interaction' : 'item');
    return h('article', { 'aria-label': 'A2A 远端观察', style: box },
      h('strong', null, 'A2A 远端观察'),
      h('p', { style: muted }, `${entityLabel[entity] || '远端事件'}${status ? ` · ${stateLabel[status] || status}` : ''}`),
      h('p', { style: muted }, `源序号 ${data.sourceSeq ?? '—'}（非全局序号） · 会话序号 ${data.anchorSeq ?? '—'}`),
      h('p', { style: muted }, `来源 ${owner.kind || '—'} · ${owner.agentId ? redact(owner.agentId) : '—'}`),
      renderContent(last, snapshot, entity),
      h('p', { style: muted }, '仅展示远端已提交事实，不发起调用、不替代审批，文件与链接引用不会自动访问。'));
  };
}

/** The registerable ConversationNodeDefinition. Groups same sourceKey + one
 * canonical item/interaction lifecycle into a single read-only Context and
 * rebuilds a per-item accumulated snapshot from started/updated/replaced/
 * completed events. */
export const a2aObservationDefinition = {
  kind: A2A_OBSERVATION_KIND,
  target: 'chat',
  match(event) {
    if (event?.type !== 'agentkit/a2a-observation') return null;
    const parsed = parseObservation(event);
    if (!parsed) return null;
    const id = groupId(parsed.envelope, parsed.canonical);
    if (!id) return null;
    return { id, role: 'start' };
  },
  start(context, match) {
    const parsed = parseObservation(match.event);
    if (!parsed) return { first: match, latest: match, byId: {}, snapshot: null, lastCanonical: null };
    const snapshot = applyEventToSnapshot(null, parsed.canonical);
    return { first: match, latest: match, envelope: parsed.envelope,
      byId: { [parsed.canonical.event_id]: parsed.canonical }, events: [parsed.canonical],
      snapshot, lastCanonical: parsed.canonical };
  },
  update(context, match) {
    const state = context.state;
    const parsed = parseObservation(match.event);
    if (!parsed) return { ...state, latest: match };
    const canonical = parsed.canonical;
    if (Object.hasOwn(state.byId, canonical.event_id) || canonical.seq <= (state.lastCanonical?.seq ?? -1)) return state;
    const events = [...(state.events || []), canonical].slice(-MAX_EVENTS);
    // Keep the accumulated snapshot when bounded receipt history rolls over.
    const snapshot = applyEventToSnapshot(state.snapshot, canonical);
    return { ...state, latest: match, interactionRequest: canonical.request ?? state.interactionRequest ?? state.lastCanonical?.request,
      envelope: parsed.envelope, byId: Object.fromEntries(events.map(event => [event.event_id, true])), events,
      snapshot, lastCanonical: canonical };
  },
  buildViewNode(context) {
    if (!context.state) return null;
    const { first, latest, envelope, snapshot, lastCanonical } = context.state;
    if (!envelope || !lastCanonical) return null;
    const location = context.start?.location || first.location;
    const status = classifyStatus(lastCanonical, snapshot) || null;
    const entity = lastCanonical.item_kind === 'status' && snapshot?.parts.some(part => part?.data?.schema === 'execution.scope/v1') ? 'scope' : lastCanonical.item_kind
      || (lastCanonical.event_type?.startsWith('interaction.') ? 'interaction' : lastCanonical.event_type?.startsWith('continuation.') ? 'continuation' : 'item');
    const eventsLen = context.state.events?.length ?? 0;
    const current = context.current.get('chat');
    if (current?.data?.sourceKey === envelope.sourceKey && current?.data?.anchorSeq === first.event.seq
      && current?.data?.eventId === lastCanonical.event_id && current?.location === location) return current;
    return {
      key: context.key, id: context.id, kind: A2A_OBSERVATION_KIND, target: 'chat',
      anchorSeq: first.event.seq, location, visibility: 'visible',
      data: {
        contract: A2A_OBSERVATION_CONTRACT, sourceKey: envelope.sourceKey, owner: envelope.owner,
        eventId: envelope.eventId, sourceSeq: envelope.sourceSeq, anchorSeq: first.event.seq,
        entity, status, snapshot, lastCanonical: entity === 'interaction' && !lastCanonical.request && context.state.interactionRequest
          ? { ...lastCanonical, request: context.state.interactionRequest } : lastCanonical, eventsLength: eventsLen,
      },
    };
  },
};

/** Register both the business definition and maintained keyed renderer seat. */
export function mountA2aObservation(ctx, { React } = {}) {
  if (!ctx?.uiConversation?.events?.register) throw new Error('a2a_observation_mount_invalid');
  const View = createA2aObservationView({ React });
  if (!View || !ctx.slots?.inject || !ctx.slots?.register) throw new Error('a2a_observation_mount_invalid');
  const dispose = ctx.uiConversation.events.register(a2aObservationDefinition);
  let renderer;
  try {
    renderer = ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node', key: A2A_OBSERVATION_KIND,
    }, View));
  } catch (error) { dispose(); throw error; }
  return { dispose() { renderer(); dispose(); }, View, kind: A2A_OBSERVATION_KIND };
}
