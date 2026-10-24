/** Author tests for the A2A observation UI candidate. Not run by the
 *  implementer; parent runs them and wires the host renderer registration.
 *
 *  Uses shapes from tests/fixtures/a2a-canonical-reference.json and
 *  a2a-tool-activity-reference.json (verified field truth).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { a2aObservationDefinition, createA2aObservationView, mountA2aObservation,
  A2A_OBSERVATION_CONTRACT, A2A_OBSERVATION_KIND } from '../src/client/dsh/a2a-observation.mjs';

const HEX64 = 'a'.repeat(64);
const env = (canonical, { sourceSeq = canonical.seq, sourceKey = HEX64, kind = 'native', agentId = 'ag-1', sessionId = 'ses-1', eventId = canonical.event_id } = {}) =>
  ({ contract: A2A_OBSERVATION_CONTRACT, sourceKey, owner: { agentId, sessionId, kind }, eventId, sourceSeq, eventJson: JSON.stringify(canonical) });
const ev = (canonical, seq, { ignorable = true, ...rest } = {}) =>
  ({ type: 'agentkit/a2a-observation', seq, time: 1000, ignorable, data: env(canonical), ...rest });
const canon = (event_type, o = {}) => ({
  schema_version: 2, event_id: o.event_id || `evt-${event_type}-${o.seq ?? 0}`,
  event_type, seq: o.seq ?? 1, run_id: o.run_id || 'root', scope_id: o.scope_id || 'child',
  ...(o.item_id ? { item_id: o.item_id } : {}), ...(o.item_kind ? { item_kind: o.item_kind } : {}),
  ...(o.interaction_id ? { interaction_id: o.interaction_id } : {}),
  ...(o.interaction_kind ? { interaction_kind: o.interaction_kind } : {}),
  ...(o.op ? { op: o.op } : {}), ...(o.snapshot ? { snapshot: o.snapshot } : {}),
  ...(o.update ? { update: o.update } : {}), ...(o.request ? { request: o.request } : {}),
});
const def = a2aObservationDefinition;
const ctx = (state, { key = 'k', id = 'id', location = { kind: 'session' }, current = new Map() } = {}) =>
  ({ key, id, state, current, start: { location } });
const match = (c, seq) => ({ event: ev(c, seq), role: 'start', location: { kind: 'session' } });

test('local question lifecycle remains an inert status with no answer or remote-success claim', () => {
  for (const status of ['pending', 'awaiting_permission', 'operation_admitted', 'operation_denied', 'expired', 'withdrawn', 'rejected']) {
    const c = canon('item.completed', { seq: 1, item_id: 'local-question', item_kind: 'status', snapshot: { parts: [
      { content_type: 'data', part_id: 'status', data: { schema: 'agentkit.a2a-question-ledger/v1', status,
        interaction_id: 'interaction', target: 'research', deadline_at: 1000, answer: 'MUST_NOT_RENDER' } }] } });
    const state = def.start(ctx(undefined), match(c, 5));
    const node = def.buildViewNode(ctx(state));
    assert.equal(node.data.entity, 'question'); assert.equal(node.data.status, status);
    const tree = View({ node }), text = texts(tree);
    assert.match(text, /远端任务状态需单独核对/); assert.ok(!text.includes('MUST_NOT_RENDER'));
    assert.ok(!tags(tree).some(tag => ['button', 'textarea', 'input', 'a'].includes(tag)));
  }
});

// ---- match: envelope + canonical validation, safe ignore ---------------

test('match groups artifact lifecycle by sourceKey+item_id (source seq from 1)', () => {
  const c = canon('item.started', { item_id: 'i1', item_kind: 'artifact', seq: 1 });
  assert.deepEqual(def.match(ev(c, 5)), { id: `${HEX64}:i1`, role: 'start' });
});
test('match groups interaction by interaction_id', () => {
  const c = canon('interaction.requested', { interaction_id: 'ix1', interaction_kind: 'approval', seq: 1 });
  assert.equal(def.match(ev(c, 2))?.id, `${HEX64}:ix1`);
});
test('match returns null for run.* events (run-scope, not per-item)', () => {
  const c = canon('run.started', { seq: 0 }); // event_type starts with run.
  assert.equal(def.match(ev(c, 1)), null);
  const c2 = canon('run.completed', { seq: 1 });
  assert.equal(def.match(ev(c2, 2)), null);
});
test('match returns null for wrong type', () => {
  assert.equal(def.match({ type: 'agentkit/codex-tool', data: env(canon('item.started', { item_id: 'i', seq: 0 })) }), null);
  assert.equal(def.match(null), null);
});
test('match rejects non-ignorable events', () => {
  const c = canon('item.started', { item_id: 'i', item_kind: 'message', seq: 0 });
  assert.equal(def.match(ev(c, 1, { ignorable: false })), null);
});
test('match rejects surface-bearing events (surfaceOp / sourceEventSeqs)', () => {
  const c = canon('item.started', { item_id: 'i', item_kind: 'message', seq: 0 });
  assert.equal(def.match(ev(c, 1, { surfaceOp: 'append' })), null);
  assert.equal(def.match(ev(c, 1, { sourceEventSeqs: [0] })), null);
});
test('match safely ignores malformed envelopes (no throw)', () => {
  const good = env(canon('item.started', { item_id: 'i', item_kind: 'message', seq: 0 }));
  const bad = (data, extra) => def.match({ type: 'agentkit/a2a-observation', seq: 1, ignorable: true, data, ...extra });
  assert.equal(bad(null), null);
  assert.equal(bad({ ...good, contract: 'wrong' }), null);
  assert.equal(bad({ ...good, sourceKey: 'x' }), null);
  assert.equal(bad({ ...good, owner: null }), null);
  assert.equal(bad({ ...good, owner: { agentId: 'a', sessionId: 's', kind: 'bogus' } }), null);
  assert.equal(bad({ ...good, sourceSeq: -1 }), null);
  assert.equal(bad({ ...good, sourceSeq: 1.5 }), null);
  assert.equal(bad({ ...good, eventJson: 'bad' }), null);
  assert.equal(bad({ ...good, eventJson: JSON.stringify({ schema_version: 1, event_id: 'e', event_type: 'item.started', seq: 0 }) }), null);
  // envelope eventId must match canonical event_id
  assert.equal(bad({ ...good, eventId: 'different' }), null);
  // envelope sourceSeq must match canonical seq
  assert.equal(bad({ ...good, sourceSeq: 5 }), null);
  // no derivable entity id
  const noId = canon('item.started', { seq: 0 }); delete noId.item_id; delete noId.interaction_id;
  assert.equal(bad(env(noId)), null);
});

// ---- start/update: snapshot rebuild from real lifecycle ----------------

test('start builds snapshot from item.started (initial null → empty)', () => {
  const c = canon('item.started', { item_id: 'i1', item_kind: 'artifact', seq: 1 });
  const s = def.start(ctx(undefined), match(c, 5));
  assert.deepEqual(s.snapshot, { parts: [], texts: [], tools: [] });
  assert.equal(s.events.length, 1);
});
test('snapshot_replaced then updated then completed rebuilds the accumulated artifact content', () => {
  const i1 = 'item_a4107592d002d73a039cff55';
  const s0 = canon('item.started', { item_id: i1, item_kind: 'artifact', seq: 1 });
  const s1 = canon('item.snapshot_replaced', { item_id: i1, item_kind: 'artifact', seq: 2,
    snapshot: { parts: [{ content_type: 'text', part_id: 'p1', text: 'first' }] } });
  const s2 = canon('item.updated', { item_id: i1, item_kind: 'artifact', seq: 3, op: 'append',
    update: { content_type: 'text', part_id: 'p2', text: 'second' } });
  const s3 = canon('item.completed', { item_id: i1, item_kind: 'artifact', seq: 5,
    snapshot: { parts: [{ content_type: 'text', part_id: 'p1', text: 'authoritative' }, { content_type: 'data', part_id: 'p3', data: { number: 1.0 } }] } });
  let state = def.start(ctx(undefined), match(s0, 0));
  state = def.update(ctx(state), match(s1, 1));
  state = def.update(ctx(state), match(s2, 2));
  state = def.update(ctx(state), match(s3, 5));
  assert.equal(state.snapshot.texts.join(''), 'authoritative', 'completed snapshot authoritatively replaced provisional text');
  assert.equal(state.snapshot.parts.length, 2);
});
test('update is idempotent on duplicate event_id', () => {
  const c = canon('item.updated', { item_id: 'i', item_kind: 'message', seq: 1, op: 'replace',
    update: { content_type: 'text', part_id: 'p', text: 'a' } });
  let state = def.start(ctx(undefined), match(c, 1));
  const before = state.events.length;
  state = def.update(ctx(state), match(c, 1)); // same event_id
  assert.equal(state.events.length, before, 'duplicate event_id not re-added');
});
test('update tolerates an unparsable latest event without losing state', () => {
  const c = canon('item.started', { item_id: 'i', item_kind: 'message', seq: 1 });
  let state = def.start(ctx(undefined), match(c, 1));
  const broken = { event: ev(c, 2), role: 'update', location: { kind: 'session' } };
  broken.event.data = { ...env(c), eventJson: 'bad' };
  state = def.update(ctx(state), broken);
  assert.equal(state.events.length, 1, 'broken event ignored');
});

// ---- buildViewNode: global anchor + sourceSeq label + entity/status ----

test('buildViewNode uses outer Session seq as anchorSeq; sourceSeq is label only', () => {
  const c = canon('item.completed', { item_id: 'i', item_kind: 'message', seq: 4,
    snapshot: { parts: [{ content_type: 'text', part_id: 'p', text: 'done' }] } });
  const state = def.start(ctx(undefined), match(c, 42));
  const node = def.buildViewNode(ctx(state, { location: { kind: 'session' } }));
  assert.equal(node.kind, A2A_OBSERVATION_KIND);
  assert.equal(node.target, 'chat');
  assert.equal(node.anchorSeq, 42, 'global Session seq is the anchor');
  assert.equal(node.data.anchorSeq, 42);
  assert.equal(node.data.sourceSeq, 4, 'sourceSeq kept as label');
  assert.equal(node.data.status, 'completed');
  assert.equal(node.data.entity, 'message');
  assert.equal(node.visibility, 'visible');
});
test('buildViewNode reuses an actual unchanged node at the same location', () => {
  const c = canon('item.started', { item_id: 'i', item_kind: 'message', seq: 1 });
  const state = def.start(ctx(undefined), match(c, 5));
  const location = { kind: 'session' };
  const existing = def.buildViewNode(ctx(state, { location }));
  const node = def.buildViewNode(ctx(state, { location, current: new Map([['chat', existing]]) }));
  assert.equal(node, existing);
});
test('buildViewNode returns null when no parsed envelope', () => {
  const broken = { event: { type: 'agentkit/a2a-observation', seq: 1, ignorable: true, data: { ...env(canon('item.started', { item_id: 'i', item_kind: 'message', seq: 0 })), eventJson: 'bad' } }, role: 'start', location: { kind: 'session' } };
  const state = def.start(ctx(undefined), broken);
  assert.equal(def.buildViewNode(ctx(state)), null);
});

// ---- renderer: plain-text, no buttons/anchors, redaction ---------------

const fakeReact = { createElement: (tag, props, ...kids) => ({ tag, props: props || {}, kids }) };
const walk = (node, out = []) => { if (!node) return out; if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (typeof node !== 'object') return out; out.push(node); for (const k of node.kids || []) walk(k, out); return out; };
const View = createA2aObservationView({ React: fakeReact });
const texts = tree => walk(tree).map(n => (n.kids || []).join('')).filter(Boolean).join(' ');
const tags = tree => walk(tree).map(n => n.tag);

test('renderer factory returns null without React', () => {
  assert.equal(createA2aObservationView({}), null);
  assert.equal(createA2aObservationView(), null);
});
test('renderer emits no button/anchor/input', () => {
  const c = canon('interaction.requested', { interaction_id: 'ix', interaction_kind: 'approval', seq: 1, request: { request_type: 'approval', prompt: 'ok?' } });
  const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1, anchorSeq: 1, entity: 'interaction', status: 'requested', snapshot: { parts: [], texts: [], tools: [] }, lastCanonical: c } };
  const t = View({ node });
  assert.ok(!tags(t).includes('button'));
  assert.ok(!tags(t).includes('a'));
  assert.ok(!tags(t).includes('input'));
});
test('renderer shows tool_call arguments and tool_result from snapshot.parts', () => {
  const c = canon('item.completed', { item_id: 'i', item_kind: 'tool_result', seq: 1,
    snapshot: { parts: [{ content_type: 'tool_result', part_id: 'p', call_id: 'c', result: { ok: true }, is_error: false }] } });
  const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1, anchorSeq: 2, entity: 'tool_result', status: 'completed', snapshot: { parts: c.snapshot.parts, texts: [], tools: [{ kind: 'result', call_id: 'c', result: { ok: true }, is_error: false }] }, lastCanonical: c } };
  const t = texts(View({ node }));
  assert.ok(t.includes('结果'));
  assert.ok(t.includes('ok') || t.includes('"ok"'));
});
test('renderer redacts all secrets, not just one (token + api_key in one string)', () => {
  const c = canon('item.completed', { item_id: 'i', item_kind: 'tool_result', seq: 1,
    snapshot: { parts: [{ content_type: 'tool_result', part_id: 'p', call_id: 'c', result: { note: 'token=abc123def456 api_key=sk-xyz987ghi' }, is_error: false }] } });
  const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1, anchorSeq: 2, entity: 'tool_result', status: 'completed', snapshot: { parts: c.snapshot.parts, texts: [], tools: [{ kind: 'result', call_id: 'c', result: c.snapshot.parts[0].result, is_error: false }] }, lastCanonical: c } };
  const t = texts(View({ node }));
  assert.equal(t.includes('abc123def456'), false, 'first secret redacted');
  assert.equal(t.includes('sk-xyz987ghi'), false, 'second secret redacted');
  assert.ok((t.match(/\[已隐藏\]/g) || []).length >= 2, 'both redacted');
});
test('renderer hides internal URLs (no actionable link, host not surfaced)', () => {
  const c = canon('item.completed', { item_id: 'i', item_kind: 'message', seq: 1,
    snapshot: { parts: [{ content_type: 'text', part_id: 'p', text: 'see https://internal.host:8080/path?token=secret#x' }] } });
  const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1, anchorSeq: 3, entity: 'message', status: 'completed', snapshot: { parts: c.snapshot.parts, texts: ['see https://internal.host:8080/path?token=secret#x'], tools: [] }, lastCanonical: c } };
  const t = View({ node });
  assert.ok(!tags(t).includes('a'), 'no anchor');
  const txt = texts(t);
  assert.ok(!txt.includes('https://internal.host'), 'URL not surfaced');
  assert.ok(!txt.includes('token=secret'), 'query secret not shown');
  assert.ok(txt.includes('[内部链接已隐藏]') || txt.includes('[已隐藏]'), 'URL hidden');
});
test('renderer shows remote interaction prompt as inert text (approval + structured_input), no buttons', () => {
  for (const kind of ['approval', 'structured_input']) {
    const c = canon('interaction.requested', { interaction_id: 'ix', interaction_kind: kind, seq: 1,
      request: { request_type: kind, prompt: '请确认', ...(kind === 'approval' ? { kind: 'tool', detail: { risk: 'high' } } : { schema: { type: 'string' } }) } });
    const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'dsh' }, sourceSeq: 1, anchorSeq: 4, entity: 'interaction', status: 'requested', snapshot: { parts: [], texts: [], tools: [] }, lastCanonical: c } };
    const t = View({ node });
    assert.ok(!tags(t).includes('button'), `${kind}: no button`);
    const txt = texts(t);
    assert.ok(txt.includes('请确认'), `${kind}: prompt shown`);
    assert.ok(txt.includes('不代为决定'), `${kind}: inert notice`);
  }
});
test('renderer displays scope descriptor status + agent name from data part', () => {
  const c = canon('item.completed', { item_id: 'item_scope', item_kind: 'status', seq: 1,
    snapshot: { parts: [{ content_type: 'data', part_id: 'p', data: { status: 'completed', agent: { name: 'helper', version_id: 'v1' } } }] } });
  const node = { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1, anchorSeq: 5, entity: 'scope', status: 'completed', snapshot: { parts: c.snapshot.parts, texts: [], tools: [{ kind: 'data', data: { status: 'completed', agent: { name: 'helper', version_id: 'v1' } } }] }, lastCanonical: c } };
  const txt = texts(View({ node }));
  assert.ok(txt.includes('已完成'), 'status shown');
  assert.ok(txt.includes('helper'), 'agent name shown');
});
test('input resolution renders committed outcome separately from answer content', () => {
  for (const [outcome, label] of [['submitted', '输入已提交'], ['canceled', '输入已取消']]) {
    const c = { ...canon('interaction.resolved', { interaction_id: 'ix', interaction_kind: 'structured_input' }),
      source: { metadata: { host_outcome: outcome } }, response: { response_type: 'structured_input', data: 'private-answer' } };
    const tree = View({ node: { data: { owner: { agentId: 'a', sessionId: 's', kind: 'native' }, sourceSeq: 1,
      anchorSeq: 4, entity: 'interaction', status: 'resolved', snapshot: { parts: [], texts: [], tools: [] }, lastCanonical: c } } });
    assert.ok(texts(tree).includes(label)); assert.ok(!texts(tree).includes('private-answer'));
    assert.ok(!tags(tree).includes('button'));
  }
});
test('renderer returns null on a malformed node', () => {
  assert.equal(View({}), null);
  assert.equal(View({ node: { data: null } }), null);
});

// ---- mount helper -------------------------------------------------------

test('mountA2aObservation registers the definition and returns renderer + kind + dispose', () => {
  let registered = null;
  let slot;
  const c = { uiConversation: { events: { register: (d) => { registered = d; return () => {}; } } },
    slots: { inject: (name, callback) => { assert.equal(name, 'conversation.chat.node'); return callback(); },
      register: (options, View) => { slot = { options, View }; return () => {}; } } };
  const mounted = mountA2aObservation(c, { React: fakeReact });
  assert.equal(registered, a2aObservationDefinition);
  assert.equal(mounted.kind, A2A_OBSERVATION_KIND);
  assert.equal(typeof mounted.View, 'function');
  assert.equal(typeof mounted.dispose, 'function');
  assert.equal(slot.options.key, A2A_OBSERVATION_KIND); assert.equal(slot.View, mounted.View);
});
test('mountA2aObservation throws without a register API', () => {
  assert.throws(() => mountA2aObservation({}, { React: fakeReact }), { message: 'a2a_observation_mount_invalid' });
  assert.throws(() => mountA2aObservation({ uiConversation: {} }, { React: fakeReact }), { message: 'a2a_observation_mount_invalid' });
});

test('source zero and invalid physical anchors are rejected; physical zero is valid', () => {
  const good = canon('item.started', { item_id: 'item', seq: 1 });
  assert.ok(def.match(ev(good, 0)));
  assert.equal(def.match(ev({ ...good, seq: 0 }, 0)), null);
  for (const anchor of [-1, 0.5, NaN, undefined]) assert.equal(def.match(ev(good, anchor)), null);
});
test('a rolling receipt window keeps the accepted snapshot and publishes later updates', () => {
  const location = { kind: 'session' };
  let state = def.start(ctx(undefined), match(canon('item.snapshot_replaced', { item_id: 'i', item_kind: 'artifact', seq: 1,
    snapshot: { parts: [{ content_type: 'text', part_id: 'kept', text: 'retained first part' }] } }), 0));
  let previous;
  for (let seq = 2; seq <= 150; seq++) {
    state = def.update(ctx(state), match(canon('item.updated', { item_id: 'i', item_kind: 'artifact', seq, op: 'replace',
      update: { content_type: 'text', part_id: 'latest', text: 'value ' + seq } }), seq + 10));
    const node = def.buildViewNode(ctx(state, { location, current: new Map(previous ? [['chat', previous]] : []) }));
    assert.notEqual(node, previous); assert.equal(node.data.sourceSeq, seq);
    assert.equal(node.data.snapshot.texts.join('|'), 'retained first part|value ' + seq); previous = node;
  }
  assert.equal(state.events.length, 128); assert.equal(Object.keys(state.byId).length, 128);
});
test('initial scope descriptors and failed terminal descriptors keep actual remote status', () => {
  const initial = canon('item.started', { item_id: 'scope', item_kind: 'status', seq: 1 });
  initial.initial = { parts: [{ content_type: 'data', part_id: 'descriptor', data: {
    schema: 'execution.scope/v1', status: 'submitted', agent: { name: 'helper' } } }] };
  let state = def.start(ctx(undefined), match(initial, 0));
  let node = def.buildViewNode(ctx(state)); assert.equal(node.data.entity, 'scope'); assert.equal(node.data.status, 'submitted');
  const terminal = canon('item.completed', { item_id: 'scope', item_kind: 'status', seq: 2,
    snapshot: { parts: [{ ...initial.initial.parts[0], data: { ...initial.initial.parts[0].data, status: 'failed' } }] } });
  state = def.update(ctx(state), match(terminal, 1)); node = def.buildViewNode(ctx(state));
  assert.equal(node.data.status, 'failed'); assert.match(texts(View({ node })), /失败/);
});
test('resolved remote interaction retains its question without creating a decision control', () => {
  const question = canon('interaction.requested', { interaction_id: 'question', seq: 1,
    request: { request_type: 'approval', prompt: 'Original remote question' } });
  let state = def.start(ctx(undefined), match(question, 0));
  state = def.update(ctx(state), match(canon('interaction.resolved', { interaction_id: 'question', seq: 2 }), 1));
  const node = def.buildViewNode(ctx(state)); assert.equal(node.data.status, 'resolved');
  const tree = View({ node }); assert.match(texts(tree), /Original remote question/); assert.ok(!tags(tree).includes('button'));
});
test('files expose bounded metadata and never raw bytes or URI; structured short credentials are hidden', () => {
  const complete = canon('item.completed', { item_id: 'artifact', item_kind: 'artifact', seq: 1,
    snapshot: { parts: [{ content_type: 'artifact', name: 'report.bin', data: { base64: 'PRIVATE_RAW_BYTES', uri: 'file:///private/report' } },
      { content_type: 'data', data: { token: 'tiny', api_key: 'x', ok: true } }] } });
  const node = def.buildViewNode(ctx(def.start(ctx(undefined), match(complete, 0))));
  const tree = View({ node }), output = texts(tree);
  assert.match(output, /report.bin/); assert.match(output, /已隐藏/);
  assert.doesNotMatch(output, /PRIVATE_RAW_BYTES|file:\/\/\/private|tiny|"api_key":"x"/);
  assert.ok(!tags(tree).includes('a'));
});
