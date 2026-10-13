import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/client-fragments/07-channels-and-shell.js', import.meta.url), 'utf8');
const h = (type, props, ...children) => ({ type, props, children });
const context = vm.createContext({ h, React: { Fragment: 'Fragment' }, BRAND: {}, PANELS: [{ page: 'agents', label: 'Agents' }], AgentWorkspace: 'AgentWorkspace', Pill: 'Pill', HostStatusPill: 'HostStatusPill', ConfirmHost: 'ConfirmHost' });
vm.runInContext(source, context);
test('page heading and content share the padded scroll container', () => {
  const tree = context.StudioShell({ page: 'agents' });
  const main = tree.children.find(child => child.type === 'main');
  assert.ok(main.children.some(child => child.type === 'AgentWorkspace'), 'Agent page escaped main padding and scrolling');
  assert.match(source, /window.__AGENTKIT_CONFIRM__/, 'destructive actions must route through the Studio confirm dialog');
  assert.equal(tree.children.length, 1);
});
