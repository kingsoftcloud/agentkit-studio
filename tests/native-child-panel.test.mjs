import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChildrenState } from '../src/client/state/native-children.mjs';
import { createNativeChildPanel } from '../src/client/dsh/native-children.mjs';
import { createProductClient } from '../src/remote/control-client.mjs';
import { createStudioHostRemote } from '../src/host-remote.mjs';
import { createSessionRoutes } from '../src/host/routes/sessions.mjs';

const contract = 'agentkit.studio-native-child-history/v1';
const task = { childRunId: 'child', sessionId: 'child-session', parentRunId: 'parent', role: 'reader', phase: 'requesting_model',
  goalPreview: 'Read actual evidence', goalComplete: true, delivery: 'foreground', canPromote: true, resultAvailable: false,
  usage: { modelCalls: 1, toolCalls: 0, inputTokens: 2, outputTokens: 3 }, usageIncludedInParent: false, usageComplete: false };
const page = (extra = {}) => ({ contract, sessionId: 'session', runId: 'parent', tasks: [task], inventoryDigest: 'a'.repeat(64),
  offset: 0, nextOffset: 1, totalTasks: 1, complete: true, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('child remote-operation descriptors are read-only and must match their exact parent and child', async () => {
  const descriptor = { runId: task.parentRunId, childRunId: task.childRunId, childAgentId: 'agent:child:reader',
    childSessionId: task.sessionId, operationKey: 'original-operation', callId: 'original-call' };
  let data = page({ tasks: [{ ...task, a2aTasks: [descriptor] }] });
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', hostRemote: { nativeChildHistory: async () => data } });
  await client.refresh(); assert.equal(client.getSnapshot().error, ''); const accepted = client.getSnapshot().page;
  for (const field of ['runId', 'childRunId', 'childSessionId']) {
    data = page({ tasks: [{ ...task, a2aTasks: [{ ...descriptor, [field]: 'foreign' }] }] });
    await client.refresh(); assert.equal(client.getSnapshot().page, accepted); assert.match(client.getSnapshot().error, /读取失败/);
  }
  client.dispose();
});

test('a lost promotion reply retains the exact original command across parent advancement and explicit retry', async () => {
  const commands = []; let current = page(), lost = true;
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', commandId: () => 'one-command', hostRemote: {
    nativeChildHistory: async () => current,
    promoteNativeChild: async payload => { commands.push(structuredClone(payload)); if (lost) { lost = false; throw Error('lost response'); }
      return { commandId: payload.commandId, status: 'duplicate' }; },
  } });
  await client.refresh(); await client.promote(task);
  assert.equal(commands.length, 1); assert.equal(client.getSnapshot().pending.commandId, 'one-command');
  current = page({ runId: 'new-parent', tasks: [{ ...task, canPromote: false }] }); await client.refresh();
  assert.equal(commands.length, 1, 'reads never automatically replay a command');
  await client.retryPromotion(); assert.deepEqual(commands[1], commands[0]);
  assert.equal(commands[1].runId, 'parent'); assert.equal(client.getSnapshot().pending, null);
  client.dispose();
});

for (const action of ['send', 'cancel']) test(`a lost ${action} reply retains its original child, revision, text and command on retry`, async () => {
  const commands = []; let current = page(), lost = true;
  const active = { ...task, canCancel: true, canSendInput: true, goalRevision: 2 };
  current = page({ tasks: [active] });
  const method = action === 'send' ? 'sendNativeChildInput' : 'cancelNativeChild';
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', commandId: () => `${action}-one-command`, hostRemote: {
    nativeChildHistory: async () => current,
    [method]: async payload => { commands.push(structuredClone(payload)); if (lost) { lost = false; throw Error('lost reply'); }
      return { commandId: payload.commandId, status: 'duplicate' }; },
  } });
  await client.refresh(); await (action === 'send' ? client.sendInput(active, '核对 😀 原文件') : client.cancel(active));
  assert.equal(commands.length, 1); assert.equal(client.getSnapshot().pendingAction, action);
  current = page({ runId: 'next-parent', tasks: [{ ...active, canPromote: false, canCancel: false, canSendInput: false, goalRevision: 3 }] });
  await client.refresh(); assert.equal(commands.length, 1);
  await client.retryControl(); assert.deepEqual(commands[1], commands[0]); assert.equal(commands[1].runId, 'parent');
  if (action === 'send') { assert.equal(commands[1].expectedGoalRevision, 2); assert.equal(commands[1].text, '核对 😀 原文件'); }
  assert.equal(client.getSnapshot().pending, null); client.dispose();
});

