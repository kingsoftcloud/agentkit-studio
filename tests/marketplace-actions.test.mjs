import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client/pages/resources.mjs', import.meta.url), 'utf8');
const operations = await readFile(new URL('../src/client/pages/operations.mjs', import.meta.url), 'utf8');

test('the legacy Studio double marketplace is no longer a visible page', () => {
  assert.doesNotMatch(fragment, /function MarketplacePage/);
  assert.doesNotMatch(fragment, /data-plugin-market/);
  assert.doesNotMatch(operations, /id: 'marketplace', label: '插件市场'/);
});
