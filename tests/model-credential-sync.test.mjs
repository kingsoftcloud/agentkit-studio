import test from 'node:test';
import assert from 'node:assert/strict';
import { syncGlobalModelCredential, describeGlobalModelCredential } from '../src/model-credential-sync.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('credential readiness recognizes a DSH provider without exposing its value', async () => {
  const result = await describeGlobalModelCredential({
    configuration: configuration(''),
    credentials: { describe: async name => name === 'OPENAI_API_KEY' ? { configured: true, source: 'env' } : { configured: false } },
    codexHome: '/path/that/does/not/exist',
  });
  assert.deepEqual(result, { configured: true, source: 'env', credential: 'OPENAI_API_KEY' });
  assert.equal(JSON.stringify(result).includes('sk-'), false);
});

test('credential readiness recognizes native Codex auth metadata only', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'agentkit-codex-auth-'));
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ access_token: 'secret' }), { mode: 0o600 });
  const result = await describeGlobalModelCredential({
    configuration: configuration(''),
    credentials: { describe: async () => ({ configured: false }) },
    codexHome,
  });
  assert.deepEqual(result, { configured: true, source: 'codex-auth' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
