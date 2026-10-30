import test from 'node:test';
import assert from 'node:assert/strict';

import { createDshPluginPages } from '../src/client/pages/dsh-plugins.mjs';

const BRAND = {
  ink: '#111', inkMuted: '#777', border: '#ddd', surface: '#fff', canvas: '#f4f4f4',
  accent: '#111', accentStrong: '#111', primaryFill: '#111', primaryText: '#fff',
  accentSoft: '#f0f0f0', signal: '#946200', danger: '#b00'
};

function page(hostRemote) {
  const values = [];
  const effects = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const { DshPluginMarketItem } = createDshPluginPages({
    ui: {
      React: { createElement: h, useState, useEffect: effect => effects.push(effect), Fragment: 'fragment' },
      BRAND, buttonStyle: () => ({}), inputStyle: () => ({}), Pill: 'pill', EmptyState: 'empty', ResourceDialog: 'dialog'
    },
    hostRemote: { discoverDshPlugins: async () => ({ items: [], info: null }), ...hostRemote }
  });
  const render = (view = 'page') => { cursor = 0; return DshPluginMarketItem({ view }); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const find = (type, label) => walk(render()).find(node => node.type === type && (node.props['aria-label'] === label || text(node) === label));
  const buttonContaining = label => walk(render()).find(node => node.type === 'button' && text(node).includes(label));
  const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
  const openInstalled = async () => {
    const tab = walk(render()).find(node => node.type === 'button' && text(node).startsWith('已安装'));
    tab?.props.onClick();
    await settle();
  };
  return { render, find, buttonContaining, text, walk, effects, settle, openInstalled };
}

function plugin(overrides = {}) {
  return {
    pluginId: '@deepseek-ai/dsh-experimental-demo',
    name: '@deepseek-ai/dsh-experimental-demo',
    displayName: '演示插件',
    description: 'DSH 插件市场演示条目',
    version: '',
    category: '工具',
    featured: false,
    capabilities: ['demo_capability'],
    installed: false,
    enabled: false,
    optional: true,
    removable: false,
    status: 'available',
    verification: { state: 'not-installed', checks: [], note: '插件尚未安装。' },
    ...overrides
  };
}

test('DSH 插件市场按列表渲染可安装条目，安装后刷新状态', async () => {
  const calls = [];
  let installed = false;
  const installSpec = '@deepseek-ai/dsh-experimental-demo@1.2.3';
  const installTargetSpec = '@deepseek-ai/dsh-experimental-demo@1.2.4';
  const host = {
    dshPlugins: async () => ({
      catalog: { source: 'builtin', updatedAt: '2026-10-26T12:00:00.000Z' },
      items: [plugin({
        featured: true,
        installed,
        enabled: installed,
        removable: installed,
        installSpec,
        installTarget: { spec: installTargetSpec, version: '1.2.4' },
        status: installed ? 'active' : 'available',
        ...(installed ? { version: '1.2.4' } : {}),
        verification: installed
          ? { state: 'ready', checks: [{ entry: 'demo', ok: true, phase: 'active' }], note: 'Host 服务能力检查通过。' }
          : { state: 'not-installed', checks: [], note: '插件尚未安装。' }
      })]
    }),
    installDshPlugin: async (...args) => { calls.push(['install', ...args]); installed = true; return { note: 'Host 已应用插件变更。' }; }
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();

  assert.match(ui.text(ui.render()), /清单来源：内置清单（更新于 2026-10-26T12:00:00\.000Z）/);
  ui.find('button', '安装').props.onClick();
  await ui.settle();

  // Bundle-backed rows install by the Host-provided installSpec (package
  // name): the Host resolves the pinned installTarget itself, with exact-save.
  assert.deepEqual(calls, [['install', installSpec]]);
  assert.match(ui.text(ui.render()), /演示插件：已安装/);
  assert.match(ui.text(ui.render()), /已启用 · 1/);
  assert.ok(ui.find('button', '停用'));
  assert.ok(ui.find('button', '更新'));
  assert.ok(ui.find('button', '卸载'));
});

test('已安装条目可停用与启用，并分别调用对应 remote', async () => {
  const calls = [];
  let enabled = true;
  const host = {
    dshPlugins: async () => ({
      items: [plugin({
        displayName: '可启停插件',
        installed: true,
        enabled,
        removable: false,
        status: enabled ? 'active' : 'disabled',
        verification: { state: enabled ? 'ready' : 'disabled', checks: [], note: enabled ? '插件已启用。' : '插件已停用。' }
      })]
    }),
    disableDshPlugin: async pluginName => { calls.push(['disable', pluginName]); enabled = false; return { note: '插件已停用。' }; },
    enableDshPlugin: async pluginName => { calls.push(['enable', pluginName]); enabled = true; return { note: 'Host 已应用插件变更。' }; }
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();

  ui.find('button', '停用').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['disable', '@deepseek-ai/dsh-experimental-demo']]);
  assert.match(ui.text(ui.render()), /已停用/);
  assert.ok(ui.find('button', '启用'));

  ui.find('button', '启用').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['disable', '@deepseek-ai/dsh-experimental-demo'], ['enable', '@deepseek-ai/dsh-experimental-demo']]);
  assert.ok(ui.find('button', '停用'));
});

