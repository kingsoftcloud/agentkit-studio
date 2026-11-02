import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ks3EndpointError, fetchKs3, isKs3TransportError, ks3Variants, normalizeKs3Region,
  parseKs3Hostname, resetKs3EndpointCaches, resolveEndpointMode,
} from '../src/ks3-endpoints.mjs';

const PUBLIC = 'https://agentengine-cn-beijing-6-73398439-skills.ks3-cn-beijing.ksyuncs.com/5fb98c92/prd-writer.zip?Signature=abc%2B%3D&Expires=1793604711';
const INTERNAL = 'https://agentengine-cn-beijing-6-73398439-skills.ks3-cn-beijing-internal.ksyuncs.com/5fb98c92/prd-writer.zip?Signature=abc%2B%3D&Expires=1793604711';

function transportFailure(code = 'UND_ERR_CONNECT_TIMEOUT') {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

function response(status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(), body: null };
}

function okFetch(calls) {
  return async url => { calls.push(String(url)); return response(200); };
}

test('KS3 hostnames parse into bucket, region and variant', () => {
  assert.deepEqual(parseKs3Hostname('agentengine-skills.ks3-cn-beijing.ksyuncs.com'),
    { bucket: 'agentengine-skills', region: 'cn-beijing', internal: false });
  assert.deepEqual(parseKs3Hostname('agentengine-skills.ks3-cn-beijing-internal.ksyuncs.com'),
    { bucket: 'agentengine-skills', region: 'cn-beijing', internal: true });
  assert.deepEqual(parseKs3Hostname('ks3-cn-shanghai.ksyuncs.com'),
    { bucket: null, region: 'cn-shanghai', internal: false });
  // Only official, known regions are KS3 addresses the runtime may rewrite.
  assert.equal(parseKs3Hostname('bucket.ks3-cn-unknown.ksyuncs.com'), null);
  assert.equal(parseKs3Hostname('evil.example.test'), null);
});

test('variants preserve scheme, port, path and query in both directions', () => {
  const publicVariants = ks3Variants(PUBLIC);
  assert.equal(publicVariants.publicUrl.toString(), PUBLIC);
  assert.equal(publicVariants.internalUrl.toString(), INTERNAL);

  // A non-default port survives the host swap; the signature only covers path+query.
  const ported = ks3Variants('https://bucket.ks3-cn-beijing.ksyuncs.com:8443/a.zip?X=1#frag');
  assert.equal(ported.internalUrl.toString(), 'https://bucket.ks3-cn-beijing-internal.ksyuncs.com:8443/a.zip?X=1#frag');
  assert.equal(ported.publicUrl.toString(), 'https://bucket.ks3-cn-beijing.ksyuncs.com:8443/a.zip?X=1#frag');

  const internalVariants = ks3Variants(INTERNAL);
  assert.equal(internalVariants.publicUrl.toString(), PUBLIC);
  assert.equal(internalVariants.internalUrl.toString(), INTERNAL);

  assert.equal(ks3Variants('https://example.test/frozen.zip'), null);
  assert.equal(ks3Variants('not a url'), null);
  assert.equal(normalizeKs3Region('cn-beijing-6'), 'cn-beijing');
  assert.equal(normalizeKs3Region('cn-unknown-1'), null);
});

test('endpoint mode prefers an override, then the last working variant, then declaration, then probe', async () => {
  resetKs3EndpointCaches();
  let probes = 0;
  const unreachable = async () => { probes += 1; return false; };
  assert.equal(await resolveEndpointMode({ env: {}, region: 'cn-beijing', probe: unreachable }), 'internal');
  assert.equal(probes, 1);
  // The probe result is cached, so a second resolution costs no connection.
  assert.equal(await resolveEndpointMode({ env: {}, region: 'cn-beijing', probe: unreachable }), 'internal');
  assert.equal(probes, 1);

  resetKs3EndpointCaches();
  assert.equal(await resolveEndpointMode({ env: { AGENTENGINE_NETWORK_MODE: 'private' }, region: 'cn-beijing', probe: unreachable }), 'internal');
  assert.equal(await resolveEndpointMode({ env: { AGENTENGINE_NETWORK_MODE: 'public' }, region: 'cn-beijing', probe: unreachable }), 'public');
  // An operator override wins over the platform declaration.
  assert.equal(await resolveEndpointMode({ env: { AGENTKIT_KS3_ENDPOINT_MODE: 'internal', AGENTENGINE_NETWORK_MODE: 'public' }, region: 'cn-beijing' }), 'internal');
  assert.equal(await resolveEndpointMode({ env: { AGENTKIT_KS3_ENDPOINT_MODE: 'public', AGENTENGINE_NETWORK_MODE: 'private' }, region: 'cn-beijing' }), 'public');
  // Unknown values fall through instead of failing the request.
  assert.equal(await resolveEndpointMode({ env: { AGENTKIT_KS3_ENDPOINT_MODE: 'nonsense' }, region: 'cn-beijing', probe: async () => true }), 'public');
});

