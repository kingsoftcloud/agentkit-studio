import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesToolExecutionContract } from '../dist/index.mjs';
const owner = { name: 'read_public_page', description: 'Read a public page.', parameters: { type: 'object', additionalProperties: false },
  readOnly: true, concurrentSafe: true, permissions: [], timeoutMs: 60000 };
test('I/O protocol matching separates validated Host policy without changing the original definition', () => {
  const admitted = { ...structuredClone(owner), approvalPolicy: 'durable-preflight/v1', executionTimeoutPolicy: 'dispatch/v2',
    modelGuidance: ['Use the admitted schema.'] };
  assert.equal(matchesToolExecutionContract(admitted, owner), true);
  assert.equal(matchesToolExecutionContract(admitted, { ...owner, recoveryPolicy: 'safe-read/v1' }), true);
  assert.equal(matchesToolExecutionContract(owner, { ...owner, recoveryPolicy: 'skip-validation' }), false);
  assert.equal(admitted.approvalPolicy, 'durable-preflight/v1');
  for (const patch of [{ readOnly: false }, { permissions: ['network:any'] }, { timeoutMs: 1 },
    { parameters: { type: 'object' } }, { undeclaredPolicy: true }, { approvalPolicy: 'skip' }])
    assert.equal(matchesToolExecutionContract({ ...admitted, ...patch }, owner), false);
});
