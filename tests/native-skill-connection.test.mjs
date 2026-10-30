import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNativeSkillConnection } from '../src/providers/native-skill-host.mjs';
import { createNativeSkillService } from '../src/providers/native-skill-service.mjs';
const configuration = { resolve: async () => ({ values: { cloudAccessKey: 'cloud-key', cloudSecretKey: 'cloud-secret',
  cloudSessionToken: 'cloud-session', cloudAccountId: 'account', cloudServerUrl: 'https://aicp.api.ksyun.com' } }) };

test('custom REST directory with over 100 entries is single-call and never receives cloud signing credentials', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { Skills: Array.from({ length: 101 }, (_, i) => ({ Name: `skill-${i}`, SkillId: `id-${i}` })),
      SkillSpaceId: 'space', TotalCount: 105 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { KSADK_SKILL_SERVICE_URL: `http://127.0.0.1:${server.address().port}/service/openapi.json`,
    KSADK_SKILL_SERVICE_TOKEN: 'service-token' };
  const connection = await createNativeSkillConnection({ configuration, env });
  env.KSADK_SKILL_SERVICE_TOKEN = 'changed';
  const result = await createNativeSkillService(connection.client).listSkillsBySpaceId('space');
  assert.equal(requests.length, 1); assert.equal(result.activeSkills.length, 101);
  assert.equal(result.truncated, true); assert.equal(result.paginationWarning, 'pagination_unavailable');
  const { url, headers } = requests[0];
  assert.equal(url, '/service/ListSkillsBySpaceId?SpaceId=space');
  assert.equal(headers.authorization, 'Bearer service-token');
  assert.equal(headers['x-amz-security-token'], undefined); assert.equal(headers['x-amz-date'], undefined);
});

test('explicit KOP endpoint pins Skill credentials, signature service, API version and concrete pre-online region', async () => {
  let seen;
  const env = { KSADK_SKILL_SERVICE_ENDPOINT: 'aicp.internal.api.ksyun.com', KSADK_SKILL_SERVICE_ACCESS_KEY: 'skill-key',
    KSADK_SKILL_SERVICE_SECRET_KEY: 'skill-secret', KSADK_SKILL_SERVICE_API_VERSION: '2026-01-01',
    KSADK_SKILL_SERVICE_SIGN_SERVICE: 'skill-service', KSADK_SKILL_SERVICE_REGION: 'pre-online',
    AGENTENGINE_PRE_CONTROL_REGION: 'cn-test-1', AGENTENGINE_PRE_CUSTOM_SOURCE: 'pinned-pre' };
  const connection = await createNativeSkillConnection({ configuration, env, fetchImpl: async (url, options) => {
    seen = { url, options }; return new Response(JSON.stringify({ Code: 0, Data: { SkillSpaces: [] } }));
  } });
  env.KSADK_SKILL_SERVICE_ACCESS_KEY = 'replacement'; env.AGENTENGINE_PRE_CUSTOM_SOURCE = 'changed';
  await connection.client.skillAction('ListSkillSpaces', { PageNumber: 1, PageSize: 100 });
  assert.equal(seen.url.origin, 'http://aicp.internal.api.ksyun.com');
  assert.equal(seen.url.searchParams.get('Version'), '2026-01-01');
  assert.match(seen.options.headers.Authorization, /Credential=skill-key\/\d+\/cn-test-1\/skill-service\/aws4_request/u);
  assert.equal(seen.options.headers['X-KSC-CUSTOM-SOURCE'], 'pinned-pre');
  assert.equal(seen.options.redirect, 'error');
});

test('a lookalike KOP hostname is REST and never gets global cloud AK/SK or session token', async () => {
  let headers;
  const connection = await createNativeSkillConnection({ configuration, env: { KSADK_SKILL_SERVICE_URL: 'https://aicp.api.ksyun.com.other.example/api' },
    fetchImpl: async (_, options) => { headers = options.headers; return new Response('{"Data":{}}'); } });
  await connection.client.skillAction('ListSkillSpaces');
  assert.equal(connection.client.skillProtocol, 'rest');
  assert.doesNotMatch(JSON.stringify(headers), /cloud-key|cloud-secret|cloud-session|AWS4/u);
});

test('explicit REST service rejects a foreign directory instead of publishing cross-space skills', async () => {
  const connection = await createNativeSkillConnection({ configuration, env: { KSADK_SKILL_SERVICE_URL: 'https://skills.example' },
    fetchImpl: async () => new Response('{"Data":{"SkillSpaceId":"foreign","Skills":[]}}') });
  await assert.rejects(createNativeSkillService(connection.client).listSkillsBySpaceId('space'), { code: 'SKILL_SERVICE_INVALID_RESPONSE' });
});

test('explicit connection rejects malformed URL and incomplete credential pair, with no network request', async () => {
  for (const env of [{ KSADK_SKILL_SERVICE_URL: 'https://user:secret@example.com' },
    { KSADK_SKILL_SERVICE_URL: 'http://aicp.api.ksyun.com' },
    { KSADK_SKILL_SERVICE_URL: 'https://example.com', KSADK_SKILL_SERVICE_ACCESS_KEY: 'one-key' }]) {
    await assert.rejects(createNativeSkillConnection({ configuration, env, fetchImpl: () => assert.fail('invalid config cannot fetch') }),
      /NATIVE_SKILL_(SERVICE_URL_INVALID|CREDENTIAL_PAIR_REQUIRED)/u);
  }
});

test('non-cooperative response body cancels promptly and observes a subsequent rejection', async () => {
  let enter, rejectRead;
  const entered = new Promise(resolve => { enter = resolve; });
  const controller = new AbortController();
  const connection = await createNativeSkillConnection({ configuration, env: { KSADK_SKILL_SERVICE_URL: 'https://skills.example' },
    fetchImpl: async () => ({ ok: true, body: { getReader: () => ({
      read() { enter(); return new Promise((_, reject) => { rejectRead = reject; }); }, cancel: () => Promise.resolve(),
    }) } }) });
  const pending = connection.client.skillAction('ListSkillSpaces', {}, { signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  rejectRead(new Error('late private body error')); await new Promise(resolve => setImmediate(resolve));
});

test('invalid UTF-8/JSON is redacted and response bytes are bounded', async () => {
  for (const [body, code] of [['PRIVATE-SERVER-SECRET invalid json', 'SKILL_SERVICE_INVALID_RESPONSE'],
    [new Uint8Array(8 * 1024 * 1024 + 1), 'SKILL_SERVICE_RESPONSE_TOO_LARGE']]) {
    const connection = await createNativeSkillConnection({ configuration, env: { KSADK_SKILL_SERVICE_URL: 'https://skills.example' },
      fetchImpl: async () => new Response(body) });
    await assert.rejects(connection.client.skillAction('ListSkillSpaces'), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /PRIVATE-SERVER-SECRET/u); return true;
    });
  }
});
