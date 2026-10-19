import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHostDependencyLifecycleReport, HOST_DEPENDENCY_LIFECYCLE_CHECKS } from '../scripts/verification/host-dependency-lifecycle-report.mjs';

const complete = () => ({ evidence: 'real-cordis-dependency-scopes-controlled-http-runtime', passed: true,
  checks: HOST_DEPENDENCY_LIFECYCLE_CHECKS.map(name => ({ name, passed: true })) });
const incomplete = report => assert.throws(() => assertHostDependencyLifecycleReport(report), { code: 'PATCHED_HOST_LIFECYCLE_INCOMPLETE' });

test('patched Host gate requires all eleven named lifecycle proofs, independently of order', () => {
  assert.equal(HOST_DEPENDENCY_LIFECYCLE_CHECKS.length, 11);
  const report = complete();
  assert.equal(assertHostDependencyLifecycleReport(report), report);
  report.checks.reverse();
  assert.equal(assertHostDependencyLifecycleReport(report), report);
  for (const name of HOST_DEPENDENCY_LIFECYCLE_CHECKS) {
    incomplete({ ...complete(), checks: complete().checks.filter(check => check.name !== name) });
  }
});

test('legacy four/six-check reports, duplicate names and unrelated proofs cannot satisfy the gate', () => {
  incomplete({ ...complete(), checks: complete().checks.slice(0, 6) });
  incomplete({ ...complete(), checks: complete().checks.slice(0, 6).filter(check => !check.name.includes('permission-preset')) });
  const duplicate = complete(); duplicate.checks[0] = { ...duplicate.checks[1] }; incomplete(duplicate);
  const unknown = complete(); unknown.checks[0].name = 'unrelated-success'; incomplete(unknown);
  const extra = complete(); extra.checks.push({ name: 'extra-success', passed: true }); incomplete(extra);
});

test('partial, failed and malformed lifecycle reports fail closed even with eleven entries', () => {
  for (const report of [undefined, null, {}, { ...complete(), evidence: 'fixture-only' }, { ...complete(), passed: false },
    { ...complete(), passed: 'true' }, { ...complete(), failure: { code: 'cleanup-failed' } }, { ...complete(), checks: null }]) incomplete(report);
  for (const value of [false, undefined, 'true']) {
    const report = complete(); report.checks[0].passed = value; incomplete(report);
  }
  const malformed = complete(); malformed.checks[0] = null; incomplete(malformed);
});
