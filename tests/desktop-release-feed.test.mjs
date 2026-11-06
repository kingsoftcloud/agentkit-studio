import test from 'node:test'
import assert from 'node:assert/strict'
import YAML from 'yaml'
import { verifyMirroredFeed } from '../src/desktop-release-feed.mjs'

const storage = 'https://agentkit.ks3-cn-beijing.ksyuncs.com'
const version = '0.2.2-rc.1.20261105.1'
const feed = (overrides = {}) => YAML.stringify({
  version,
  files: [{ url: `${storage}/studio/${version}/AgentKit-Studio-mac-arm64.zip`, sha512: 'signed', size: 123 }],
  ...overrides,
})

test('a mirrored Studio feed keeps exactly the immutable binary it names', () => {
  const result = verifyMirroredFeed(Buffer.from(feed()), { expectedVersion: version, storageOrigin: storage })
  assert.equal(result.version, version)
  assert.equal(result.binaryUrl, `${storage}/studio/${version}/AgentKit-Studio-mac-arm64.zip`)
  assert.equal(result.size, 123)
  assert.equal(result.sha512, 'signed')
  const yaml = `version: ${version}\nfiles:\n  - url: ${storage}/studio/${version}/AgentKit-Studio-mac-arm64.zip\n    sha512: signed\n    size: 123\n`
  assert.deepEqual(verifyMirroredFeed(yaml, { expectedVersion: version, storageOrigin: storage }), result)
})

test('mirroring rejects a feed that changed version or left the Studio storage', () => {
  assert.throws(() => verifyMirroredFeed(feed({ version: '0.2.2-rc.1.20261105.0' }), { expectedVersion: version, storageOrigin: storage }),
    /does not equal/)
  assert.throws(() => verifyMirroredFeed(feed({ files: [{ url: 'https://elsewhere.example.com/studio/x.zip', sha512: 's', size: 1 }] }),
    { expectedVersion: version, storageOrigin: storage }), /escapes the release storage/)
  assert.throws(() => verifyMirroredFeed(feed({ files: [{ url: `${storage}/dsh-desk/bin/x.zip`, sha512: 's', size: 1 }] }),
    { expectedVersion: version, storageOrigin: storage }), /escapes the release storage/)
  assert.throws(() => verifyMirroredFeed(feed({ files: [{ url: `http://agentkit.ks3-cn-beijing.ksyuncs.com/studio/${version}/x.zip`, sha512: 's', size: 1 }] }),
    { expectedVersion: version, storageOrigin: storage }), /escapes the release storage/)
})

test('mirroring rejects incomplete digests, relative URLs and unknown layouts', () => {
  for (const files of [[], [{ url: `${storage}/studio/${version}/x.zip`, size: 10 }],
    [{ url: `${storage}/studio/${version}/x.zip`, sha512: 's' }],
    [{ url: `${storage}/studio/${version}/x.zip`, sha512: 's', size: 0 }],
    [{ url: 'x.zip', sha512: 's', size: 1 }]]) {
    assert.throws(() => verifyMirroredFeed(feed({ files }), { expectedVersion: version, storageOrigin: storage }),
      /does not describe one immutable binary|not absolute/)
  }
  assert.throws(() => verifyMirroredFeed(feed(), { expectedVersion: version, storageOrigin: storage, layout: 'other' }), /studio or legacy/)
  assert.throws(() => verifyMirroredFeed('not: [valid', { expectedVersion: version, storageOrigin: storage }), /source feed is invalid/)
})

test('the legacy layout only accepts the dsh-desk binary prefix', () => {
  const legacy = YAML.stringify({ version, files: [{ url: `${storage}/dsh-desk/bin/mac-arm64/deepseek-harness-${version}-mac-arm64.zip`, sha512: 's', size: 9 }] })
  assert.equal(verifyMirroredFeed(legacy, { expectedVersion: version, storageOrigin: storage, layout: 'legacy' }).size, 9)
  assert.throws(() => verifyMirroredFeed(feed(), { expectedVersion: version, storageOrigin: storage, layout: 'legacy' }), /escapes the release storage/)
})
