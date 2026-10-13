import test from 'node:test';
import assert from 'node:assert/strict';
import { publishedDesktopMetadata } from '../src/desktop-release-metadata.mjs';

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

test('publication refuses metadata for a different signed version', () => {
  assert.throws(() => publishedDesktopMetadata({ version: '1.0.0', files: [{ url: 'wrong.zip' }] }, '1.0.1'), /signed ZIP/);
});
