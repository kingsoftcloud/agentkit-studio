import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelsPage } from '../src/client/pages/channels.mjs';
import { createDeliveryPages } from '../src/client/pages/delivery.mjs';
import { createCloudSessionStatus } from '../src/client/dsh/cloud-status.mjs';

const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

function createHookRuntime() {
  const slots = [];
  const queued = [];
  let cursor = 0, dirty = false, tree = null;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => {
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
    }];
  };
  const useEffect = (effect, deps) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      slots[index] = { deps, cleanup: previous?.cleanup };
      queued.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
    }
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const React = { createElement: h, useState, useEffect, useRef, Fragment: 'fragment' };
  const render = (component, props) => {
    cursor = 0; dirty = false; tree = component(props);
    for (const effect of queued.splice(0)) effect();
  };
  const settle = async (component, props) => {
    for (let i = 0; i < 60; i++) {
      if (dirty || i === 0) render(component, props);
      await Promise.resolve();
    }
  };
  return { React, settle, tree: () => tree };
}

test('channels connection polling skips hidden documents but keeps the first load immediate', async () => {
  const runtime = createHookRuntime();
  const document = { hidden: true };
  let reads = 0, interval;
  const names = ['OperationalPageHeading', 'Pill', 'EmptyState', 'Metric', 'OperationalToolbar', 'ResourceDialog', 'StudioPageTabs', 'OperationalTable', 'OperationalPager'];
  const Page = createChannelsPage({
    ui: { React: runtime.React, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), operationalStatus: value => value, ...Object.fromEntries(names.map(name => [name, name])) },
    hostRemote: {
      channelConnection: async () => { reads++; return { configured: true, serverUrl: '', accountId: '', workspaceId: '' }; },
      channelAction: async () => ({ Code: 0, Data: { Items: [] } }),
    },
    actions: { confirm: async () => true }, window: {}, document,
    setInterval: callback => { interval = callback; return callback; }, clearInterval: () => {},
  });
  await runtime.settle(Page, {});
  assert.equal(reads, 1, 'opening the page reads the connection immediately');
  await interval(); await runtime.settle(Page, {});
  assert.equal(reads, 1, 'a hidden tab must not poll the connection');
  document.hidden = false;
  await interval(); await runtime.settle(Page, {});
  assert.equal(reads, 2, 'a visible tab resumes polling');
});

test('deployment polling skips hidden documents but keeps the first load immediate', async () => {
  const runtime = createHookRuntime();
  const document = { hidden: true };
  let reads = 0, interval;
  const names = ['Pill', 'StudioPageTabs', 'SectionHeading', 'EmptyState'];
  const Component = createDeliveryPages({
    ui: { React: runtime.React, BRAND: {}, RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ...Object.fromEntries(names.map(name => [name, name])) },
    hostRemote: { deployments: async () => { reads++; return { items: [] }; } },
    actions: { confirm: async () => true }, window: {}, document,
    setInterval: callback => { interval = callback; return callback; }, clearInterval: () => {},
  }).CloudDeploymentPanel;
  const props = { agentId: 'a', selectedBuild: 'build-a' };
  await runtime.settle(Component, props);
  assert.equal(reads, 1, 'opening the page reads deployments immediately');
  await interval(); await runtime.settle(Component, props);
  assert.equal(reads, 1, 'a hidden tab must not poll deployments');
  document.hidden = false;
  await interval(); await runtime.settle(Component, props);
  assert.equal(reads, 2, 'a visible tab resumes polling');
});

test('cloud execution receipt polling skips hidden documents but keeps the first load immediate', async () => {
  const runtime = createHookRuntime();
  const document = { hidden: true };
  let reads = 0, interval;
  const hostRemote = {
    agents: async () => ({ total: 1, items: [{ metadata: { id: 'ag' }, deployment: { environment: 'prod', region: 'region', buildId: 'build', models: ['model'] } }] }),
    traces: async () => { reads++; return { items: [] }; },
  };
  const CloudSessionStatus = createCloudSessionStatus({
    ui: { React: runtime.React, ResourceDialog: 'ResourceDialog', buttonStyle: () => ({}) },
    hostRemote, document,
    setInterval: callback => { interval = callback; return callback; }, clearInterval: () => {},
  });
  const useSessions = selector => selector({ byId: { session: { projectionValues: { agentPreset: 'agentkit-studio-agent-ag-r1' } } } });
  const props = { sessionId: 'session', useSessions };
  await runtime.settle(CloudSessionStatus, props);
  const button = walk(runtime.tree()).find(node => node.type === 'button');
  assert.ok(button, 'cloud status opens from the session header');
  button.props.onClick();
  await runtime.settle(CloudSessionStatus, props);
  assert.equal(reads, 1, 'opening the dialog reads the latest receipt immediately');
  await interval(); await runtime.settle(CloudSessionStatus, props);
  assert.equal(reads, 1, 'a hidden tab must not poll execution receipts');
  document.hidden = false;
  await interval(); await runtime.settle(CloudSessionStatus, props);
  assert.equal(reads, 2, 'a visible tab resumes polling');
});
