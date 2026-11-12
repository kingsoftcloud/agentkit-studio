/** A long AbortSignal deadline must name its creator. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = () => readFile(fileURLToPath(new URL('../src/host/bootstrap.mjs', import.meta.url)), 'utf8');

test('long AbortSignal deadlines are traced once per process', async () => {
  const text = await source();
  assert.match(text, /function traceLongAbortDeadlines\(thresholdMs = 100_000\)/);
  assert.match(text, /original\.traced/, 'a second mount must not stack another wrapper');
  assert.match(text, /\[agentkit-studio\] abort deadline/);
  // The original implementation stays the one arming the deadline.
  assert.match(text, /return original\.call\(AbortSignal, ms\);/);
  assert.match(text, /traceLongAbortDeadlines\(\);/);
});

test('short deadlines stay silent', async () => {
  const text = await source();
  assert.match(text, /Number\(ms\) >= thresholdMs/);
});
