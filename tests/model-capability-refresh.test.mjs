import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCapabilityRefresh } from '../src/host/services/model-capability-refresh.mjs';

test('stop aborts an in-flight refresh so no timer outlives dispose', async () => {
  let signal;
  let settled = false;
  const fetchImpl = (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { settled = true; reject(new Error('aborted')); }, { once: true });
    });
  };
  const refresh = createModelCapabilityRefresh({ storeDir: 'unused-in-this-test', fetchImpl });
  refresh.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(signal, 'start() must kick off a background refresh');
  assert.equal(signal.aborted, false);
  refresh.stop();
  // The release gate disposes the plugin while the first refresh is still in
  // flight; stopping must abort it synchronously instead of leaving a 10s
  // AbortSignal timer behind.
  assert.equal(signal.aborted, true);
  assert.equal(settled, true);
});
