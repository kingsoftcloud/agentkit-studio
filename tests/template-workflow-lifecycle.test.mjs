import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTemplateWorkflows } from '../src/template-workflows.mjs';

test('Host teardown aborts an active template job and refuses new work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-template-lifetime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let signal;
  const workflows = createTemplateWorkflows({ directory, summon: options => new Promise((resolve, reject) => {
    signal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  await workflows.start({ requestId: 'lifetime-fixture-0001' });
  await Promise.resolve();
  await workflows.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(workflows.start({ requestId: 'lifetime-fixture-0002' }), { code: 'TEMPLATE_SERVICE_CLOSED' });
  assert.equal((await workflows.status({ requestId: 'lifetime-fixture-0001' })).status, 'cancelled');
  await workflows.close();
});
