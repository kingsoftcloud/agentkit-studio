import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudIdentityResolver } from '../src/cloud-identity.mjs';

const values = { cloudAccessKey: 'test-ak', cloudSecretKey: 'test-sk' };
const json = data => new Response(JSON.stringify(data));
const listing = (entries = [{ AccessKeyId: 'test-ak', UserName: 'operator', Status: 'Active' }]) => ({ ListAccessKeyResult: { AccessKeyMetadata: { member: entries } } });
const user = { UserName: 'operator', UserId: 'user-123', Krn: 'krn:ksc:iam::123456789:user/operator' };

test('own-key IAM queries are signed and contain no browser identity claims', async () => {
  const calls = [];
  const resolver = createCloudIdentityResolver({ now: () => 42, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new URLSearchParams(init.body).get('Action') === 'ListAccessKeys' ? json(listing()) : json({ GetUserResult: { User: user } });
  } });
  const identity = await resolver.resolve({ ...values, cloudUserUuid: 'forged', cloudUserName: 'someone-else' });
  assert.deepEqual(identity, { kind: 'subaccount', accountId: '123456789', userUuid: 'user-123', userName: 'operator', verifiedAt: 42 });
  assert(Object.isFrozen(identity));
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://iam.api.ksyun.com');
    assert.equal(init.redirect, 'error');
    assert.match(init.headers.Authorization, /cn-beijing-6\/iam\/aws4_request/);
    assert.doesNotMatch(init.body, /test-sk|forged|someone-else/);
    assert.equal(init.headers['X-Ksc-User-uuid'], undefined);
  }
  assert.equal(new URLSearchParams(calls[0].init.body).has('UserName'), false);
  assert.equal(new URLSearchParams(calls[1].init.body).get('UserName'), 'operator');
});

test('a matching active key with an explicit empty username is a main account, not a synthetic subaccount', async () => {
  let calls = 0;
  const resolver = createCloudIdentityResolver({ fetchImpl: async () => {
    calls++; return json(listing([{ AccessKeyId: 'test-ak', UserName: '', Status: 'Active' }]));
  } });
  const identity = await resolver.resolve({ ...values, cloudAccountId: 'unverified-owner' });
  assert.equal(identity.kind, 'main-account');
  assert.equal(identity.userUuid, null);
  assert.equal(identity.accountId, null);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(identity), /test-ak|test-sk|unverified-owner/);
});

test('missing, duplicate, truncated, inactive and malformed key listings stay unverified', async () => {
  const active = { AccessKeyId: 'test-ak', UserName: 'operator', Status: 'Active' };
  for (const payload of [{}, listing([]), listing([active, active]), listing([{ ...active, AccessKeyId: 'other' }]),
    listing([{ ...active, UserName: undefined }]), listing([{ ...active, UserName: ' operator ' }]),
    listing([{ ...active, Status: 'Inactive' }]), { ...listing(), IsTruncated: true }, { ...listing(), NextMarker: 'more' },
    { ...listing(), IsTruncated: 'false' }, { ListAccessKeyResult: { ...listing().ListAccessKeyResult, IsTruncated: true } }]) {
    const resolver = createCloudIdentityResolver({ fetchImpl: async () => json(payload) });
    await assert.rejects(resolver.resolve(values), { code: 'CLOUD_IDENTITY_UNVERIFIED' });
  }
});

test('inconsistent IAM user name, KRN and UUID cannot become signed identity headers', async () => {
  for (const changed of [{ UserName: 'other' }, { UserId: '' }, { UserId: 'injected\r\nHeader' },
    { Krn: 'krn:ksc:iam::123456789:user/other' }, { Krn: 'untrusted' }]) {
    const resolver = createCloudIdentityResolver({ fetchImpl: async (_url, init) => new URLSearchParams(init.body).get('Action') === 'ListAccessKeys'
      ? json(listing()) : json({ GetUserResult: { User: { ...user, ...changed } } }) });
    await assert.rejects(resolver.resolve(values), { code: 'CLOUD_IDENTITY_UNVERIFIED' });
  }
});

