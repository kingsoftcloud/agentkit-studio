/** The composed Agent preset decides whether bash runs in the background. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { logPresetComposition } from '../src/host/bootstrap.mjs';

const capture = () => {
  const lines = [];
  const original = console.info;
  console.info = (...args) => lines.push(args);
  return { lines, restore: () => { console.info = original; } };
};

const composition = lines => JSON.parse(String(lines.at(-1).at(-1)));

test('reports the bash tool and job service the preset actually composed', () => {
  const { lines, restore } = capture();
  try {
    logPresetComposition({ get: name => (name === 'jobs' ? { start: () => {} } : undefined) },
      [{ name: '@deepseek-ai/dsh-tool-bash' }, { name: '@deepseek-ai/dsh-tool-jobs' }, { name: '@deepseek-ai/dsh-tool-fs' }]);
    const report = composition(lines);
    assert.equal(report.requested, 'standard');
    assert.equal(report.pluginCount, 3);
    assert.deepEqual(report.bashTools, ['@deepseek-ai/dsh-tool-bash']);
    assert.equal(report.jobsService, true);
    assert.equal(report.backgroundPromotion, true);
  } finally { restore(); }
});

test('reports a degraded PTY composition so a timeout names the real tool', () => {
  const { lines, restore } = capture();
  try {
    logPresetComposition({ get: () => undefined },
      [{ name: '@deepseek-ai/dsh-terminal-bash' }, { name: '@deepseek-ai/dsh-tool-bash-persistent' }]);
    const report = composition(lines);
    assert.deepEqual(report.bashTools, ['@deepseek-ai/dsh-terminal-bash', '@deepseek-ai/dsh-tool-bash-persistent']);
    assert.equal(report.jobsService, false);
    assert.equal(report.backgroundPromotion, false);
  } finally { restore(); }
});

test('a failing probe never fails the preset', () => {
  const warnings = [];
  const originalInfo = console.info, originalWarn = console.warn;
  console.info = () => {};
  console.warn = (...args) => warnings.push(args);
  try {
    // A context without the service is the normal degraded case: report it,
    // never warn, and never propagate.
    assert.doesNotThrow(() => logPresetComposition({ get() { throw new Error('no context'); } }, []));
    assert.equal(warnings.length, 0);
  } finally { console.info = originalInfo; console.warn = originalWarn; }
});

test('tolerates a non-array plugin list', () => {
  const { lines, restore } = capture();
  try {
    assert.doesNotThrow(() => logPresetComposition({ get: () => undefined }, undefined));
    assert.equal(composition(lines).pluginCount, 0);
  } finally { restore(); }
});
