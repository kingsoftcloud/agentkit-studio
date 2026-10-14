import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createAutomationPage } from '../src/client/pages/automation.mjs';
test('editing a scheduled instant preserves its local wall clock time', () => {
  const moduleUrl = new URL('../src/client/state/automation-data.mjs', import.meta.url).href;
  const value = execFileSync(process.execPath, ['--input-type=module', '-e', `import { localDateTimeValue } from ${JSON.stringify(moduleUrl)}; process.stdout.write(localDateTimeValue('2026-10-07T05:00:00.000Z'));`], {env:{...process.env,TZ:'Asia/Shanghai'},encoding:'utf8'});
  assert.equal(value,'2026-10-07T13:00');
});
test('a blank one-time schedule is refused instead of silently selecting one hour later', async () => {
  const ui = harness(); await ui.ready();
  let submitted = 0; ui.api.createSchedule = async () => { submitted++; };
  ui.buttons('新建自动化')[0].props.onClick(); await ui.settle();
  const field = label => ui.nodes().find(node => node.type === 'label' && node.children[0] === label)?.children.find(node => node && typeof node === 'object');
  field('任务名称').props.onChange({ target: { value: 'Test' } });
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Test' } });
  field('触发方式').props.onChange({ target: { value: 'once' } }); await ui.settle();
  assert.equal(field('执行时间').props.value, '');
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.settle();
  assert.equal(submitted, 0);
  assert.ok(ui.nodes().some(node => node.props.role === 'alert' && ui.text(node) === '请选择未来的执行时间。'));
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const task = id => ({ taskId: id, displayName: `Task ${id}`, enabled: true, revision: 1,
  target: { agentId: 'ar-test' }, schedule: { kind: 'interval', everySeconds: 60 },
  nextRunAt: new Date(Date.now() - 1000).toISOString(), command: { payload: { content: 'A saved prompt' } } });

function harness() {
  const slots = [], effects = [], intervals = new Set();
  let cursor = 0, dirty = true, tree;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      slots[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
    }
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const rows = [task('a'), task('b')], calls = [];
  const api = {
    schedules: async (_, scope) => ({ items: structuredClone(rows), availability: { triggerActive: true, catalogReadable: true, readyAgentIds: ['ar-test'] }, warnings: [] }),
    agents: async () => ({ items: [{ metadata: { id: 'ar-test', name: 'Test Agent' } }] }),
    scheduleOccurrences: async id => { calls.push(id); return { items: [] }; },
  };
  const window = { setInterval: callback => { intervals.add(callback); return callback; }, clearInterval: callback => intervals.delete(callback) };
  const names = ['StudioSubnav', 'ResourcesPage', 'CodexPluginMarketItem', 'RuntimeResourcesPage', 'OperationalPageHeading', 'Pill', 'EmptyState', 'ResourceDialog', 'StudioPageTabs', 'OperationalPager', 'ScheduleDeliveryPicker', 'ScheduleDeliveryResult'];
  const { AutomationPage: Page } = createAutomationPage({
    ui: { React: { createElement: h, useState, useEffect, useRef, Fragment: 'fragment' }, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ...Object.fromEntries(names.map(name => [name, name])) }, hostRemote: api, actions: { confirm: async () => true }, window, document: { hidden: false },
  });
  const render = () => { cursor = 0; dirty = false; tree = Page({}); for (const effect of effects.splice(0)) effect(); return tree; };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk), ...walk(node.props.action)] : [];
  const nodes = () => { if (dirty) render(); return walk(tree); };
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const buttons = label => nodes().filter(node => node.type === 'button' && text(node) === label);
  const settle = async () => { for (let i = 0; i < 30; i++) { if (dirty) render(); await Promise.resolve(); } };
  return { api, rows, calls, nodes, buttons, settle, intervals, text,
    tick: async () => { for (const callback of [...intervals]) callback(); await settle(); },
    ready: async () => { await settle(); nodes().find(node => node.type === 'StudioPageTabs').props.onChange('cloud'); await settle(); },
    dialog: () => nodes().find(node => node.type === 'ResourceDialog'),
  };
}

test('scheduled cloud tasks refresh when due without closing an open editor', async () => {
  const ui = harness(); await ui.ready();
  assert.ok(ui.intervals.size > 0, 'a waiting task needs a refresh timer before its first occurrence');
  ui.buttons('编辑')[0].props.onClick(); await ui.settle();
  const input = ui.nodes().find(node => node.type === 'textarea');
  input.props.onChange({ target: { value: 'Unsaved draft' } }); await ui.settle();
  const pending = deferred();
  ui.api.schedules = () => pending.promise;
  await ui.tick();
  assert.ok(ui.dialog(), 'background refresh must not unmount the editor');
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, 'Unsaved draft');
  pending.resolve({ items: ui.rows, availability: { readyAgentIds: ['ar-test'] } }); await ui.settle();
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, 'Unsaved draft');
});

test('switching or closing task details ignores the previous asynchronous response', async () => {
  const ui = harness(); await ui.ready();
  const a = deferred(), b = deferred();
  ui.api.scheduleOccurrences = id => id === 'a' ? a.promise : b.promise;
  ui.buttons('详情')[0].props.onClick(); await ui.settle();
  ui.buttons('详情')[1].props.onClick(); await ui.settle();
  b.resolve({ items: [{ occurrenceId: 'result-b', state: 'succeeded' }] }); await ui.settle();
  a.resolve({ items: [{ occurrenceId: 'result-a', state: 'failed' }] }); await ui.settle();
  assert.equal(ui.dialog().props.title, 'Task b');
  assert.match(ui.text(ui.dialog()), /result-b/);
  assert.doesNotMatch(ui.text(ui.dialog()), /result-a/);
});

