import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarHarnessPage, STAR_HARNESS_CHANGED } from '../src/client/pages/star-harness.mjs';

function render(status, hostRemote, events = [], view = 'page', effects = [], renderDetail) {
  const states = [status];
  const page = createStarHarnessPage({
    ui: { React: {
      createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
      useState: initial => [states.length ? states.shift() : initial, () => {}],
      useEffect: effect => effects.push(effect),
      useRef: current => ({ current }),
    }, MarkdownText: 'native-markdown', BRAND: {}, buttonStyle: () => ({}) },
    Switch: 'native-switch', Button: 'native-button', hostRemote, window: { Event, dispatchEvent: event => events.push(event.type),
      addEventListener() {}, removeEventListener() {} },
  });
  return page({ view, renderDetail });
}

function descendants(node) {
  return node?.children ? [node, ...node.children.flatMap(descendants)] : [];
}

const state = { version: '0.0.24', availableUpgrade: '0.0.25', enabled: false,
  models: [], workspaces: [{ workspace: '/tmp/external-workspace', external: true, running: true }] };

test('the details use the catalog cache on mount and explicitly refresh when asked', async () => {
  const effects = [], requests = [];
  const checked = Promise.withResolvers();
  const view = render(state, { async starHarnessStatus(options, signal) {
    requests.push({ options, signal });
    if (requests.length === 2) checked.resolve();
    return state;
  } }, [], 'page', effects);
  const unmount = effects[0]();
  await checked.promise;
  assert.deepEqual(requests.map(({ options }) => options), [{}, { checkUpdates: true, includeVersions: true }]);
  unmount();
  assert.ok(requests[0].signal.aborted);
  const refresh = descendants(view).find(node => node.type === 'button' && node.children.includes('检查更新'));
  await refresh.props.onClick();
  assert.deepEqual(requests[2].options, { checkUpdates: true, includeVersions: true, refreshVersions: true });
});

test('the StarOrigin Harness card applies an upgrade once and explains automatic workspace selection', async () => {
  const installed = Promise.withResolvers();
  const requests = [], events = [];
  const view = render({ ...state, releaseVersions: [{ version: '0.0.25', action: 'upgrade' }] }, {
    installStarHarness(version) { requests.push(version); return installed.promise; },
  }, events);
  const elements = descendants(view);
  assert.doesNotMatch(JSON.stringify(view), /external-workspace/);
  assert.ok(elements.every(node => node.type !== 'input'));
  const upgrade = elements.find(node => node.type === 'button' && node.children.includes('升级到 0.0.25'));
  assert.match(elements.find(node => node.type === 'native-markdown').props.text, /会话在 Studio 中选择的工作区/);
  const pending = upgrade.props.onClick();
  await upgrade.props.onClick();
  assert.deepEqual(requests, ['0.0.25']);
  installed.resolve({ ...state, version: '0.0.25' });
  await pending;
  assert.deepEqual(events, [STAR_HARNESS_CHANGED]);
});

test('the StarOrigin Harness details show components and allow rollback to the locally available version while offline', async () => {
  const requests = [];
  const status = { ...state, previousVersion: '0.0.23', rollbackVersion: '0.0.23', registryUnavailable: true,
    releaseVersions: [{ version: '0.0.23', action: 'rollback', publishedAt: '2026-11-20T10:02:13.000Z' },
      { version: '0.0.22', action: 'history' }] };
  const elements = descendants(render(status, { async installStarHarness(version) { requests.push(version); return status; } }));
  const buttons = elements.filter(node => node.type === 'button');
  assert.ok(elements.some(node => node.children.includes('包含的组件')));
  assert.equal(elements.filter(node => node.type === 'code').length, 3);
  assert.ok(elements.some(node => node.type === 'time' && node.props.dateTime === '2026-11-20T10:02:13.000Z'));
  assert.ok(!buttons.some(node => node.children.some(label => label.includes('0.0.22'))));
  await buttons.find(node => node.children.includes('回退到 0.0.23')).props.onClick();
  assert.deepEqual(requests, ['0.0.23']);
  const busy = descendants(render({ ...status, busy: true }, {}));
  assert.equal(busy.find(node => node.children.includes('回退到 0.0.23')).props.disabled, true);
});

test('the DSH detail lists only the recommended, current and rollback releases', async () => {
  const requests = [];
  const status = { ...state, rollbackVersion: '0.0.23', previousVersion: '0.0.23',
    releaseVersions: [{ version: '0.0.25', action: 'upgrade' }, { version: '0.0.22', action: 'history' },
      { version: '0.0.26', action: 'upgrade' }] };
  const detail = render(status, { async installStarHarness(version) { requests.push(version); return status; } },
    [], 'page', [], presentation => presentation);
  assert.match(detail.description, /金山云自研.*AgentKit、星流模型和金山云服务/);
  assert.match(detail.document.markdown, /子智能体协作.*原会话续跑.*Token 开销/);
  assert.equal(detail.versions.advanced, undefined);
  assert.equal(detail.components.length, 3);
  assert.ok(descendants(detail.headerActions).some(node => node.type === 'native-button' && node.children.includes('升级到 0.0.25')));
  assert.equal(detail.versions.rows.find(row => row.version === '0.0.24').current, true);
  assert.deepEqual(detail.versions.rows.map(row => row.version), ['0.0.25', '0.0.24', '0.0.23']);
  for (const version of ['0.0.25', '0.0.23']) {
    const control = detail.versions.rows.find(row => row.version === version).action;
    await control.props.onClick();
  }
  assert.deepEqual(requests, ['0.0.25', '0.0.23']);
  const busy = render({ ...status, busy: true }, {}, [], 'page', [], presentation => presentation);
  assert.equal(busy.versions.rows.find(row => row.version === '0.0.23').action.props.disabled, true);
  const withoutUpdate = render({ ...status, availableUpgrade: null }, {}, [], 'page', [], presentation => presentation);
  assert.deepEqual(withoutUpdate.versions.rows.map(row => row.version), ['0.0.24', '0.0.23']);
  const cleanInstall = render({ ...status, version: null, rollbackVersion: null, recommendedVersion: '0.0.25' },
    {}, [], 'page', [], presentation => presentation);
  assert.equal(cleanInstall.version, undefined);
  assert.deepEqual(cleanInstall.versions.rows.map(row => row.version), ['0.0.25']);
  assert.ok(descendants(detail.headerActions).every(node => !node.children.includes('修复当前版本')));

  const repair = render({ ...status, repairNeeded: true }, {
    async installStarHarness(version) { requests.push(version); return status; },
  }, [], 'page', [], presentation => presentation);
  await descendants(repair.headerActions).find(node => node.children.includes('修复当前版本')).props.onClick();
  assert.equal(requests.at(-1), status.version);
});


test('the StarOrigin Harness summary toggles activation without a workspace binding', async () => {
  const updates = [], events = [];
  const view = render(state, {
    async enableStarHarness(enabled) {
      updates.push(enabled);
      return { ...state, enabled };
    },
  }, events, 'summary');
  const toggle = descendants(view).find(node => node.type === 'native-switch');
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);
  await toggle.props.onChange(true);
  assert.deepEqual(updates, [true]);
  assert.deepEqual(events, [STAR_HARNESS_CHANGED]);
});
