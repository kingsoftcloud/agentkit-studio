import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudExecutionModes } from '../src/cloud-execution-modes.mjs';

const agentId = 'ar-20261022185032-07197e24';

test('the selected execution mode is durable, scoped to one cloud Agent and validated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentkit-cloud-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCloudExecutionModes({ directory });
  assert.equal(await store.get(agentId), null);
  assert.equal(await store.set(agentId, 'workspace-write'), 'workspace-write');
  assert.equal(await store.get(agentId), 'workspace-write');
  await assert.rejects(store.set(agentId, 'unconfined'), { code: 'CLOUD_EXECUTION_MODE_INVALID' });
  await assert.rejects(store.set('ar-local-test', 'read-only'), { code: 'CLOUD_AGENT_ID_INVALID' });
  const reopened = createCloudExecutionModes({ directory });
  assert.equal(await reopened.get(agentId), 'workspace-write');
  assert.equal(await reopened.get('ar-other'), null);
  const file = JSON.parse(await readFile(join(directory, 'cloud-execution-modes.json'), 'utf8'));
  assert.equal(file.format, 'agentkit.cloud-execution-modes/v1');
  assert.deepEqual(file.modes, { [agentId]: 'workspace-write' });
  assert.equal(await reopened.clear(agentId), true);
  assert.equal(await createCloudExecutionModes({ directory }).get(agentId), null);
});

test('corrupt or unknown records are ignored instead of granting a mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentkit-cloud-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'cloud-execution-modes.json'), JSON.stringify({ format: 'agentkit.cloud-execution-modes/v1',
    modes: { [agentId]: 'danger-full-access', 'ar-future': 'unconfined', 'ar-local-test': 'read-only' } }));
  const store = createCloudExecutionModes({ directory });
  assert.equal(await store.get(agentId), 'danger-full-access');
  assert.equal(await store.get('ar-future'), null);
  assert.equal(await store.get('ar-local-test'), null);
  await writeFile(join(directory, 'cloud-execution-modes.json'), '{not json');
  assert.equal(await createCloudExecutionModes({ directory }).get(agentId), null);
});
