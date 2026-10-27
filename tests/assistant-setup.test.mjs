import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantSetup } from '../src/assistant-setup.mjs';
import { sha256 } from '../src/portable-resources.mjs';

const credentials = { cloudAccessKey: 'synthetic-access', cloudSecretKey: 'synthetic-secret', cloudRegion: 'pre-online' };
const scopeOf = values => sha256(JSON.stringify([values.cloudServerUrl || '', values.cloudRegion || '', values.cloudCustomSource || '', values.cloudAccessKey]));

async function fixture(t, values = credentials) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-lineage-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const storeDir = join(root, 'setup');
  return { storeDir, values, service: createAssistantSetup({ storeDir, configuration: { resolve: async () => ({ values }) } }) };
}

async function writeReceipt(storeDir, values, record) {
  await mkdir(storeDir, { recursive: true });
  const scope = scopeOf(values);
  await writeFile(join(storeDir, `${scope}.json`), JSON.stringify({ format: 'agentkit.assistant-setup/v1', scope, ...record }));
  return scope;
}

test('missing cloud credentials yield no lineage instead of failing catalog reads', async t => {
  const { service } = await fixture(t, {});
  assert.equal(await service.reference(), null);
});

test('a missing receipt yields no lineage', async t => {
  const { service } = await fixture(t);
  assert.equal(await service.reference(), null);
});

test('an existing receipt resolves the local Agent to its verified cloud deployment', async t => {
  const { service, storeDir, values } = await fixture(t);
  await writeReceipt(storeDir, values, { agentId: 'agent-local', cloudAgentId: 'ar-cloud', deploymentId: 'dep_cloud', state: 'READY' });
  assert.deepEqual(await service.reference(), { agentId: 'agent-local', cloudAgentId: 'ar-cloud', deploymentId: 'dep_cloud' });
});

test('another credential scope never inherits a different account receipt', async t => {
  const { service, storeDir, values } = await fixture(t);
  await writeReceipt(storeDir, { ...values, cloudAccessKey: 'another-account' }, { agentId: 'agent-local', cloudAgentId: 'ar-cloud', deploymentId: 'dep_cloud' });
  assert.equal(await service.reference(), null);
});

test('a corrupt receipt is reported instead of silently dropping the deployment link', async t => {
  const { service, storeDir, values } = await fixture(t);
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${scopeOf(values)}.json`), JSON.stringify({ format: 'agentkit.assistant-setup/v0' }));
  await assert.rejects(service.reference(), { code: 'ASSISTANT_SETUP_CORRUPT' });
});