test('history and result paging reject changed inventories and payload identities without replacing accepted data', async () => {
  let invalid = false; const calls = [];
  const delivered = { ...task, canPromote: false, resultAvailable: true, phase: 'completed' };
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', hostRemote: {
    nativeChildHistory: async input => { calls.push(input); return input.offset ? page({ inventoryDigest: 'b'.repeat(64), offset: 1, nextOffset: 2, totalTasks: 2 })
      : page({ tasks: [delivered], totalTasks: 2, complete: false }); },
    nativeChildResult: async input => ({ contract, sessionId: 'session', runId: 'parent', task: { ...delivered, ...(invalid ? { childRunId: 'foreign' } : {}) },
      text: input.offset ? '后半段' : '😀首段', offset: input.offset ?? 0, nextOffset: input.offset ? 6 : 3, totalChars: 6,
      complete: Boolean(input.offset), resultDigest: 'c'.repeat(64) }),
  } });
  await client.refresh(); await client.next();
  assert.deepEqual(client.getSnapshot().page.tasks, [delivered]); assert.match(client.getSnapshot().error, /目录/);
  assert.equal(calls[1].inventoryDigest, 'a'.repeat(64)); assert.equal(calls[1].offset, 1);
  await client.read(delivered); await client.read(delivered, true); assert.equal(client.getSnapshot().detail.text, '😀首段后半段');
  invalid = true; await client.read(delivered); assert.match(client.getSnapshot().error, /读取失败/);
  assert.equal(client.getSnapshot().detail.text, '😀首段后半段'); client.dispose();
});

test('mixed-owner historical results use the original parent and reject another parent in the reply', async () => {
  const historic = { ...task, childRunId: 'historic-child', parentRunId: 'historic-managed-parent',
    canPromote: false, phase: 'completed', resultAvailable: true };
  const calls = []; let wrong = false;
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', hostRemote: {
    nativeChildHistory: async () => page({ tasks: [historic] }),
    nativeChildResult: async input => { calls.push(input); return { contract, sessionId: 'session',
      runId: wrong ? 'parent' : historic.parentRunId, task: { ...historic, parentRunId: wrong ? 'parent' : historic.parentRunId },
      text: input.offset ? '后段' : '😀前段', offset: input.offset ?? 0, nextOffset: input.offset ? 5 : 3,
      totalChars: 5, complete: Boolean(input.offset), resultDigest: 'c'.repeat(64) }; },
  } });
  await client.refresh(); await client.read(historic); await client.read(historic, true);
  assert.ok(calls.every(call => call.runId === historic.parentRunId));
  assert.equal(client.getSnapshot().error, ''); assert.equal(client.getSnapshot().detail.text, '😀前段后段');
  const accepted = client.getSnapshot().detail; wrong = true; await client.read(historic);
  assert.equal(client.getSnapshot().detail, accepted); assert.match(client.getSnapshot().error, /读取失败/); client.dispose();
});

test('releasing a panel aborts its reads and suppresses late results and control retries', async () => {
  let done, signal, updates = 0, commands = 0;
  const client = createNativeChildrenState({ agentId: 'agent', sessionId: 'session', hostRemote: {
    nativeChildHistory: (_input, current) => { signal = current; return new Promise(resolve => { done = resolve; }); },
    promoteNativeChild: async () => { commands++; },
  } });
  client.subscribe(() => { updates++; }); const pending = client.refresh(); client.dispose();
  const previous = updates; done(page()); await pending; await client.promote(task); await client.retryPromotion();
  assert.equal(signal.aborted, true); assert.equal(updates, previous); assert.equal(client.getSnapshot().page, null); assert.equal(commands, 0);
});

