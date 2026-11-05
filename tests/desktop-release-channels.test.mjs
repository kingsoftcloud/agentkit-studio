import test from 'node:test'
import assert from 'node:assert/strict'
import { assertReleaseChannel, channelMetadataFilename, DEFAULT_RELEASE_CHANNEL, isNativeReleaseChannel, isReleaseChannel,
  LEGACY_RELEASE_CHANNELS, NATIVE_RELEASE_CHANNELS, RELEASE_CHANNELS, windowsChannelMetadataFilename } from '../src/desktop-release-channels.mjs'

test('the DSH-native lanes lead the channels the release tools understand', () => {
  assert.deepEqual([...NATIVE_RELEASE_CHANNELS], ['nightly', 'latest'])
  assert.deepEqual([...LEGACY_RELEASE_CHANNELS], ['preview', 'stable'])
  assert.deepEqual([...RELEASE_CHANNELS], ['nightly', 'latest', 'preview', 'stable'])
  assert.equal(DEFAULT_RELEASE_CHANNEL, 'nightly')
})

test('channel metadata filenames follow the lane on macOS and Windows', () => {
  assert.equal(channelMetadataFilename('latest'), 'latest-mac.yml')
  assert.equal(channelMetadataFilename('nightly'), 'nightly-mac.yml')
  assert.equal(channelMetadataFilename('preview'), 'preview-mac.yml')
  assert.equal(channelMetadataFilename('stable'), 'stable-mac.yml')
  assert.equal(windowsChannelMetadataFilename('latest'), 'latest.yml')
  assert.equal(windowsChannelMetadataFilename('nightly'), 'nightly.yml')
})

test('one channel selector accepts exactly the four lanes and normalises whitespace', () => {
  for (const channel of ['nightly', 'latest', 'preview', 'stable']) {
    assert.equal(assertReleaseChannel(channel), channel)
    assert.equal(assertReleaseChannel(` ${channel} `), channel)
    assert.equal(isReleaseChannel(channel), true)
    assert.equal(isNativeReleaseChannel(channel), channel === 'nightly' || channel === 'latest')
  }
  for (const channel of ['beta', 'canary', 'LATEST', 'latest beta']) {
    assert.throws(() => assertReleaseChannel(channel), /channel must be one of nightly, latest, preview, stable/, channel)
    assert.equal(isReleaseChannel(channel), false)
  }
  for (const channel of ['', '   ', undefined, null, 7]) {
    assert.throws(() => assertReleaseChannel(channel), /channel is required/, String(channel))
    assert.equal(isReleaseChannel(channel), false)
  }
})

test('callers can label the rejected input so operators see which flag failed', () => {
  assert.throws(() => assertReleaseChannel('beta', '--from-channel'), /--from-channel must be one of nightly, latest, preview, stable/)
})
