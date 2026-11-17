import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryPartitionV2, memorySubjectRefV2, resolveMemorySubject } from '../src/memory-identity.mjs';

test('memory v2 vector matches Server contract', () => {
  const subjectRef = memorySubjectRefV2({
    domain: 'cloud', identityNamespace: 'kscloud-iam', tenantId: '1234567890',
    resourceAccountId: '1234567890', subjectType: 'user', subjectId: 'user-uuid-0001',
  });
  assert.equal(subjectRef, 'aeu_c36aa5cba663b1a16fbb7dad207132f693553d0ca8767c4e1b089ea94efe0d43');
  assert.equal(memoryPartitionV2({ collectionId: 'mem-abc123', agentId: 'xw-test', scope: '1234567890', subjectRef }),
    'mp1-c101faf3891929df05f0eddbc9e8ce4096d69bf0534a82884d2647e859cc');
});

test('local v2 resolves a profile-scoped subject and rejects agent sharing', () => {
  const subject = resolveMemorySubject({ contract: { partition_version: 'v2', subject_policy: 'per-user' }, domain: 'local', profileId: 'prof-001' });
  assert.equal(subject.subjectRef, 'lcl_c7546c09f4ff917aeba124477f54f32654bf0284f625f8c1c198683e0999dc62');
  assert.throws(() => resolveMemorySubject({ contract: { partition_version: 'v2', subject_policy: 'agent' }, domain: 'local', profileId: 'prof-001' }),
    error => error.code === 'MEMORY_BINDING_INVALID');
});
