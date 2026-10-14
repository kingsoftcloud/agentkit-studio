import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedDesktopMetadata, studioDesktopPublication, studioWindowsPublication } from '../src/desktop-release-metadata.mjs';

test('generated ZIP links resolve to public binary objects without changing signed byte metadata', () => {
  const version = '0.2.0-rc.2.20261013.2';
  const file = { url: `deepseek-harness-${version}-mac-arm64.zip`, size: 123, sha512: 'signed-digest' };
  const metadata = { version, path: file.url, files: [file], sha512: file.sha512 };
  const result = publishedDesktopMetadata(metadata, version);
  const feed = 'https://ksadk.ks3-cn-beijing.ksyuncs.com/dsh-desk/feeds/mac-arm64/preview-mac.yml';
  assert.equal(new URL(result.files[0].url, feed).pathname, `/dsh-desk/bin/mac-arm64/${file.url}`);
  assert.equal(result.path, result.files[0].url);
  assert.equal(result.sha512, metadata.sha512);
  assert.deepEqual({ ...result.files[0], url: file.url }, file);
  assert.equal(metadata.path, file.url, 'original CI artifact is preserved');
});

test('Studio version directories preserve signed bytes and the official old blockmap lookup', () => {
  const version = '0.2.0-rc.2.20261013.13', old = '0.2.0-rc.2.20261013.12';
  const metadata = { version, files: [{ url: `deepseek-harness-${version}-mac-arm64.zip`, sha512: 'signed', size: 123 }] };
  const plan = studioDesktopPublication(metadata, { origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com' });
  assert.equal(plan.assets.dmg, `studio/${version}/AgentKit-Studio-mac-arm64.dmg`);
  assert.equal(plan.metadata.files[0].url.replace(version, old) + '.blockmap', `https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/${old}/AgentKit-Studio-mac-arm64.zip.blockmap`);
  assert.equal(plan.metadata.files[0].sha512, 'signed');
  const full = studioDesktopPublication(metadata, { origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com', mode: 'full' });
  assert.equal(full.metadata.agentkitUpdateMode, 'full');
  assert.notEqual(new URL(full.metadata.files[0].url).pathname.slice(1) + '.blockmap', full.assets.blockmap, 'full-only ZIP has no blockmap; normal blockmap remains available for the next incremental release');
});

test('publication refuses metadata for a different signed version', () => {
  assert.throws(() => publishedDesktopMetadata({ version: '1.0.0', files: [{ url: 'wrong.zip' }] }, '1.0.1'), /signed ZIP/);
});

test('Windows feed preserves signed installer metadata and gives the installed legacy client a bridge', () => {
  const version = '0.2.0-rc.2.20261014.8', sha512 = Buffer.alloc(64, 42).toString('base64');
  const metadata = { version, path: `deepseek-harness-${version}-win-x64.exe`, sha512,
    files: [{ url: `deepseek-harness-${version}-win-x64.exe`, size: 400000000, sha512 }] };
  const plan = studioWindowsPublication(metadata, { origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com' });
  assert.equal(plan.feedKey, 'studio/feeds/win-x64/preview.yml');
  assert.equal(plan.bridgeFeedKey, 'dsh-desk/feeds/win-x64/preview.yml');
  assert.equal(plan.metadata.files[0].sha512, sha512);
  assert.equal(plan.metadata.files[0].size, metadata.files[0].size);
  assert.equal(plan.metadata.files[0].url, `https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/${version}/AgentKit-Studio-win-x64.exe`);
  assert.throws(() => studioWindowsPublication({ ...metadata, version: '1.0.0' }, { origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com' }), /signed installer/);
});