test('a failed occurrence read is visible in task details instead of a false empty history', async () => {
  const ui = harness(); await ui.ready();
  ui.api.scheduleOccurrences = async () => { throw new Error('cloud temporarily unavailable'); };
  ui.buttons('详情')[0].props.onClick(); await ui.settle();
  assert.doesNotMatch(ui.text(ui.dialog()), /暂无执行记录/);
  assert.match(ui.text(ui.dialog()), /读取失败|无法读取/);
  assert.ok(ui.nodes().some(node => node.props.role === 'alert'));
});

test('history retains successful tasks and reports unavailable tasks instead of hiding failures', async () => {
  const ui = harness(); await ui.ready();
  ui.api.scheduleOccurrences = async id => {
    if (id === 'a') throw new Error('unavailable');
    return { items: [{ occurrenceId: 'result-b', state: 'succeeded' }] };
  };
  ui.buttons('执行记录')[0].props.onClick(); await ui.settle();
  assert.match(ui.nodes().map(ui.text).join(' '), /result-b/);
  assert.ok(ui.nodes().some(node => node.props.role === 'alert' && /读取失败|无法读取/.test(ui.text(node))), 'partial failure must be surfaced');
});

test('background reads do not overlap or query future tasks on every timer tick', async () => {
  const ui = harness();
  ui.rows.forEach(row => { row.nextRunAt = new Date(Date.now() + 60000).toISOString(); });
  await ui.ready();
  const previous = ui.calls.length;
  await ui.tick();
  assert.equal(ui.calls.length, previous, 'future tasks do not require repeated occurrence queries');
  ui.rows[0].nextRunAt = new Date(Date.now() - 1000).toISOString();
  ui.buttons('刷新')[0].props.onClick(); await ui.settle();
  const pending = deferred(); let reads = 0;
  ui.api.schedules = () => { reads++; return pending.promise; };
  await ui.tick(); await ui.tick();
  assert.equal(reads, 1, 'slow catalogue requests must not stack up');
  pending.resolve({ items: ui.rows }); await ui.settle();
});

test('the open detail updates to the terminal result and delivery status on a refresh', async () => {
  const ui = harness(); await ui.ready();
  ui.api.scheduleOccurrences = async id => ({ items: [{ occurrenceId: `${id}-run`, state: 'running' }] });
  ui.buttons('详情')[0].props.onClick(); await ui.settle();
  assert.match(ui.text(ui.dialog()), /running/);
  ui.api.scheduleOccurrences = async id => ({ items: [{ occurrenceId: `${id}-run`, state: 'succeeded', deliveryState: 'delivered', resultText: 'Saved output' }] });
  await ui.tick();
  assert.doesNotMatch(ui.text(ui.dialog()), /running/);
  assert.match(ui.text(ui.dialog()), /succeeded/);
  const result = ui.nodes().find(node => node.type === 'ScheduleDeliveryResult');
  assert.equal(result.props.item.deliveryState, 'delivered');
});

test('closing a detail or changing execution scope ignores late failures and records', async () => {
  const ui = harness(); await ui.ready();
  const pending = deferred();
  ui.api.scheduleOccurrences = () => pending.promise;
  ui.buttons('详情')[0].props.onClick(); await ui.settle();
  ui.dialog().props.onClose(); await ui.settle();
  pending.reject(new Error('obsolete read')); await ui.settle();
  assert.equal(ui.dialog(), undefined);
  assert.equal(ui.nodes().some(node => node.props.role === 'alert' && /obsolete/.test(ui.text(node))), false);
  const late = deferred();
  ui.api.scheduleOccurrences = () => late.promise;
  ui.buttons('详情')[0].props.onClick(); await ui.settle();
  ui.nodes().find(node => node.type === 'StudioPageTabs').props.onChange('local'); await ui.settle();
  late.resolve({ items: [{ occurrenceId: 'cloud-only-result', state: 'succeeded' }] }); await ui.settle();
  assert.equal(ui.dialog(), undefined);
  assert.doesNotMatch(ui.nodes().map(ui.text).join(' '), /cloud-only-result/);
});

test('an entirely failed history shows an unavailable state and a retry can recover it', async () => {
  const ui = harness(); await ui.ready();
  ui.api.scheduleOccurrences = async () => { throw new Error('unavailable'); };
  ui.buttons('执行记录')[0].props.onClick(); await ui.settle();
  assert.ok(ui.nodes().some(node => node.type === 'EmptyState' && node.props.title === '执行记录暂时无法读取'));
  assert.equal(ui.nodes().some(node => node.type === 'EmptyState' && node.props.title === '暂无执行记录'), false);
  ui.api.scheduleOccurrences = async id => ({ items: [{ occurrenceId: `recovered-${id}`, state: 'succeeded' }] });
  ui.buttons('刷新')[0].props.onClick(); await ui.settle();
  assert.match(ui.nodes().map(ui.text).join(' '), /recovered-a/);
  assert.equal(ui.nodes().some(node => node.props.role === 'alert'), false);
});
