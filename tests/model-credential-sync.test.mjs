import test from 'node:test';
import assert from 'node:assert/strict';
import { syncGlobalModelCredential } from '../src/model-credential-sync.mjs';

function configuration(value, source = 'global') {
  return { resolve: async () => ({ values: value ? { modelApiKey: value } : {}, sources: value ? { modelApiKey: source } : {} }) };
}

test('global model key is copied into the DSH credential service without returning the secret', async () => {
  const writes = [];
  const credentials = {
    resolve: async () => undefined,
    set: async (ref, value) => { writes.push([ref, value]); },
    describe: async () => ({ configured: true, source: 'memory' }),
  };
  const result = await syncGlobalModelCredential({ configuration: configuration('sk-global'), credentials });
  assert.deepEqual(writes, [['AGENTKIT_MODEL_API_KEY', 'sk-global']]);
  assert.deepEqual(result, { configured: true, source: 'memory', synchronized: true });
  assert.equal(JSON.stringify(result).includes('sk-global'), false);
});

test('process environment credentials remain authoritative', async () => {
  const writes = [];
  const result = await syncGlobalModelCredential({
    configuration: configuration('sk-global'),
    credentials: {
      resolve: async () => ({ value: 'sk-env', source: 'env' }),
      set: async (...args) => writes.push(args),
    },
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(result, { configured: true, source: 'env', synchronized: false });
});

test('missing global key does not write a credential', async () => {
  let writes = 0;
  const result = await syncGlobalModelCredential({
    configuration: configuration(''),
    credentials: { resolve: async () => undefined, set: async () => { writes += 1; } },
  });
  assert.equal(writes, 0);
  assert.deepEqual(result, { configured: false, source: 'missing' });
});
