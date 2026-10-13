import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshHarnessAdapter } from '../src/dsh-adapter.mjs';

test('adapter forwards official GenerateOptions and StreamChunk without conversion', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const seen = [];
  const adapter = createDshHarnessAdapter({
    provider: 'mock',
    model: { stream(options) { seen.push(options); return (async function* () { yield* chunks; })(); } },
  });
  const options = { provider: 'mock', model: 'mock', messages: [{ role: 'user', content: [] }] };
  assert.deepEqual(await Array.fromAsync(adapter.stream(options)), chunks);
  assert.equal(seen[0], options);
  assert.deepEqual(await adapter.resolveModel('mock', 'mock'), { provider: 'mock', id: 'mock', name: 'mock' });
});