test('更新调用 updateDshPlugin，卸载调用 uninstallDshPlugin', async () => {
  const calls = [];
  let installed = true;
  const pluginId = '@deepseek-ai/dsh-experimental-demo';
  const host = {
    dshPlugins: async () => ({
      items: [plugin({
        pluginId,
        name: pluginId,
        installed,
        enabled: installed,
        removable: true,
        status: installed ? 'active' : 'available',
        installSpec: pluginId,
        ...(installed ? { installTarget: { spec: `${pluginId}@2.0.0`, version: '2.0.0' } } : {})
      })]
    }),
    updateDshPlugin: async name => { calls.push(['update', name]); return { note: 'Host 已应用插件变更。' }; },
    uninstallDshPlugin: async name => { calls.push(['uninstall', name]); installed = false; return { note: '插件已移除。' }; }
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();

  ui.find('button', '更新').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['update', pluginId]]);
  assert.match(ui.text(ui.render()), /已更新/);

  ui.find('button', '卸载').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['update', pluginId], ['uninstall', pluginId]]);
  assert.match(ui.text(ui.render()), /已卸载/);
  assert.ok(ui.find('button', '安装'));
});

test('只读或 lifecycleAvailable=false 的条目不显示生命周期按钮但保留详情入口', async () => {
  const host = {
    dshPlugins: async () => ({
      items: [
        plugin({
          pluginId: '@deepseek-ai/dsh-readonly',
          displayName: '只读插件',
          readOnlyReason: 'host-component',
          status: 'available',
          capabilities: ['readonly_capability']
        }),
        plugin({
          pluginId: '@deepseek-ai/dsh-frozen',
          displayName: '冻结插件',
          installed: true,
          enabled: true,
          lifecycleAvailable: false,
          status: 'active',
          capabilities: ['frozen_capability'],
          verification: { state: 'ready', checks: [], note: 'Host 已加载插件。' }
        })
      ]
    })
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();

  assert.match(ui.text(ui.render()), /只读插件/);
  assert.match(ui.text(ui.render()), /冻结插件/);
  for (const label of ['安装', '停用', '启用', '更新', '卸载']) assert.equal(ui.find('button', label), undefined, label);

  ui.buttonContaining('只读插件').props.onClick();
  assert.ok(ui.find('button', '← 返回插件市场'));
  assert.match(ui.text(ui.render()), /readonly_capability/);
  assert.equal(ui.find('button', '安装'), undefined);

  ui.find('button', '← 返回插件市场').props.onClick();
  ui.buttonContaining('冻结插件').props.onClick();
  assert.ok(ui.find('button', '← 返回插件市场'));
  assert.match(ui.text(ui.render()), /frozen_capability/);
  assert.equal(ui.find('button', '停用'), undefined);
});

test('手动安装对话框提交 spec，remote 抛错时错误留在对话框内且不提示已安装', async () => {
  const calls = [];
  const host = {
    dshPlugins: async () => ({ items: [] }),
    installDshPlugin: async (...args) => { calls.push(args); throw new Error('插件源检查失败：缺少宿主权限'); }
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();

  ui.find('button', '手动安装').props.onClick();
  ui.find('input', 'DSH 插件标识').props.onChange({ target: { value: ' @scope/plugin ' } });
  const form = ui.walk(ui.render()).find(node => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  await ui.settle();

  assert.deepEqual(calls, [['@scope/plugin', true]]);
  const dialog = ui.walk(ui.render()).find(node => node.type === 'dialog');
  assert.ok(dialog, '手动安装对话框应保持打开');
  assert.match(ui.text(dialog), /插件源检查失败：缺少宿主权限/);
  assert.doesNotMatch(ui.text(ui.render()), /已安装。/);
});

test('发现 tab 渲染社区插件，支持分类筛选与一键安装', async () => {
  const calls = [];
  const host = {
    dshPlugins: async () => ({ items: [] }),
    discoverDshPlugins: async () => ({
      items: [
        {
          id: 'dsh-whale-widget', packageName: 'dsh-whale-widget', displayName: 'dsh-whale-widget',
          description: 'DSH Web 界面右下角的小鲸鱼余额挂件', category: '视觉外观', source: 'npm',
          installSpec: 'dsh-whale-widget', featured: true, tags: ['余额'], installed: false,
          stats: { monthlyDownloads: 253956, updatedAt: '2026-10-01T00:00:00Z' }
        },
        {
          id: 'dsh-mnemon', packageName: 'dsh-mnemon', displayName: 'dsh-mnemon',
          description: '视图级上下文记忆', category: '记忆与上下文', source: 'npm',
          installSpec: 'dsh-mnemon', featured: false, tags: ['记忆'], installed: false,
          stats: { monthlyDownloads: 57152 }
        }
      ],
      info: { npmTotal: 10522, curated: 26, updatedAt: '2026-10-26T00:00:00Z' }
    }),
    installDshPlugin: async (...args) => { calls.push(args); return { note: 'Host 已应用插件变更。' }; }
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();

  const body = ui.text(ui.render());
  assert.match(body, /发现插件/);
  assert.match(body, /dsh-whale-widget/);
  assert.match(body, /25\.4 万/);
  assert.match(body, /精选/);
  assert.match(body, /npm 收录 1\.1 万/);

  ui.find('button', '筛选分类：记忆与上下文').props.onClick();
  await ui.settle();
  const filtered = ui.text(ui.render());
  assert.match(filtered, /dsh-mnemon/);
  assert.doesNotMatch(filtered, /dsh-whale-widget/);

  ui.find('button', '筛选分类：全部').props.onClick();
  await ui.settle();
  ui.find('button', '安装').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['dsh-whale-widget', true]]);
  assert.match(ui.text(ui.render()), /dsh-whale-widget 已安装/);
});

test('view 不是 page 时只渲染摘要且不发起任何 remote 调用', async () => {
  const calls = [];
  const ui = page({ dshPlugins: async () => { calls.push('dshPlugins'); return { items: [] }; } });
  const node = ui.render('item');

  assert.equal(node.type, 'p');
  assert.equal(ui.walk(node).length, 1);
  assert.match(ui.text(node), /DSH 插件/);
  ui.effects[0]();
  await ui.settle();
  assert.deepEqual(calls, []);
  assert.equal(ui.walk(node).find(item => item.type === 'button'), undefined);
  assert.doesNotMatch(ui.text(node), /手动安装/);
});

test('catalog.error 只提示不阻塞列表，刷新目录会强制重新发现并重新 load', async () => {
  let listCalls = 0;
  const discoverCalls = [];
  const host = {
    dshPlugins: async () => ({
      catalog: {
        source: 'builtin+remote',
        updatedAt: '2026-10-26T12:00:00.000Z',
        indexUrl: 'https://example.com/dsh-plugins.json',
        error: { code: 'INDEX_UNAVAILABLE', message: '远程索引暂不可用，已使用内置清单' }
      },
      items: [plugin({ displayName: '目录插件', category: '目录' })]
    }),
    discoverDshPlugins: async options => {
      discoverCalls.push(options?.force === true);
      return { items: [], info: { updatedAt: '2026-10-26T12:00:00.000Z', npmTotal: 0, curated: 0 } };
    }
  };
  const wrapped = { ...host, dshPlugins: async () => { listCalls += 1; return host.dshPlugins(); } };
  const ui = page(wrapped);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();

  assert.match(ui.text(ui.render()), /远程索引暂不可用，已使用内置清单/);
  assert.match(ui.text(ui.render()), /清单来源：内置 \+ 远程索引（更新于 2026-10-26T12:00:00\.000Z）/);
  assert.match(ui.text(ui.render()), /目录插件/);
  assert.match(ui.text(ui.render()), /可安装/);
  assert.equal(listCalls, 1);

  ui.find('button', '刷新目录').props.onClick();
  await ui.settle();
  assert.deepEqual(discoverCalls, [false, true]);
  assert.equal(listCalls, 2);
  assert.match(ui.text(ui.render()), /插件目录已刷新/);
  assert.match(ui.text(ui.render()), /目录插件/);
});

test('详情视图展示 capabilities 与 verification 失败 note 的告警样式', async () => {
  const pluginId = '@deepseek-ai/dsh-experimental-agent-team-profile';
  const host = {
    dshPlugins: async () => ({
      items: [plugin({
        pluginId,
        name: pluginId,
        displayName: 'Agent Teams',
        description: '团队委派与共享任务板',
        version: '0.3.0',
        source: 'profile',
        category: '协作',
        featured: true,
        installed: true,
        enabled: true,
        removable: true,
        installSpec: pluginId,
        installTarget: { spec: `${pluginId}@0.3.0`, version: '0.3.0' },
        status: 'partial',
        capabilities: ['spawn_teammate', 'list_agents'],
        verification: {
          state: 'failed',
          checks: [{ entry: 'agent-team', ok: false, phase: 'failed' }, { method: 'snapshot()', ok: true, observed: '3 项' }],
          note: 'Host 尚未加载能力行：agent-team'
        }
      })]
    })
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();
  ui.buttonContaining('Agent Teams').props.onClick();

  const body = ui.text(ui.render());
  assert.match(body, /← 返回插件市场/);
  assert.match(body, /版本/);
  assert.match(body, /0\.3\.0/);
  assert.match(body, /来源/);
  assert.match(body, /profile/);
  assert.match(body, /分类/);
  assert.match(body, /协作/);
  assert.match(body, /状态/);
  assert.match(body, /部分加载/);
  assert.match(body, /spawn_teammate/);
  assert.match(body, /list_agents/);
  assert.match(body, /验证失败/);
  assert.match(body, /agent-team/);
  assert.match(body, /snapshot\(\)/);
  assert.match(body, /未通过/);

  const alert = ui.walk(ui.render()).find(node => node.props?.role === 'alert' && ui.text(node).includes('Host 尚未加载能力行：agent-team'));
  assert.ok(alert, 'verification 失败 note 应以告警样式展示');
  assert.equal(alert.props.style.color, BRAND.signal);
});

test('状态文案按契约映射', async () => {
  const cases = [
    ['active', '已启用', { installed: true, enabled: true }],
    ['available', '可安装', { installed: false, enabled: false }],
    ['disabled', '已停用', { installed: true, enabled: false }],
    ['partial', '部分加载', { installed: true, enabled: true }],
    ['error', '加载失败', { installed: true, enabled: true }],
    ['selected', '已配置', { installed: true, enabled: true }],
    ['not-installed', '未安装', { installed: false, enabled: false }]
  ];
  const host = {
    dshPlugins: async () => ({
      items: cases.map(([status, , flags], index) => plugin({
        pluginId: `@deepseek-ai/dsh-status-${index}`,
        displayName: `状态插件-${status}`,
        status,
        ...flags
      }))
    })
  };
  const ui = page(host);
  ui.render();
  ui.effects[0]();
  await ui.settle();
  await ui.openInstalled();
  const body = ui.text(ui.render());
  for (const [, label] of cases) assert.ok(body.includes(label), label);
});
