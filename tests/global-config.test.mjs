import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';

test('global config resolves model and cloud values without exposing secret values in describe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-global-'));
  await writeFile(join(home, 'config.yaml'), 'model:\n  model: my-model\n  api_key: secret-model\ncloud:\n  KSYUN_REGION: cn-test-1\n  KSYUN_ACCOUNT_ID: acct\n');
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  const described = await config.describe();
  assert.equal(described.modelName, 'my-model');
  assert.equal(described.cloudRegion, 'cn-test-1');
  assert.equal(described.cloudAccountId, 'acct');
  assert.equal(described.modelConfigured, true);
  assert.equal(Object.hasOwn(described, 'modelApiKey'), false);
});

test('global config update persists secrets in host-owned config without overwriting unrelated keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-global-write-'));
  await writeFile(join(home, 'config.yaml'), 'version: 1\nother:\n  keep: yes\n');
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({ modelName: 'new-model', modelApiKey: 'secret' });
  const text = await readFile(join(home, 'config.yaml'), 'utf8');
  assert.match(text, /keep: yes/);
  assert.match(text, /new-model/);
  assert.match(text, /AGENTKIT_MODEL_API_KEY/);
});

test('global config supports multiple model profiles with separate redacted credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-global-profiles-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({
    modelProfiles: [
      { id: 'ksyun-flash', provider: 'ksyun', modelName: 'deepseek-v4.1-flash', baseUrl: '', credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true },
      { id: 'openai-mini', provider: 'openai', modelName: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY_OPENAI', enabled: true },
    ],
    modelProfileKeys: {
      AGENTKIT_MODEL_API_KEY: 'sk-ksyun',
      AGENTKIT_MODEL_API_KEY_OPENAI: 'sk-openai',
    },
  });
  const resolved = await config.resolve();
  assert.deepEqual(resolved.values.modelProfiles.map(({ apiKey, ...profile }) => profile), [
    { id: 'ksyun-flash', provider: 'ksyun', modelName: 'deepseek-v4.1-flash', baseUrl: '', credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true },
    { id: 'openai-mini', provider: 'openai', modelName: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY_OPENAI', enabled: true },
  ]);
  assert.deepEqual(resolved.values.modelProfiles.map(profile => profile.apiKey), ['sk-ksyun', 'sk-openai']);
  const described = await config.describe();
  assert.equal(described.modelProfiles.length, 2);
  assert.equal(described.modelProfiles[0].credentialConfigured, true);
  assert.equal(Object.hasOwn(described.modelProfiles[0], 'apiKey'), false);
  const text = await readFile(join(home, 'config.yaml'), 'utf8');
  assert.equal(text.includes('apiKey:'), false);
  assert.equal(text.includes('sk-ksyun'), true);
  assert.equal(text.includes('sk-openai'), true);
});