test('history routes validate requests and cancellation before entering the lazy Host', async () => {
  let entries = 0, reads = 0;
  const routes = createSessionRoutes({ getNativeHost: async () => { entries++; return {
    childHistory: input => { reads++; return input; }, childResult: input => { reads++; return input; },
  }; } });
  const input = { agentId: 'agent', sessionId: 'session' };
  for (const [method, validInput] of [
    ['sessions/native-child-history', input], ['sessions/native-child-result', { ...input, childRunId: 'child' }],
  ]) {
    for (const invalid of [[], { ...validInput, scope: {} }, { ...validInput, sessionId: '' }, { ...validInput, offset: -1 },
      { ...validInput, limit: 16001 }, { ...validInput, runId: 1 }])
      await assert.rejects(routes(method, invalid), { code: 'STUDIO_NATIVE_CHILD_HISTORY_INVALID' });
    const owner = new AbortController(); owner.abort();
    await assert.rejects(routes(method, validInput, owner.signal), { name: 'AbortError' });
  }
  await assert.rejects(routes('sessions/native-child-history', { ...input, inventoryDigest: 'a' }), { code: 'STUDIO_NATIVE_CHILD_HISTORY_INVALID' });
  assert.equal(entries, 0); assert.equal(reads, 0);
  assert.deepEqual(await routes('sessions/native-child-history', input), { ok: true, value: input });
  let finish;
  const waiting = createSessionRoutes({ getNativeHost: () => new Promise(resolve => { finish = resolve; }) });
  const owner = new AbortController(), pending = waiting('sessions/native-child-result', { ...input, childRunId: 'child' }, owner.signal);
  owner.abort(); finish({ childResult: () => { reads++; } });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(reads, 1);
});

test('HTTP panel transport retains authentication and domain envelopes without falling back to another executor', async () => {
  const calls = [], controller = new AbortController(); let reply = { ok: true, value: page() };
  const remote = createStudioHostRemote({ baseUrl: 'http://localhost', sessionToken: 'session-auth', csrfToken: 'csrf-auth',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ result: reply }) }; },
  });
  const input = { agentId: 'agent', sessionId: 'session' };
  assert.deepEqual(await remote.nativeChildHistory(input, controller.signal), page());
  const { url, init } = calls[0]; assert.equal(url, 'http://localhost/agentkit'); assert.equal(init.credentials, 'include');
  assert.equal(init.signal, controller.signal); assert.equal(init.headers.get('X-AgentKit-Session'), 'session-auth');
  assert.equal(init.headers.get('X-CSRF-Token'), 'csrf-auth');
  assert.deepEqual(JSON.parse(init.body), { method: 'sessions/native-child-history', payload: input });
  reply = { ok: false, error: { code: 'CHILD_UNAVAILABLE', message: 'unavailable' } };
  await assert.rejects(remote.nativeChildResult({ ...input, childRunId: 'missing' }), { code: 'CHILD_UNAVAILABLE' });
  assert.equal(calls.length, 2);
});

for (const [name, create] of [
  ['browser', connection => createProductClient(connection, { window: { location: { origin: 'http://localhost', hash: '' } } })],
  ['Node', connection => createStudioHostRemote({ connection })],
]) test(`${name} panel calls the authenticated shared operations and carries cancellation outside JSON`, async () => {
  const calls = [], signal = new AbortController().signal;
  const remote = create({ rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: page() }; } } });
  const input = { agentId: 'agent', sessionId: 'session' };
  await remote.nativeChildHistory(input, signal); await remote.nativeChildResult({ ...input, childRunId: 'child' }, signal);
  await remote.promoteNativeChild({ ...input, runId: 'parent', childRunId: 'child', commandId: 'one' }, signal);
  await remote.sendNativeChildInput({ ...input, runId: 'parent', childRunId: 'child', commandId: 'two', text: 'guide', expectedGoalRevision: 0 }, signal);
  await remote.cancelNativeChild({ ...input, runId: 'parent', childRunId: 'child', commandId: 'three' }, signal);
  await remote.dshA2aTaskHistory(input, signal);
  await remote.controlDshA2aTask({ ...input, agentRevision: 1, buildId: null, operationKey: 'dsh-a2a:call', callId: 'call', commandId: 'four', kind: 'cancel' }, signal);
  assert.deepEqual(calls.map(call => call[1]), ['sessions/native-child-history', 'sessions/native-child-result', 'sessions/native-child-promote', 'sessions/native-child-send', 'sessions/native-child-cancel',
    'sessions/dsh-a2a-history', 'sessions/dsh-a2a-control']);
  assert.ok(calls.every(call => call[0] === '/agentkit' && call[3] === signal));
});

