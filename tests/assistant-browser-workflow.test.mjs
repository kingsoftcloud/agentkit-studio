import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const workflow = parse(source);
const steps = workflow.jobs['patched-host'].steps;

test('assistant browser acceptance runs on pull requests without publication credentials', () => {
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(source, /secrets\.|workflow_dispatch|continue-on-error|gh release/);
  assert.deepEqual(workflow.jobs['patched-host'].strategy.matrix.os, ['ubuntu-latest']);
});

test('browser gate reuses the installed maintained Host and preserves automatic startup coverage', () => {
  const startup = steps.findIndex(step => step.name === 'Verify normal installed assistant cold startup and restart');
  const chromium = steps.findIndex(step => step.name === 'Install Chromium for assistant acceptance');
  const browser = steps.findIndex(step => step.name === 'Verify native assistant surfaces in the browser');
  assert.ok(startup >= 0 && chromium > startup && browser > chromium);
  assert.match(steps[startup].run, /verify-assistant-automatic-startup\.mjs/);
  assert.equal(steps[chromium].run, 'pnpm exec playwright install --with-deps chromium');
  assert.deepEqual(steps[browser].env, { STUDIO_VERIFY_UI: '1', STUDIO_VERIFY_PROFILE: 'automatic-startup' });
  for (const home of ['DSH_HOME', 'AGENTKIT_HOME', 'CODEX_HOME']) {
    assert.match(steps[browser].run, new RegExp(`export ${home}="\\$RUNNER_TEMP/assistant-automatic-startup/`));
  }
  assert.match(steps[browser].run, /patched-host-acceptance\.json/);
  assert.match(steps[browser].run, /chromium\.executablePath\(\)/);
  assert.match(steps[browser].run, /node scripts\/verify-personal-assistant-host\.mjs \.artifacts\/assistant-native-web\/assistant\.json/);
  assert.doesNotMatch(steps[browser].run, /--no-sandbox|disable-web-security|\|\| true/);
});

test('browser reports and screenshots remain available when acceptance fails', () => {
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()');
  assert.match(upload.with.path, /\.artifacts\/assistant-native-web\//);
  assert.match(upload.with.path, /\.artifacts\/assistant-automatic-startup\.json/);
  assert.equal(upload.with['retention-days'], 7);
});
