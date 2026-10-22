import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFiles, auditPath, auditText } from '../scripts/public-surface-audit.mjs';

const buffer = value => Buffer.from(value, 'utf8');

test('public surface audit rejects credential paths before reading their contents', async () => {
  const reads = [];
  const hits = await auditFiles(['profiles/credentials.json'], async file => {
    reads.push(file);
    return buffer('safe');
  });
  assert.ok(hits.every(hit=>hit.file==='profiles/credentials.json'&&hit.kind==='forbidden public path'));
  assert.ok(hits.length>0);
  assert.deepEqual(reads, []);
});

test('contributor instructions reject private markers and credentials', () => {
  assert.deepEqual(auditPath('AGENTS.md'), []);
  assert.deepEqual(auditPath('docs/contracts/runtime.md'), []);
  const marker = ['INTERNAL', '-ONLY'].join('');
  assert.ok(auditText('AGENTS.md', buffer(marker)).some(hit=>hit.kind==='private-classification-marker'));
  assert.ok(auditText('AGENTS.md', buffer(marker), {historical:true}).some(hit=>hit.kind==='private-classification-marker'));
  const personalPath = ['/Users', '/', 'historical-owner/workspace'].join('');
  for (const file of ['docs/acceptance.md', 'scripts/verify-dsh-node-store.mjs']) {
    assert.ok(auditText(file, buffer(personalPath), {historical:true}).some(hit=>hit.kind==='personal-absolute-path'));
  }
  const token = ['ghp_', '123456789012345678901234567890'].join('');
  assert.ok(auditText('AGENTS.md', buffer(marker+'\n'+token)).some(hit=>hit.kind==='github-token'));
  const fixture = ['https://user:', 'secret@example.com/'].join('');
  const production = ['https://user:', 'real-credential@production.test/'].join('');
  assert.equal(auditText('tests/example.test.mjs', buffer(fixture), {historical:true}).length, 0);
  assert.ok(auditText('tests/example.test.mjs', buffer(production), {historical:true}).length>0);
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
  const approvedInternalEndpoint = ['http://aicp.', ['inner.', 'api.ksyun.com'].join('')].join('');
  assert.equal(auditText('src/example.mjs', buffer(`const endpoint = "${approvedInternalEndpoint}";`)).length, 0);
  const unknownInternalEndpoint = ['http://unknown.', ['inner.', 'api.ksyun.com'].join('')].join('');
  assert.equal(auditText('src/example.mjs', buffer(`const endpoint = "${unknownInternalEndpoint}";`)).length, 1);
  assert.equal(auditText('src/example.mjs', buffer(`const endpoints = ["${approvedInternalEndpoint}", "${unknownInternalEndpoint}"];`)).length, 1);
  assert.equal(auditText('src/example.mjs', buffer('const fixture = "Authorization: Bearer private-test-token";')).length, 0);
});

test('public surface audit allows binary product assets while still checking their paths', () => {
  const binary = Buffer.from([0, 1, 2, 3, 4]);
  assert.deepEqual(auditText('assets/icon.png', binary), []);
});

test('historical synthetic test fixtures stay approved without loosening current files', () => {
  const loopbackFixture = ['http://10.0.', '0.7/'].join('');
  const internalFixture = ['http://metadata.', 'internal/'].join('');
  const credentialFixture = ['https://user:', 'pass@example.com/'].join('');
  assert.deepEqual(auditText('tests/assistant-permission-model.test.mjs', buffer(loopbackFixture), { historical: true }), []);
  assert.deepEqual(auditText('tests/assistant-permission-model.test.mjs', buffer(internalFixture), { historical: true }), []);
  assert.deepEqual(auditText('tests/assistant-permission-model.test.mjs', buffer(credentialFixture), { historical: true }), []);
  assert.ok(auditText('tests/assistant-permission-model.test.mjs', buffer(loopbackFixture)).length > 0);
  const otherPrivate = ['http://10.9.', '9.9/'].join('');
  assert.ok(auditText('tests/assistant-permission-model.test.mjs', buffer(otherPrivate), { historical: true }).length > 0);
  const otherInternal = ['http://leak.', 'internal/'].join('');
  assert.ok(auditText('tests/assistant-permission-model.test.mjs', buffer(otherInternal), { historical: true }).length > 0);
  const otherCredential = ['https://user:', 'real-secret@example.com/'].join('');
  assert.ok(auditText('tests/assistant-permission-model.test.mjs', buffer(otherCredential), { historical: true }).length > 0);
});
