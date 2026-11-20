import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRAFFIC_SOURCE,
  TRAFFIC_SOURCE_HEADER,
  buildCloudHeaders,
  resolveTrafficSource,
} from '../src/cloud-headers.mjs';

/**
 * Source attribution must be one header with one value on every outbound call.
 *
 * The Python SDK (`ksadk/common/cloud_headers.py`) already behaves this way, so
 * these assertions mirror its contract: an explicit value wins, then
 * `KSADK_TRAFFIC_SOURCE`, then `agentkit`; a caller-supplied header of the same
 * name is dropped rather than duplicated.
 */

function withEnv(value, run) {
  const previous = process.env.KSADK_TRAFFIC_SOURCE;
  if (value === undefined) delete process.env.KSADK_TRAFFIC_SOURCE;
  else process.env.KSADK_TRAFFIC_SOURCE = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.KSADK_TRAFFIC_SOURCE;
    else process.env.KSADK_TRAFFIC_SOURCE = previous;
  }
}

test('the default source is the documented product tag', () => {
  assert.equal(DEFAULT_TRAFFIC_SOURCE, 'agentkit');
  assert.equal(TRAFFIC_SOURCE_HEADER, 'X-Traffic-Source');
  withEnv(undefined, () => assert.equal(resolveTrafficSource(), 'agentkit'));
});

test('an explicit value wins over the environment', () => {
  withEnv('from-env', () => {
    assert.equal(resolveTrafficSource('explicit'), 'explicit');
    assert.equal(resolveTrafficSource(), 'from-env');
  });
});

test('blank environment values fall back to the default', () => {
  withEnv('   ', () => assert.equal(resolveTrafficSource(), 'agentkit'));
});

test('non-printable characters are refused before they reach a header', () => {
  // A CR/LF in a header value is header injection, not a naming preference.
  for (const value of ['agentkit\r\nX-Injected: 1', 'agent\nkit', 'agent\tkit', '星流']) {
    assert.throws(() => resolveTrafficSource(value), error => error.code === 'TRAFFIC_SOURCE_INVALID', value);
  }
});

test('a caller-supplied header is replaced, not duplicated', () => {
  const headers = buildCloudHeaders({ 'content-type': 'application/json', 'x-traffic-source': 'spoofed' });
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers[TRAFFIC_SOURCE_HEADER], 'agentkit');
  assert.equal(Object.keys(headers).filter(name => name.toLowerCase() === 'x-traffic-source').length, 1);
});

test('UE-style casing variants are all dropped', () => {
  const headers = buildCloudHeaders({ 'X-TRAFFIC-SOURCE': 'a', 'X-Traffic-Source': 'b', 'x-Traffic-Source': 'c' });
  assert.deepEqual(Object.keys(headers), [TRAFFIC_SOURCE_HEADER]);
  assert.equal(headers[TRAFFIC_SOURCE_HEADER], 'agentkit');
});

test('buildCloudHeaders keeps unrelated headers intact', () => {
  const headers = buildCloudHeaders({ Authorization: 'Bearer t', 'X-Ksc-Request-Id': 'r1' }, 'custom');
  assert.deepEqual(headers, {
    Authorization: 'Bearer t',
    'X-Ksc-Request-Id': 'r1',
    [TRAFFIC_SOURCE_HEADER]: 'custom',
  });
});

test('buildCloudHeaders works without an input map', () => {
  assert.deepEqual(buildCloudHeaders(null), { [TRAFFIC_SOURCE_HEADER]: 'agentkit' });
  assert.deepEqual(buildCloudHeaders(undefined, 'x'), { [TRAFFIC_SOURCE_HEADER]: 'x' });
});
