import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalResourceAdapter } from '../src/host/services/optional-resource.mjs';
import { ownAsyncResource } from '../src/host/runtime-bridge.mjs';

test('optional resource initialization fails explicitly without rejecting independent startup', async () => {
  const adapter = await optionalResourceAdapter(Promise.reject(Object.assign(new Error('private backend detail'), { code: 'FIXTURE_RESOURCE_DOWN' })));
  assert.equal(adapter.unavailable, true);
  for (const method of ['describeMcp', 'listMcpTools', 'callMcpTool', 'loadSkill', 'searchKnowledge', 'searchMemory', 'writeMemory']) {
    await assert.rejects(adapter[method](), error => error.code === 'RESOURCE_SERVICE_UNAVAILABLE' && error.status === 503
      && error.details.causeCode === 'FIXTURE_RESOURCE_DOWN' && !error.message.includes('private backend'));
  }
  await adapter.close(); await adapter.close();
});

test('optional adapter retains identity and closes successful initialization after unload', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let dispose, closed = 0;
  const ctx = { effect: setup => { dispose = setup(); } };
  const pending = ownAsyncResource(ctx, optionalResourceAdapter(promise), 'fixture');
  await dispose();
  resolve({ close: async () => { closed++; } });
  await assert.rejects(pending, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
  assert.equal(closed, 1);
  const adapter = { callMcpTool: async () => 'fixture' };
  assert.equal(await optionalResourceAdapter(Promise.resolve(adapter)), adapter);
});
