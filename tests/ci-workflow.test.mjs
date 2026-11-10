import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

test('CI produces the required checks for merge-queue entries', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  // The merge queue validates a gh-readonly-queue ref. A pull_request-only CI
  // workflow can never produce the required checks there, so the entry waits forever.
  assert.ok('merge_group' in workflow.on, 'ci.yml must declare the merge_group event');
  assert.equal(workflow.jobs.test.name, 'public-gate');
  assert.equal(workflow.jobs['patched-host'].name, 'patched-dsh-host');
});
