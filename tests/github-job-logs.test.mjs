import test from 'node:test';
import assert from 'node:assert/strict';
import { readGitHubJobLogs } from '../scripts/github-job-logs.mjs';

const path = 'repos/example/studio/actions/jobs/123/logs';
const raw = '\u001b[32mSTUDIO_REF_VALUE: abc123\u001b[0m\nBUILD_VERSION: 0.2.1-rc.2\n';
const clean = 'STUDIO_REF_VALUE: abc123\nBUILD_VERSION: 0.2.1-rc.2\n';

test('modern gh logs are stripped before candidate identity parsing without a retry', async () => {
  const calls = [];
  const logs = await readGitHubJobLogs(async (_file, args) => {
    calls.push(args);
    return { stdout: raw };
  }, path);
  assert.equal(logs, clean);
  assert.deepEqual(calls, [['api', '--allow-escape-sequences', path]]);
});

test('legacy gh retries only the unsupported output flag and still strips control characters', async () => {
  const calls = [];
  const logs = await readGitHubJobLogs(async (_file, args) => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(new Error('unsupported flag'), { stderr: 'unknown flag: --allow-escape-sequences\n' });
    return { stdout: raw };
  }, path);
  assert.equal(logs, clean);
  assert.deepEqual(calls, [['api', '--allow-escape-sequences', path], ['api', path]]);
});

test('authentication, network and API errors never enter the legacy retry path', async () => {
  for (const message of ['HTTP 403', 'HTTP 404', 'connection timed out']) {
    let calls = 0;
    const error = Object.assign(new Error(message), { stderr: message });
    await assert.rejects(readGitHubJobLogs(async () => { calls++; throw error; }, path), error);
    assert.equal(calls, 1);
  }
});

test('a legacy retry failure remains a terminal error', async () => {
  let calls = 0;
  const denied = new Error('HTTP 403');
  await assert.rejects(readGitHubJobLogs(async () => {
    if (++calls === 1) throw Object.assign(new Error('unsupported flag'), { stderr: 'unknown flag: --allow-escape-sequences' });
    throw denied;
  }, path), denied);
  assert.equal(calls, 2);
});