function hooks(Component, React) {
  const states = [], effects = []; let cursor = 0, effectCursor = 0;
  return { render(props) {
    cursor = 0; effectCursor = 0; const pending = [];
    React.useState = initial => { const index = cursor++; if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
    React.useEffect = (run, deps) => { const index = effectCursor++, old = effects[index];
      if (old && deps.every((value, i) => value === old.deps[i])) return;
      pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: run() }; }); };
    const output = Component(props); pending.forEach(run => run()); return output;
  }, dispose() { effects.forEach(effect => effect.cleanup?.()); } };
}
const walk = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(walk)] : [];

test('the actual header panel renders saved history, reads results and exposes only current admitted promotion', async () => {
  // Hook calls delegate at invocation time so each mounted component has its own scope.
  const dispatcher = {}, React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: (...args) => dispatcher.useState(...args), useEffect: (...args) => dispatcher.useEffect(...args) };
  const calls = [], controls = [], recoveries = [], active = { ...task, canSendInput: true, canCancel: true, goalRevision: 2 };
  const recovery = { contract: 'agentkit.studio-native-recovery/v1', agentId: 'local-agent', sessionId: 'session', runId: 'original-run',
    state: 'available', canResume: true, accounting: { contract: 'agentkit.studio-native-usage/v1', runId: 'original-run',
      snapshotRevision: 4, own: { modelCalls: 2, toolCalls: 1, inputTokens: 4, outputTokens: 6, cost: 0 },
      descendant: { modelCalls: 1, toolCalls: 2, inputTokens: 7, outputTokens: 9, cost: .25 },
      total: { modelCalls: 3, toolCalls: 3, inputTokens: 11, outputTokens: 15, cost: .25 },
      final: false, incomplete: true, complete: false },
    memoryExtraction: { contract: 'agentkit.studio-native-memory-extraction/v1', agentId: 'local-agent', sessionId: 'session', cursor: null,
      jobs: [{ jobId: 'memory-budget', parentRunId: 'original-run', status: 'error',
        usage: { modelCalls: 5, toolCalls: 5, inputTokens: 55, outputTokens: 35, cost: 0 },
        errorCode: 'native_memory_extraction_budget_exhausted', createdAt: 1, updatedAt: 2 }] } };
  const historic = { ...task, childRunId: 'old-child', parentRunId: 'old-parent', canPromote: false, resultAvailable: true, phase: 'completed' };
  const Panel = createNativeChildPanel({ ui: { React, ResourceDialog: 'dialog', buttonStyle: () => ({}) },
    setInterval: () => 1, clearInterval() {}, hostRemote: {
      agents: async () => ({ items: [{ metadata: { id: 'local-agent', local: true }, spec: { runtime: { type: 'harness' } } }] }),
      nativeChildHistory: async () => page({ tasks: [active, historic], nextOffset: 2, totalTasks: 2 }),
      nativeRecoveryStatus: async () => recovery,
      resumeNativeRun: async input => { recoveries.push(input); return { ...recovery, state: 'recovering', canResume: false }; },
      sendNativeChildInput: async input => { controls.push(['send', input]); return { commandId: input.commandId, status: 'accepted' }; },
      cancelNativeChild: async input => { controls.push(['cancel', input]); return { commandId: input.commandId, status: 'accepted' }; },
      nativeChildResult: async input => { calls.push(input); return { contract, sessionId: 'session', runId: 'old-parent', task: historic,
        text: '<script>untrusted task prose</script>', complete: true, offset: 0,
        nextOffset: [...'<script>untrusted task prose</script>'].length, totalChars: [...'<script>untrusted task prose</script>'].length, resultDigest: 'c'.repeat(64) }; },
    } });
  const outer = hooks(Panel, dispatcher), props = { sessionId: 'session', useSessions: select => select({ byId: { session: { projectionValues: { agentPreset: 'agentkit-studio-agent-local-agent-r1-hash' } } } }) };
  outer.render(props); await tick(); const header = outer.render(props);
  assert.equal(header.type, 'fragment'); assert.equal(header.children.length, 2);
  const [mounted, remoteTasks] = header.children;
  assert.equal(typeof mounted.type, 'function'); assert.equal(typeof remoteTasks.type, 'function');
  assert.deepEqual([mounted.props.agentId, remoteTasks.props.agentId], ['local-agent', 'local-agent']);
  assert.deepEqual([mounted.props.sessionId, remoteTasks.props.sessionId], ['session', 'session']);
  const child = hooks(mounted.type, dispatcher); child.render(mounted.props);
  let tree = child.render(mounted.props); walk(tree).find(node => node.type === 'button' && node.children.includes('运行与子任务')).props.onClick();
  child.render(mounted.props); await tick(); tree = child.render(mounted.props);
  assert.equal(recoveries.length, 0, 'opening and refreshing a panel never resumes a Run');
  assert.ok(walk(tree).some(node => node.props['aria-label'] === 'Native 运行用量'));
  assert.ok(walk(tree).some(node => node.children.includes('运行用量（统计不完整，显示已知用量）：模型 3 次 · 工具 3 次 · 输入 11 / 输出 15 tokens。')));
  assert.ok(walk(tree).some(node => node.children.includes('包含本运行、工具内模型调用及已结算的子任务用量。')));
  const memory = walk(tree).find(node => node.props['aria-label'] === '自动记忆提炼');
  assert.ok(memory);
  const memoryText = walk(memory).flatMap(node => node.children.filter(child => typeof child === 'string')).join('');
  assert.match(memoryText, /模型 5 次.*输入 55 \/ 输出 35 tokens/);
  assert.match(memoryText, /已达到提炼预算上限/);
  assert.doesNotMatch(memoryText, /native_memory_extraction_budget_exhausted/);
  recovery.error = { code: 'NATIVE_EXECUTION_NOT_COMPLETED', message: '模型服务返回不可恢复的错误，请检查模型配置和凭据。' };
  walk(tree).find(node => node.type === 'button' && node.children.includes('刷新')).props.onClick();
  await tick(); tree = child.render(mounted.props);
  assert.ok(walk(tree).some(node => node.props.role === 'alert' && node.children.includes(recovery.error.message)));
  delete recovery.error;
  walk(tree).find(node => node.type === 'button' && node.children.includes('刷新')).props.onClick();
  await tick(); tree = child.render(mounted.props);
  walk(tree).find(node => node.type === 'button' && node.children.includes('恢复原运行')).props.onClick(); await tick(); tree = child.render(mounted.props);
  assert.deepEqual(recoveries, [{ agentId: 'local-agent', sessionId: 'session', runId: 'original-run' }]);
  assert.equal(walk(tree).filter(node => node.type === 'button' && node.children.includes('转为后台')).length, 1);
  assert.ok(walk(tree).some(node => node.children.includes(' · 历史轮次')));
  walk(tree).find(node => node.type === 'button' && node.children.includes('查看结果')).props.onClick(); await tick(); tree = child.render(mounted.props);
  assert.equal(calls[0].childRunId, 'old-child');
  assert.equal(calls[0].runId, 'old-parent');
  assert.ok(walk(tree).some(node => node.type === 'pre' && node.children.includes('<script>untrusted task prose</script>')));
  assert.equal(walk(tree).some(node => node.type === 'script' || node.props.dangerouslySetInnerHTML), false);
  assert.equal(walk(tree).filter(node => node.type === 'button' && node.children.includes('停止子任务')).length, 1);
  walk(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Inspect the source 😀' } }); tree = child.render(mounted.props);
  walk(tree).find(node => node.type === 'button' && node.children.includes('发送指导')).props.onClick(); await tick(); tree = child.render(mounted.props);
  assert.equal(controls[0][0], 'send'); assert.equal(controls[0][1].text, 'Inspect the source 😀'); assert.equal(controls[0][1].expectedGoalRevision, 2);
  walk(tree).find(node => node.type === 'button' && node.children.includes('停止子任务')).props.onClick(); await tick();
  assert.equal(controls[1][0], 'cancel'); assert.equal(controls[1][1].childRunId, 'child');
  const changed = { sessionId: 'another', useSessions: props.useSessions };
  assert.equal(outer.render(changed), null, 'never render an old Agent binding in a newly selected Session');
  await tick();
  assert.equal(outer.render(changed), null, 'an unbound Session has no local Native child controls');
  child.dispose(); outer.dispose();
});
