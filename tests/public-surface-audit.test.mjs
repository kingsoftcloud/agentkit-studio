import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFiles, auditPath, auditText } from '../scripts/public-surface-audit.mjs';

const buffer = value => Buffer.from(value, 'utf8');

test('public surface audit rejects internal paths before reading their contents', async () => {
  const reads = [];
  const hits = await auditFiles(['docs/contracts/internal.md'], async file => {
    reads.push(file);
    return buffer('safe');
  });
  assert.deepEqual(hits, [{ file: 'docs/contracts/internal.md', kind: 'forbidden public path' }]);
  assert.deepEqual(reads, []);
});

test('public surface audit allows a tracked file deleted from the working tree', async () => {
  const hits = await auditFiles(['tests/removed.test.mjs'], async () => null);
  assert.deepEqual(hits, []);
});

test('public surface audit scans every tracked text file for high-confidence private material', () => {
  assert.deepEqual(auditPath('src/credentials.mjs'), []);
  const token = ['ghp_', '123456789012345678901234567890'].join('');
  assert.equal(auditText('src/example.mjs', buffer(`const token = "${token}";`)).length, 1);
  assert.equal(auditText('src/example.mjs', buffer('const endpoint = "https://example.com";')).length, 0);
  const privateEndpoint = ['http://10.10.', '2.4:8080'].join('');
  assert.equal(auditText('src/example.mjs', buffer(`const endpoint = "${privateEndpoint}";`)).length, 1);
  const internalEndpoint = ['http://aicp.', 'inner.api.ksyun.com'].join('');
  assert.equal(auditText('src/example.mjs', buffer(`const endpoint = "${internalEndpoint}";`)).length, 1);
  assert.equal(auditText('src/example.mjs', buffer('const fixture = "Authorization: Bearer private-test-token";')).length, 0);
});

test('public surface audit allows binary product assets while still checking their paths', () => {
  const binary = Buffer.from([0, 1, 2, 3, 4]);
  assert.deepEqual(auditText('assets/icon.png', binary), []);
});
