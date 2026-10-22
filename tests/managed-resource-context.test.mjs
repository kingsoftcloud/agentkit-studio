import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedResourceContext } from '../src/managed-resource-context.mjs';

const runtime = { identity: { agentId: 'ar-test', versionId: 'version-test', manifestSha256: 'a'.repeat(64) },
  declaration: { resources: { memory: { id: 'mem-test' } } } };
const expires = Math.floor(Date.now() / 1000) + 60;
function grant(subject) {
  return `drp1.${Buffer.from(JSON.stringify({ format: 'agentengine.dsh-memory-permit/v1', agent_id: 'ar-test',
    version_id: 'version-test', manifest_sha256: 'a'.repeat(64), memory_id: 'mem-test',
    subject_digest: subject, expires_at: expires })).toString('base64url')}.${'f'.repeat(64)}`;
}

test('parallel requests retain separate ephemeral permits and reject detached work', async () => {
  const context = createManagedResourceContext(runtime);
  assert.throws(() => context.permit(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  const subjects = ['b'.repeat(64), 'c'.repeat(64)];
  const delayed = [];
  await Promise.all(subjects.map(async subjectDigest => context.run({
    headers: { 'x-agentengine-resource-permit': grant(subjectDigest) }, subjectDigest,
  }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(context.permit(), grant(subjectDigest));
    delayed.push(new Promise(resolve => setTimeout(() => {
      assert.throws(() => context.permit(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' }); resolve();
    }, 15)));
  })));
  await Promise.all(delayed);
  assert.throws(() => context.permit(), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  assert.equal(JSON.stringify(process.env).includes('drp1.'), false);
});

test('missing, mismatched and aborted contexts never execute resource work', async () => {
  const context = createManagedResourceContext(runtime), subjectDigest = 'b'.repeat(64);
  let executed = 0;
  const invoke = () => { executed++; };
  for (const headers of [{}, { 'x-agentengine-resource-permit': grant('c'.repeat(64)) },
    { 'x-agentengine-resource-permit': 'forged' }]) {
    await assert.rejects(context.run({ headers, subjectDigest }, invoke), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(context.run({ headers: { 'x-agentengine-resource-permit': grant(subjectDigest) },
    subjectDigest, signal: abort.signal }, invoke), { code: 'MANAGED_RESOURCE_PERMIT_REQUIRED' });
  assert.equal(executed, 0);
});

test('runtimes without memory retain their existing execution path', async () => {
  const context = createManagedResourceContext({ ...runtime, declaration: { resources: {} } });
  assert.equal(await context.run({}, () => 'unchanged'), 'unchanged');
});