test('credential rotation, explicit refresh and cache expiry revalidate identity; failures are not cached', async () => {
  let time = 10, calls = 0, denied = false;
  const resolver = createCloudIdentityResolver({ now: () => time, fetchImpl: async () => {
    calls++;
    if (denied) return new Response('', { status: 403 });
    return json(listing([{ AccessKeyId: 'test-ak', UserName: '', Status: 'Active' }]));
  } });
  await resolver.resolve(values); await resolver.resolve(values); assert.equal(calls, 1);
  await resolver.resolve({ ...values, cloudSecretKey: 'rotated-sk' }); assert.equal(calls, 2);
  const temporary = { ...values, cloudSessionToken: 'temporary-token' };
  await resolver.resolve(temporary); assert.equal(calls, 3);
  time += 300000; await resolver.resolve(temporary); assert.equal(calls, 4);
  denied = true;
  await assert.rejects(resolver.resolve(temporary, { forceRefresh: true }), { code: 'CLOUD_IDENTITY_UNVERIFIED' });
  await assert.rejects(resolver.resolve(temporary), { code: 'CLOUD_IDENTITY_UNVERIFIED' });
  denied = false;
  await resolver.resolve(temporary); assert.equal(calls, 7);
});

test('cached identity must still match the currently configured account', async () => {
  let calls = 0;
  const resolver = createCloudIdentityResolver({ fetchImpl: async (_url, init) => {
    calls++; return new URLSearchParams(init.body).get('Action') === 'ListAccessKeys' ? json(listing()) : json({ GetUserResult: { User: user } });
  } });
  await resolver.resolve(values);
  await assert.rejects(resolver.resolve({ ...values, cloudAccountId: '987654321' }), { code: 'CLOUD_ACCOUNT_MISMATCH' });
  assert.equal(calls, 2);
});

test('IAM uses the inner endpoint only after an explicit public denial or an explicit inner control plane', async () => {
  const hosts = [];
  const resolver = createCloudIdentityResolver({ fetchImpl: async (url, init) => {
    hosts.push(new URL(url).origin);
    if (hosts.length === 1) return new Response('<Error><Code>InnerAccountCanOnlyAccessThroughIntranet</Code></Error>', { status: 403 });
    return new URLSearchParams(init.body).get('Action') === 'ListAccessKeys' ? json(listing()) : json({ GetUserResult: { User: user } });
  } });
  await resolver.resolve(values);
  assert.deepEqual(hosts, ['https://iam.api.ksyun.com', 'http://iam.inner.api.ksyun.com', 'http://iam.inner.api.ksyun.com']);
  hosts.length = 0;
  const direct = createCloudIdentityResolver({ fetchImpl: async url => {
    hosts.push(new URL(url).origin); return json(listing([{ AccessKeyId: 'test-ak', UserName: '', Status: 'Active' }]));
  } });
  await direct.resolve({ ...values, cloudServerUrl: 'http://aicp.inner.api.ksyun.com' });
  assert.deepEqual(hosts, ['http://iam.inner.api.ksyun.com']);
});

test('network errors, redirects and generic denials neither leak service details nor downgrade to HTTP', async () => {
  for (const response of [() => { throw Error('secret transport error'); }, () => new Response('secret upstream error', { status: 403 }),
    () => new Response('', { status: 302, headers: { location: 'https://unrelated.invalid' } }),
    () => new Response('secret oversized error', { status: 200, headers: { 'content-length': '2000000' } })]) {
    let calls = 0;
    const resolver = createCloudIdentityResolver({ fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(resolver.resolve(values), error => {
      assert.equal(error.code, 'CLOUD_IDENTITY_UNVERIFIED'); assert.doesNotMatch(error.message, /secret|unrelated/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('identity probes reject custom targets before sending any cloud credentials', async () => {
  let calls = 0;
  const resolver = createCloudIdentityResolver({ fetchImpl: async () => { calls++; throw Error('must not send'); } });
  for (const cloudServerUrl of ['https://aicp.api.ksyun.com.attacker.invalid', 'http://aicp.api.ksyun.com',
    'http://aicp.inner.api.ksyun.com:8080', 'https://aicp.api.ksyun.com/path', 'https://user@aicp.api.ksyun.com']) {
    await assert.rejects(resolver.resolve({ ...values, cloudServerUrl }), { code: 'CLOUD_IDENTITY_TARGET_UNSUPPORTED' });
  }
  assert.equal(calls, 0);
});
