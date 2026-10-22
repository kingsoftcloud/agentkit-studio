import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopReleaseUploads } from '../src/desktop-release-uploads.mjs'

const STORAGE = 'https://agentkit.ks3-cn-beijing.ksyuncs.com'
const FEED = 'https://feed.ks3-cn-beijing.ksyuncs.com'
const base = {
  expectedBase: 'deepseek-harness-0.2.1-rc.2.20261022.12-mac-arm64',
  selectedChannel: 'preview',
  storageOrigin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com',
  feedOrigin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com',
}
const plan = {
  assets: {
    dmg: 'studio/0.2.1-rc.2.20261022.12/AgentKit-Studio-mac-arm64.dmg',
    zip: 'studio/0.2.1-rc.2.20261022.12/AgentKit-Studio-mac-arm64.zip',
    blockmap: 'studio/0.2.1-rc.2.20261022.12/AgentKit-Studio-mac-arm64.zip.blockmap',
  },
  releaseKey: 'studio/feeds/mac-arm64/mac-arm64-release.json',
  feedKey: 'studio/feeds/mac-arm64/preview-mac.yml',
}

test('the Studio layout never writes the legacy dsh-desk prefix', () => {
  const uploads = desktopReleaseUploads({ ...base, plan })
  assert.equal(uploads.length, 5)
  assert.deepEqual(uploads.map(upload => upload[1]), [
    plan.assets.dmg,
    plan.assets.zip,
    plan.assets.blockmap,
    plan.releaseKey,
    plan.feedKey,
  ])
  assert.ok(uploads.every(upload => !upload[1].startsWith('dsh-desk/')), 'no legacy object may be uploaded')
})

test('the Studio layout writes the canonical feed only to the requested origin', () => {
  const uploads = desktopReleaseUploads({ ...base, plan, storageOrigin: STORAGE, feedOrigin: FEED })
  const feeds = uploads.filter(upload => upload[0] === 'preview-mac.yml')
  assert.deepEqual(feeds.map(upload => [upload[3], upload[1]]), [
    [STORAGE, plan.feedKey],
    [FEED, plan.feedKey],
  ])
})

test('the explicit compatibility origin keeps the legacy feed for old installed builds', () => {
  const compatibility = 'https://compat.example.com'
  const uploads = desktopReleaseUploads({ ...base, plan, compatibilityOrigin: compatibility })
  const legacy = uploads.filter(upload => upload[1].startsWith('dsh-desk/feeds/mac-arm64/'))
  assert.deepEqual(new Set(legacy.map(upload => upload[3])), new Set([STORAGE, compatibility]))
})

test('the legacy layout keeps publishing the dsh-desk bin and feed', () => {
  const uploads = desktopReleaseUploads({ ...base })
  assert.deepEqual(uploads.map(upload => upload[1]), [
    `dsh-desk/bin/mac-arm64/${base.expectedBase}.dmg`,
    `dsh-desk/bin/mac-arm64/${base.expectedBase}.zip`,
    `dsh-desk/bin/mac-arm64/${base.expectedBase}.zip.blockmap`,
    'dsh-desk/feeds/mac-arm64/mac-arm64-release.json',
    'dsh-desk/feeds/mac-arm64/preview-mac.yml',
  ])
})
