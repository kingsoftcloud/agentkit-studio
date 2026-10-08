import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEngineDeploymentClient } from '../src/server-client.mjs';

const values = { cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AK-operator', cloudSecretKey: 'SK-operator' };
const configuration = { resolve: async () => ({ values: { ...values } }) };
const json = data => new Response(JSON.stringify(data));

function iamResponse(action) {
  if (action === 'ListAccessKeys') return json({ ListAccessKeyResult: { AccessKeyMetadata: { member: [
    { AccessKeyId: values.cloudAccessKey, UserName: 'studio-operator', Status: 'Active' },
  ] } } });
  if (action === 'GetUser') return json({ GetUserResult: { User: {
    UserName: 'studio-operator', UserId: 'verified-subaccount', Krn: 'krn:ksc:iam::123456789:user/studio-operator',
  } } });
  throw Error('unexpected IAM Action');
}

test('deployment creation sends the IAM-verified operator in signed KOP headers', async () => {
  const calls = [];
  let sent;
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (url, init) => {
    const host = new URL(url).hostname;
    if (host.startsWith('iam.')) {
      const form = new URLSearchParams(init.body);
      calls.push(form.get('Action'));
      if (form.get('Action') === 'GetUser') assert.equal(form.get('UserName'), 'studio-operator');
      return iamResponse(form.get('Action'));
    }
    calls.push('CreateAgentProduct');
    sent = init;
    return json({ Code: 0, Data: { AgentId: 'ar-verified' } });
  } });
  assert.equal((await client.createAgent({ Name: 'identity-regression', DeploymentType: 'Container' })).data.AgentId, 'ar-verified');
  assert.equal(sent.headers['X-Ksc-User-uuid'], 'verified-subaccount');
  assert.equal(sent.headers['X-Ksc-Account-Id'], '123456789');
  assert.match(sent.headers.Authorization, /SignedHeaders=[^,]*x-ksc-user-uuid/);
  assert.equal(JSON.parse(sent.body).Creator, undefined);
  assert.deepEqual(calls, ['ListAccessKeys', 'GetUser', 'CreateAgentProduct']);
});

test('an IAM failure prevents creation instead of silently dropping the operator', async () => {
  let creates = 0;
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (url) => {
    if (new URL(url).hostname.startsWith('iam.')) return new Response(JSON.stringify({ Error: { Code: 'AccessDenied', Message: 'private account details' } }), { status: 403 });
    creates++; return json({ Code: 0, Data: { AgentId: 'ar-should-not-exist' } });
  } });
  await assert.rejects(client.createAgent({ Name: 'identity-regression' }), error => {
    assert.equal(error.code, 'CLOUD_IDENTITY_UNVERIFIED');
    assert.doesNotMatch(error.message, /private account/); return true;
  });
  assert.equal(creates, 0);
});

test('update and delete carry the same verified identity; read-only diagnostics do not depend on IAM', async () => {
  const mutations = [], reads = []; let iamCalls = 0;
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (url, init) => {
    if (new URL(url).hostname.startsWith('iam.')) { iamCalls++; return iamResponse(new URLSearchParams(init.body).get('Action')); }
    const body = JSON.parse(init.body);
    if (['UpdateAgent', 'DeleteAgent'].includes(body.Action)) mutations.push(init);
    else reads.push(body.Action);
    return json({ Code: 0, Data: {} });
  } });
  const agent = client.forAgent('ar-from-receipt');
  await agent.get(); await agent.logs(); await agent.instances();
  assert.equal(iamCalls, 0);
  await agent.update({ Description: 'same operator' }); await agent.remove();
  assert.equal(iamCalls, 2);
  assert.deepEqual(reads, ['GetAgent', 'GetAgentLogs', 'ListInstances']);
  for (const init of mutations) {
    assert.equal(init.headers['X-Ksc-User-uuid'], 'verified-subaccount');
    assert.match(init.headers.Authorization, /SignedHeaders=[^,]*x-ksc-user-uuid/);
  }
});

test('preflight diagnoses a main account but transport blocks its creation', async () => {
  let sent;
  const client = createAgentEngineDeploymentClient({ configuration: { resolve: async () => ({ values: { ...values, cloudAccountId: 'unverified-owner' } }) }, fetchImpl: async (url, init) => {
    if (new URL(url).hostname.startsWith('iam.')) return json({ ListAccessKeyResult: { AccessKeyMetadata: { member: [
      { AccessKeyId: values.cloudAccessKey, UserName: '', Status: 'Active' },
    ] } } });
    sent = init; return json({ Code: 0, Data: {} });
  } });
  const identity = await client.inspectIdentity();
  assert.equal(identity.kind, 'main-account');
  assert.equal(identity.userUuid, null);
  assert.doesNotMatch(JSON.stringify(identity), /AK-operator|SK-operator/);
  await assert.rejects(client.createAgent({ Name: 'main-account-deployment' }), { code: 'CLOUD_SUBACCOUNT_REQUIRED' });
  assert.equal(sent, undefined);
});

test('a mismatched configured account prevents deployment mutations', async () => {
  let mutations = 0;
  const client = createAgentEngineDeploymentClient({ configuration: { resolve: async () => ({ values: { ...values, cloudAccountId: '987654321' } }) }, fetchImpl: async (url, init) => {
    if (new URL(url).hostname.startsWith('iam.')) return iamResponse(new URLSearchParams(init.body).get('Action'));
    mutations++; return json({ Code: 0, Data: {} });
  } });
  for (const operation of [() => client.createAgent({ Name: 'mismatch' }), () => client.forAgent('ar-owned').update({}), () => client.forAgent('ar-owned').remove()]) {
    await assert.rejects(operation(), { code: 'CLOUD_ACCOUNT_MISMATCH' });
  }
  assert.equal(mutations, 0);
});

test('public-to-inner KOP fallback preserves the verified operator and correlation id', async () => {
  const requests = []; let iamCalls = 0;
  const requestId = 'ac8722e3-e512-4d2d-8176-614368294cdd';
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (url, init) => {
    if (new URL(url).hostname.startsWith('iam.')) { iamCalls++; return iamResponse(new URLSearchParams(init.body).get('Action')); }
    requests.push({ url, init });
    if (requests.length === 1) return new Response('<Message>The inner account can only access through intranet</Message>', { status: 403 });
    return json({ Code: 0, Data: { AgentId: 'ar-inner' } });
  } });
  await client.createAgent({ Name: 'inner-identity' }, { requestId });
  assert.equal(iamCalls, 2);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[1].url).origin, 'http://aicp.inner.api.ksyun.com');
  for (const { init } of requests) {
    assert.equal(init.headers['X-Ksc-User-uuid'], 'verified-subaccount');
    assert.equal(init.headers['X-Ksc-Account-Id'], '123456789');
    assert.equal(init.headers['X-Ksc-Request-Id'], requestId);
    assert.match(init.headers.Authorization, /SignedHeaders=[^,]*x-ksc-user-uuid/);
  }
});
