import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStudioShell } from '../src/client/components/shell.mjs';
const source = await readFile(new URL('../src/client/pages/channels.mjs', import.meta.url), 'utf8');
const h = (type, props, ...children) => ({ type, props, children });
const { StudioShell } = createStudioShell({ ui: { React: { createElement: h, Fragment: 'Fragment' }, BRAND: {}, PANELS: [{ page: 'resource-hub', label: '资源库' }], ResourceWorkspace: 'ResourceWorkspace', Pill: 'Pill' } });
test('page heading and content share the padded scroll container', () => {
  const tree = StudioShell({ page: 'resource-hub' });
  const main = tree.children.find(child => child.type === 'main');
  assert.ok(main.children.some(child => child.type === 'ResourceWorkspace'), 'Agent page escaped main padding and scrolling');
  assert.match(source, /actions\.confirm/, 'destructive actions must route through the scoped Studio confirm dialog');
  assert.equal(tree.children.length, 1);
});
