import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';

test('Native model options survive save/reopen and malformed options fail before writing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-native-options-'));
  const options = { protocol: 'openai-responses', contextWindow: 64000, maxOutputTokens: 4000,
    requestTimeoutMs: 160000, parameters: { temperature: 0.2, reasoning: { effort: 'high' } },
    headers: { 'X-Gateway-Token': 'team-token', 'X-Request-Trace': 'enabled' } };
  const profile = { id: 'vision', provider: 'custom', modelName: 'observer', input: ['text', 'image'],
    baseUrl: 'https://model.invalid/v1', ...options };
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home }, inheritLegacy: false });
  await config.update({ modelProfiles: [profile] });
  const expected = await readFile(join(home, 'config.yaml'), 'utf8');
  const reopened = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home }, inheritLegacy: false });
  const resolved = (await reopened.resolve()).values.modelProfiles[0];
  for (const [key, value] of Object.entries(options)) assert.deepEqual(resolved[key], value);
  for (const invalid of [{ protocol: 'unsupported' }, { contextWindow: 0 }, { maxOutputTokens: -1 },
    { requestTimeoutMs: '10' }, { parameters: [] }, { headers: [] }, { headers: 'X-Token: 1' },
    { headers: { 'X-Bad Header': '1' } }, { headers: { 'X-Token': 5 } },
    { headers: { 'X-Token': 'line\r\nInjected: 1' } },
    { headers: { 'X-Token': 'first', 'x-token': 'second' } },
    { headers: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-Header-${index}`, 'v'])) }]) {
    await assert.rejects(config.update({ modelProfiles: [{ ...profile, ...invalid }] }), { code: 'CONFIGURATION_INVALID' });
    assert.equal(await readFile(join(home, 'config.yaml'), 'utf8'), expected);
  }
});

test('reserves the normalized Star Harness service route when saving enabled model profiles', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-reserved-model-route-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home }, inheritLegacy: false });
  const profile = { id: 'ordinary', provider: 'custom', modelName: 'wide', baseUrl: 'https://model.invalid/v1' };
  const updates = [];
  const unsubscribe = config.onChange(({ modelProfiles }) => updates.push(modelProfiles[0].id));
  await config.update({ modelProfiles: [profile] });
  for (const id of ['harness-service', 'Harness_Service', 'harness.service']) {
    await assert.rejects(config.update({ modelProfiles: [{ ...profile, id }] }), {
      code: 'CONFIGURATION_INVALID', message: /Star Harness/,
    });
  }
  assert.deepEqual(updates, ['ordinary']);
  assert.equal((await config.describe()).modelProfiles[0].id, 'ordinary');
  // An existing conflicting profile can be disabled when repairing settings.
  await config.update({ modelProfiles: [{ ...profile, id: 'harness-service', enabled: false }] });
  assert.deepEqual(updates, ['ordinary', 'harness-service']);
  unsubscribe();
  await config.update({ modelProfiles: [profile] });
  assert.deepEqual(updates, ['ordinary', 'harness-service']);
});

test('clearing every request header removes the field instead of freezing an empty record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-native-headers-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home }, inheritLegacy: false });
  const profile = { id: 'gateway', provider: 'custom', modelName: 'model', baseUrl: 'https://model.invalid/v1',
    headers: { 'X-Gateway-Token': '  team-token  ' } };
  await config.update({ modelProfiles: [profile] });
  const saved = (await config.resolve()).values.modelProfiles[0];
  assert.deepEqual(saved.headers, { 'X-Gateway-Token': 'team-token' }, 'values are trimmed before they reach the wire');
  // The settings form drops an emptied row and saves `undefined`, so the stored
  // profile has no headers key at all rather than an empty object.
  await config.update({ modelProfiles: [{ ...profile, headers: {} }] });
  const cleared = (await config.resolve()).values.modelProfiles[0];
  assert.equal(Object.hasOwn(cleared, 'headers'), false);
  assert.doesNotMatch(await readFile(join(home, 'config.yaml'), 'utf8'), /headers/);
});

test('Host persists completed base URLs consistently for scalar and profile settings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-endpoint-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({ modelProvider: 'custom', modelBaseUrl: 'gateway.test/v1/chat/completions',
    modelProfiles: [{id:'gateway',provider:'custom',modelName:'model',baseUrl:'gateway.test/v1/responses'}] });
  const described = await config.describe();
  assert.equal(described.modelBaseUrl, 'https://gateway.test/v1');
  assert.equal(described.modelProfiles[0].baseUrl, 'https://gateway.test/v1');
});

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
    { id: 'ksyun-flash', provider: 'ksyun', modelName: 'deepseek-v4.1-flash', baseUrl: '', credentialName: 'AGENTKIT_MODEL_API_KEY', enabled: true, default: true },
    { id: 'openai-mini', provider: 'openai', modelName: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY_OPENAI', enabled: true, default: false },
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

test('global config keeps exactly one explicit default when profiles are reordered or legacy-shaped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-global-default-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({ modelProfiles: [
    { id: 'first', provider: 'ksyun', modelName: 'first', credentialName: 'KEY_FIRST', enabled: true, default: false },
    { id: 'second', provider: 'openai', modelName: 'second', credentialName: 'KEY_SECOND', enabled: true, default: true },
    { id: 'third', provider: 'custom', modelName: 'third', credentialName: 'KEY_THIRD', enabled: true, default: true },
  ] });
  const profiles = (await config.resolve()).values.modelProfiles;
  assert.deepEqual(profiles.map(profile => [profile.id, profile.default]), [['first', false], ['second', true], ['third', false]]);
});

test('a provider can be saved and removed without adding a model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-providers-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home }, inheritLegacy: false });
  const provider = { id: 'provider-test', provider: 'custom', baseUrl: 'gateway.test/v1/models', connectionName: 'Research', credentialName: 'RESEARCH_KEY' };
  await config.update({ modelConnections: [provider], modelProfileKeys: { RESEARCH_KEY: 'provider-fixture' } });
  const described = await config.describe();
  assert.equal(described.modelProfiles[0].id, 'default');
  assert.deepEqual(described.modelConnections, [{ ...provider, baseUrl: 'https://gateway.test/v1', credentialConfigured: true }]);
  assert.equal((await config.resolve()).values.modelConnections[0].apiKey, 'provider-fixture');
  await assert.rejects(config.update({ modelConnections: [provider, provider] }), { code: 'CONFIGURATION_INVALID' });
  await config.update({ modelConnections: [] });
  assert.deepEqual((await config.describe()).modelConnections, []);
});

test('Codex API format persists per profile without changing default or credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-codex-format-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  const profiles = [
    { id: 'chat', provider: 'custom', modelName: 'one', baseUrl: 'https://chat.example/v1', credentialName: 'CHAT_KEY', default: true, codexApi: 'chat-completions' },
    { id: 'responses', provider: 'custom', modelName: 'two', baseUrl: 'https://responses.example/v1', credentialName: 'RESPONSES_KEY', codexApi: 'responses' },
  ];
  await config.update({ modelProfiles: profiles, modelProfileKeys: { CHAT_KEY: 'private-chat', RESPONSES_KEY: 'private-responses' } });
  const described = await config.describe();
  assert.deepEqual(described.modelProfiles.map(p => p.codexApi), ['chat-completions', 'responses']);
  assert.ok(!JSON.stringify(described).includes('private-'));
  await config.update({ modelProfiles: described.modelProfiles.map(p => ({ ...p, codexApi: 'responses' })) });
  const values = (await config.resolve()).values;
  assert.deepEqual(values.modelProfiles.map(p => [p.apiKey, p.default]), [['private-chat', true], ['private-responses', false]]);
  await assert.rejects(config.update({ modelProfiles: [{ ...profiles[0], codexApi: 'unknown' }] }), /接口格式无效/);
});

test('reasoning opt-in survives describe so a reload cannot erase the model declaration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-reasoning-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({ modelProfiles: [
    { id: 'reasoner', provider: 'ksyun', modelName: 'deepseek', credentialName: 'KEY', reasoningEfforts: true, defaultReasoningEffort: 'max' },
    { id: 'plain', provider: 'ksyun', modelName: 'seed', credentialName: 'KEY' },
  ] });
  const described = await config.describe();
  assert.deepEqual(described.modelProfiles.map(profile => [profile.reasoningEfforts, profile.defaultReasoningEffort]),
    [[true, 'max'], [undefined, undefined]]);
  // An unknown level falls back instead of being written back verbatim.
  await config.update({ modelProfiles: [{ id: 'reasoner', provider: 'ksyun', modelName: 'deepseek', credentialName: 'KEY', reasoningEfforts: true, defaultReasoningEffort: 'ultra' }] });
  assert.equal((await config.describe()).modelProfiles[0].defaultReasoningEffort, 'high');
  // The map shape some bridges emit is accepted and normalized to the marker.
  await config.update({ modelProfiles: [{ id: 'reasoner', provider: 'ksyun', modelName: 'deepseek', credentialName: 'KEY', reasoningEfforts: { low: 'low', high: 'high', max: 'max' } }] });
  const normalized = (await config.describe()).modelProfiles[0];
  assert.equal(normalized.reasoningEfforts, true);
  assert.equal(normalized.defaultReasoningEffort, 'high');
});

test('reasoning defaults are validated against the provider capability table', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agentkit-reasoning-provider-'));
  const config = createGlobalConfiguration({ home, env: { AGENTKIT_HOME: home } });
  await config.update({ modelProfiles: [
    // OpenAI's medium is a legal level even though the old three-level
    // allow-list did not know it.
    { id: 'gpt', provider: 'openai', modelName: 'gpt-5', credentialName: 'OPENAI_KEY', reasoningEfforts: true, defaultReasoningEffort: 'medium' },
    // An unknown provider may not keep `max`, which it never sends.
    { id: 'custom', provider: 'custom', modelName: 'compatible', credentialName: 'CUSTOM_KEY', reasoningEfforts: true, defaultReasoningEffort: 'max' },
    // Ksyun keeps max; only the provider's own enum is authoritative.
    { id: 'ksyun', provider: 'ksyun', modelName: 'deepseek', credentialName: 'KEY', reasoningEfforts: true, defaultReasoningEffort: 'max' },
  ] });
  const described = await config.describe();
  assert.deepEqual(described.modelProfiles.map(profile => [profile.provider, profile.defaultReasoningEffort]),
    [['openai', 'medium'], ['custom', 'high'], ['ksyun', 'max']]);
});
