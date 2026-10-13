import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDesktopModuleGraph } from '../scripts/desktop-module-graph.mjs';

test('the packaged host gate rejects a shared build chunk omitted by the npm file list', async () => {
  const root = 'dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/';
  const files = new Map([[root+'index.js', 'import { clone } from "./src-generated.js"; export const snapshot = clone;']]);
  const read = path => { if (!files.has(path)) throw new Error('not found'); return files.get(path); };
  await assert.rejects(verifyDesktopModuleGraph(read, [root+'index.js']), /Packaged desktop module is missing/);
  files.set(root+'src-generated.js', 'export const clone = value => value;');
  const result = await verifyDesktopModuleGraph(read, [root+'index.js']);
  assert.equal(result.verified, true);
  assert.equal(result.modules, 2);
});
