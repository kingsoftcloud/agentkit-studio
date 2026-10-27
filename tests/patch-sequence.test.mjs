import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPatchSequence } from '../scripts/check-patch-sequence.mjs';

test('patch series exposes a contiguous canonical sequence without rewriting cryptographic legacy ids', async () => {
  const report = await checkPatchSequence();
  assert.equal(report.first, 1);
  assert.equal(report.last, report.count);
  assert.equal(report.count, 44);
});
