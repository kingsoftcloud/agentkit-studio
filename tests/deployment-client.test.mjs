import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEngineClient, createAgentEngineDeploymentClient } from '../src/server-client.mjs';

const values = { cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' };
const configuration = { resolve: async () => ({ values }) };
const ok = data => new Response(JSON.stringify({ Code: 0, RequestId: 'server-request', Data: data }));
// These tests exercise the control-plane transport. Identity-specific behavior
// is covered separately through the same real deployment client.
function deploymentClient(options) {
  return createAgentEngineDeploymentClient({ ...options, fetchImpl: async (url, init) => {
    if (new URL(url).hostname.startsWith('iam.')) return Response.json(new URLSearchParams(init.body).get('Action') === 'GetUser'
      ? { GetUserResult: { User: { UserName: 'operator', UserId: 'verified-operator', Krn: 'krn:ksc:iam::123456789:user/operator' } } }
      : { ListAccessKeyResult: { AccessKeyMetadata: { member: [{ AccessKeyId: values.cloudAccessKey, UserName: 'operator', Status: 'Active' }] } } });
    return options.fetchImpl(url, init);
  } });
}

test('deployment Actions stay out of the generic Studio bridge', async () => {
  let calls = 0;
  const client = createAgentEngineClient({ configuration, fetchImpl: async () => { calls++; return ok({}); } });
  for (const name of ['CreateAgentProduct', 'UploadCode', 'GetPresignedUrl', 'DeleteAgent', 'GetAgentLogs', 'ListInstances']) {
    await assert.rejects(client.action(name, {}), { code: 'ACTION_NOT_ALLOWED' });
  }
  assert.equal(calls, 0);
  assert.equal(createAgentEngineDeploymentClient({ configuration }).action, undefined);
});

test('deployment create preserves preproduction signing and one correlation id on inner-account fallback', async () => {
  const requests = [], requestId = '83b10098-477d-4e4e-8c87-9c26eb4ee040';
  const client = deploymentClient({ configuration, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return new Response('<Message>The inner account can only access through intranet</Message>', { status: 403 });
    return ok({ AgentId: 'ar-created' });
  } });
  const payload = { Name: 'Studio canary', DeploymentType: 'Container', Framework: 'harness', AutoPay: true };
  assert.equal((await client.createAgent(payload, { requestId })).data.AgentId, 'ar-created');
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /^http:\/\/aicp\.inner\.api\.ksyun\.com\//);
  for (const { init } of requests) {
    assert.equal(init.headers['X-KSC-CUSTOM-SOURCE'], 'pre');
    assert.equal(init.headers['X-Ksc-Request-Id'], requestId);
    assert.match(init.headers.Authorization, /cn-beijing-6\/aicp\/aws4_request/);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    for (const [key, value] of Object.entries(payload)) assert.equal(body[key], value);
  }
});

test('a scoped deployment cannot update another Agent or remove shared artifacts', async () => {
  const calls = [];
  const client = deploymentClient({ configuration, fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body)); return ok({ deleted: true });
  } });
  assert.throws(() => client.forAgent(''), { code: 'INVALID_AGENT_ID' });
  const agent = client.forAgent('ar-owned-canary');
  assert.throws(() => agent.update({ AgentId: 'ar-unrelated' }), { code: 'DEPLOYMENT_AGENT_MISMATCH' });
  await agent.get({ IncludeApiKey: true });
  await agent.update({ EnvironmentVariablePatch: { Upsert: [{ Key: 'TOKEN', Value: 'secret', IsSensitive: true }] } });
  await agent.instances({ Page: 1, PageSize: 10 });
  await agent.logs({ LogType: 'Stdout', PageSize: 20 });
  await agent.remove();
  assert.deepEqual(calls.map(x => x.Action), ['GetAgent', 'UpdateAgent', 'ListInstances', 'GetAgentLogs', 'DeleteAgent']);
  assert(calls.every(x => x.AgentId === 'ar-owned-canary'));
  for (const key of ['HardDelete', 'SyncDeleteKs3', 'SyncDeleteKcr', 'SyncDeleteKlog']) assert.equal(calls.at(-1)[key], false);
});

test('unknown mutation results, capacity errors and redirects are not retried or echoed', async () => {
  for (const response of [() => { throw Error('secret transport payload'); },
    () => new Response(JSON.stringify({ Code: 429, Message: 'secret response payload' }), { status: 429 }),
    () => new Response('', { status: 302, headers: { location: 'https://unrelated.invalid' } })]) {
    let calls = 0;
    const client = deploymentClient({ configuration, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(client.createAgent({ Name: 'canary' }), error => {
      assert.doesNotMatch(error.message, /secret|unrelated/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('upload uses the existing UploadCode Action and does not send the ZIP to the control plane', async () => {
  let body;
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body); return ok({ PresignedUrl: 'https://storage.invalid/upload', KS3Path: 'bucket/bundle.zip' });
  } });
  const result = await client.uploadCode({ Filename: 'portable.zip' });
  assert.equal(body.Action, 'UploadCode');
  assert.equal(body.Filename, 'portable.zip');
  assert.equal(result.data.KS3Path, 'bucket/bundle.zip');
  await client.getUploadUrl('portable.zip');
  assert.equal(body.Action, 'GetPresignedUrl');
  assert.equal(body.Filename, 'portable.zip');
});

test('explicit official inner endpoint is signed; lookalikes and other remote HTTP origins stay denied', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(new URL(url).origin, 'http://aicp.inner.api.ksyun.com');
    assert.match(init.headers.Authorization, /cn-beijing-6\/aicp\/aws4_request/);
    assert.equal(init.headers['X-KSC-CUSTOM-SOURCE'], 'pre');
    return ok({ Bucket: 'fixtures', ObjectKey: 'uploads/bundle.zip' });
  };
  for (const cloudServerUrl of ['http://aicp.inner.api.ksyun.com', 'http://aicp.inner.api.ksyun.com.attacker.invalid', 'http://aicp.inner.api.ksyun.com:8080', 'http://example.invalid']) {
    const client = createAgentEngineDeploymentClient({ configuration: { resolve: async () => ({ values: { ...values, cloudServerUrl } }) }, fetchImpl });
    const result = client.getUploadUrl('bundle.zip');
    if (cloudServerUrl === 'http://aicp.inner.api.ksyun.com') await result;
    else await assert.rejects(result, { code: 'SERVER_URL_INVALID' });
  }
  assert.equal(calls, 1);
});
