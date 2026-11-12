/** A run that dies without a code must still name its cause. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = () => readFile(fileURLToPath(new URL('../src/build-runtime-http.mjs', import.meta.url)), 'utf8');

test('the run catch block records the raw error before normalizing it', async () => {
  const text = await source();
  const catchIndex = text.indexOf('} catch (error) {');
  assert.ok(catchIndex > 0, 'the run handler must keep its catch block');
  const block = text.slice(catchIndex, catchIndex + 1400);
  // safeDiagnosticCode keeps only string codes, so a DOMException TimeoutError
  // (code 23) must be logged raw or its cause is lost.
  assert.match(block, /\[agentkit-studio\] run error/);
  for (const field of ['name', 'code', 'message', 'stack']) {
    assert.match(block, new RegExp(`${field}:`), `the raw error log must carry ${field}`);
  }
  assert.match(block, /typeof error\?\.code === 'number'/, 'numeric DOMException codes must survive');
});
