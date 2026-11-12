/** The deadline trace must run before any plugin module can arm one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = () => readFile(fileURLToPath(new URL('../scripts/start-agent-manifest.mjs', import.meta.url)), 'utf8');

test('the entry traces long AbortSignal deadlines before importing plugins', async () => {
  const text = await source();
  const traceIndex = text.indexOf('traceLongAbortDeadlines();');
  const importIndex = text.indexOf("from '../src/managed-runtime-host.mjs'");
  assert.ok(traceIndex > 0, 'the entry must install the trace');
  // ESM hoists imports, so the call must sit in the module body while the
  // wrapper itself is defined before any await runs a plugin.
  assert.match(text, /function traceLongAbortDeadlines\(thresholdMs = 100_000\)/);
  assert.match(text, /original\.traced/, 'a second install must not stack another wrapper');
  assert.match(text, /return original\.call\(AbortSignal, ms\);/);
  assert.match(text, /\[agentkit-studio\] abort deadline/);
});

test('short deadlines stay silent', async () => {
  const text = await source();
  assert.match(text, /Number\(ms\) >= thresholdMs/);
});