test('a private pool downloads through the internal variant without probing the public endpoint', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  let probes = 0;
  const result = await fetchKs3(PUBLIC, {}, {
    env: { AGENTENGINE_NETWORK_MODE: 'private' },
    probe: async () => { probes += 1; return true; },
    fetchImpl: okFetch(calls),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [INTERNAL]);
  assert.equal(probes, 0);
});

test('a transport failure retries the other variant and remembers the working one', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  let mode = 'public';
  const flaky = async url => {
    const target = String(url);
    calls.push(target);
    if (mode === 'public' && target.includes('ks3-cn-beijing.ksyuncs.com')) throw transportFailure();
    return response(200);
  };
  const options = { env: { AGENTENGINE_NETWORK_MODE: 'public' }, fetchImpl: flaky };
  assert.equal((await fetchKs3(PUBLIC, {}, options)).status, 200);
  assert.deepEqual(calls, [PUBLIC, INTERNAL]);
  // The endpoint that actually worked outranks the declared mode for the next object.
  assert.equal(await resolveEndpointMode({ env: { AGENTENGINE_NETWORK_MODE: 'public' }, region: 'cn-beijing', probe: async () => true }), 'internal');
  calls.length = 0;
  mode = 'internal-only';
  assert.equal((await fetchKs3(PUBLIC, {}, options)).status, 200);
  assert.deepEqual(calls, [INTERNAL]);
});

test('a transport failure on both variants reports every attempted host', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  const failing = async url => { calls.push(String(url)); throw transportFailure('ECONNREFUSED'); };
  await assert.rejects(fetchKs3(PUBLIC, {}, { env: { AGENTENGINE_NETWORK_MODE: 'private' }, fetchImpl: failing }), error => {
    assert.ok(error instanceof Ks3EndpointError);
    assert.equal(error.code, 'KS3_ENDPOINT_UNREACHABLE');
    assert.deepEqual(error.details.hosts, [
      'agentengine-cn-beijing-6-73398439-skills.ks3-cn-beijing.ksyuncs.com',
      'agentengine-cn-beijing-6-73398439-skills.ks3-cn-beijing-internal.ksyuncs.com',
    ]);
    assert.deepEqual(error.details.attempts.map(attempt => attempt.code), ['ECONNREFUSED', 'ECONNREFUSED']);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('an HTTP error is reachability, not a reason to retry another host', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  const forbidden = async url => { calls.push(String(url)); return response(403); };
  const result = await fetchKs3(PUBLIC, {}, { env: { AGENTENGINE_NETWORK_MODE: 'public' }, fetchImpl: forbidden });
  assert.equal(result.status, 403);
  assert.deepEqual(calls, [PUBLIC]);
});

test('non-KS3 URLs pass through untouched and are never rewritten or retried', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  const failing = async url => { calls.push(String(url)); throw transportFailure(); };
  const url = 'https://internal.example.test/frozen.zip';
  await assert.rejects(fetchKs3(url, {}, { env: {}, fetchImpl: failing }), error => {
    assert.equal(error.cause?.code, 'UND_ERR_CONNECT_TIMEOUT');
    return true;
  });
  assert.deepEqual(calls, [url]);
});

test('a caller-cancelled download stops after the first attempt', async () => {
  resetKs3EndpointCaches();
  const calls = [];
  const controller = new AbortController();
  const cancelled = async url => {
    calls.push(String(url));
    controller.abort();
    throw Object.assign(Object.create(null), { name: 'AbortError', code: 'ABORT_ERR' });
  };
  await assert.rejects(fetchKs3(PUBLIC, { signal: controller.signal }, { env: { AGENTENGINE_NETWORK_MODE: 'public' }, fetchImpl: cancelled }),
    error => error.name === 'AbortError');
  assert.equal(calls.length, 1);
});

test('transport classification covers undici connect failures without swallowing HTTP errors', () => {
  assert.equal(isKs3TransportError(transportFailure()), true);
  assert.equal(isKs3TransportError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isKs3TransportError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isKs3TransportError(Object.assign(new Error('bad zip'), { code: 'SKILL_ARCHIVE_INVALID' })), false);
  assert.equal(isKs3TransportError(null), false);
});
