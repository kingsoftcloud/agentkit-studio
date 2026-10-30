import test from 'node:test';
import assert from 'node:assert/strict';
import { previewToolInput } from '../src/input-preview.mjs';
test('partial arguments display actual top-level fields, never nested or escaped fake paths', () => {
  assert.deepEqual(previewToolInput('{"path":"src/main.mjs","content":"line 1\\nline 2'),
    { path: 'src/main.mjs', content: 'line 1\nline 2' });
  assert.deepEqual(previewToolInput('{"content":"\\\"path\\\":\\\"fake\\\"","path":"real"}'),
    { content: '"path":"fake"', path: 'real' });
  assert.deepEqual(previewToolInput('{"nested":{"path":"fake"},"path":"real"}'), { path: 'real' });
  assert.deepEqual(previewToolInput('{"content":"hello\\u4e'), { content: 'hello' });
  assert.deepEqual(previewToolInput('{"__proto__":"pollute","apiKey":"secret"}'), {});
  assert.deepEqual(previewToolInput('not JSON'), {});
});
