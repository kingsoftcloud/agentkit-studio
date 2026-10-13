import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentStore } from '../src/agent-store.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createOperationManager } from '../src/studio-operations.mjs';
import { submitAgentBuild } from '../src/build-operation.mjs';
import { createZip, readZipFiles } from '../src/zip.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-build-revision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    localStore: createAgentStore({ storeDir: join(root, 'agents') }),
    build: createStudioBuild({ storeDir: root }),
    operations: createOperationManager({ storeDir: join(root, 'operations') }),
    serverClient: { getAgent: async () => { throw Error('must not query cloud for a local revision'); } },
  };
}
async function terminal(operations, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await operations.get(id);
    if (result && !['queued', 'running'].includes(result.status)) return result;
    await delay(10);
  }
  assert.fail('operation did not finish');
}

test('requested historical revision freezes its original prompt, model and bindings after later edits', async t => {
  const services = await setup(t);
  const first = await services.localStore.create({ name: 'Original', runtimeType: 'harness', spec: {
    instructions: { system: 'Answer using the original rule.' },
    bindings: { modelProfileId: 'original-model', mcpServers: [{ resourceId: 'original-mcp' }], skills: ['original-skill'] },
  } });
  const id = first.metadata.id;
  await services.localStore.update(id, { name: 'Edited', spec: { instructions: { system: 'A different rule.' }, bindings: { modelProfileId: 'new-model', skills: ['new-skill'] } } });
  const request = { ...services, payload: { agentId: id, revision: 1, idempotencyKey: 'old-revision' } };
  const admitted = await submitAgentBuild(request);
  const result = await terminal(services.operations, admitted.operationId);
  assert.equal(result.status, 'succeeded');
  const frozen = await services.build.resolve(id, result.result.buildId);
  assert.equal(frozen.metadata.name, 'Original');
  assert.equal(frozen.metadata.revision, 1);
  assert.deepEqual(frozen.spec, first.spec);
  assert.deepEqual(frozen.bindings, first.bindings);
  assert.equal((await submitAgentBuild(request)).buildId, result.result.buildId);
  await assert.rejects(submitAgentBuild({ ...request, payload: { ...request.payload, revision: 2 } }), { code: 'OPERATION_IDEMPOTENCY_CONFLICT' });
  assert.equal((await services.operations.list()).length, 1);
});

test('invalid, missing and unavailable revisions never enqueue a misleading build', async t => {
  const services = await setup(t);
  const agent = await services.localStore.create({ name: 'Valid', spec: { instructions: { system: 'rule' } } });
  for (const revision of [0, -1, 1.2, '1', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(submitAgentBuild({ ...services, payload: { agentId: agent.metadata.id, revision } }), { code: 'BUILD_REVISION_INVALID' });
  }
  await assert.rejects(submitAgentBuild({ ...services, payload: { agentId: agent.metadata.id, revision: 9 } }), { code: 'BUILD_REVISION_NOT_FOUND' });
  await assert.rejects(submitAgentBuild({ ...services, payload: { agentId: 'ar-local-0000000000000000', revision: 1 } }), { code: 'AGENT_NOT_FOUND' });
  const serverClient = { getAgent: async () => ({ metadata: { id: 'cloud-agent', revision: 3 }, spec: { instructions: { system: 'current' } } }) };
  await assert.rejects(submitAgentBuild({ ...services, serverClient, payload: { agentId: 'cloud-agent', revision: 2 } }), { code: 'BUILD_REVISION_UNAVAILABLE' });
  assert.equal((await services.operations.list()).length, 0);
  const accepted = await submitAgentBuild({ ...services, serverClient, payload: { agentId: 'cloud-agent', revision: 3 } });
  assert.equal((await terminal(services.operations, accepted.operationId)).status, 'succeeded');
});

test('concurrent duplicate requests start once; cross-agent reuse of a key fails', async t => {
  const { operations } = await setup(t);
  let executions = 0;
  const input = { kind: 'build', resourceId: 'one', idempotencyKey: 'same-key', requestFingerprint: 'same-content', runner: async () => { executions++; return { buildId: 'one-build' }; } };
  const admitted = await Promise.all(Array.from({ length: 12 }, () => operations.submit(input)));
  assert.equal(new Set(admitted.map(item => item.id)).size, 1);
  assert.equal((await terminal(operations, admitted[0].id)).status, 'succeeded');
  assert.equal(executions, 1);
  await assert.rejects(operations.submit({ ...input, resourceId: 'two' }), { code: 'OPERATION_IDEMPOTENCY_CONFLICT' });
});

test('canceling a queued operation prevents the runner and side effects', async t => {
  const { operations } = await setup(t);
  let executions = 0;
  const submitted = await operations.submit({ kind: 'build', resourceId: 'one', idempotencyKey: 'cancel-before-start', runner: async () => { executions++; } });
  assert.equal((await operations.cancel(submitted.id)).status, 'cancelled');
  await delay(100);
  assert.equal(executions, 0);
  assert.equal((await operations.get(submitted.id)).status, 'cancelled');
  assert.equal((await operations.events(submitted.id)).some(event => event.type === 'operation.started'), false);
});

test('same-agent concurrent builds preserve every history entry and freeze inputs at admission', async t => {
  const { build } = await setup(t);
  const input = { agentId: 'parallel', revision: 1, spec: { prompt: 'before' } };
  const first = build.build(input);
  input.spec.prompt = 'after';
  const records = await Promise.all([first, ...Array.from({ length: 7 }, (_, index) => build.build({ agentId: 'parallel', revision: index + 2, spec: { prompt: `rule-${index}` } }))]);
  assert.equal((await build.list('parallel')).length, 8);
  assert.equal((await build.resolve('parallel', records[0].id)).spec.prompt, 'before');
  for (const record of records) assert.equal((await build.resolve('parallel', record.id)).metadata.revision, record.revision);
});

test('valid-CRC spec tampering and corrupt repeated builds are rejected without overwriting evidence', async t => {
  const { build } = await setup(t);
  const input = { agentId: 'verified', revision: 1, spec: { prompt: 'frozen' } };
  const record = await build.build(input);
  const path = await build.artifactPath(input.agentId, record.id);
  const entries = readZipFiles(await readFile(path));
  const changed = createZip(entries.map(entry => entry.name.endsWith('/spec.json') ? { ...entry, data: JSON.stringify({ spec: { prompt: 'injected' }, bindings: {} }) } : entry));
  await writeFile(path, changed);
  await assert.rejects(build.download(input.agentId, record.id), { code: 'BUILD_ARTIFACT_INVALID' });
  await assert.rejects(build.build(input), { code: 'BUILD_ARTIFACT_INVALID' });
  assert.deepEqual(await readFile(path), changed);
});

test('started work keeps its actual outcome instead of being relabeled cancelled', async t => {
  const { operations } = await setup(t);
  let release, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const work = new Promise(resolve => { release = resolve; });
  const admitted = await operations.submit({ kind: 'build', resourceId: 'one', runner: async () => { notifyStarted(); await work; return { buildId: 'published' }; } });
  // The production host keeps the event loop alive; this isolated fixture has
  // no host socket and the operation's background timer is intentionally unref'd.
  const deadline = new AbortController();
  try {
    await Promise.race([started, delay(2_000, null, { signal: deadline.signal }).then(() => assert.fail('operation runner did not start'))]);
    await assert.rejects(operations.cancel(admitted.id), { code: 'OPERATION_ALREADY_STARTED' });
  } finally { deadline.abort(); release(); }
  assert.equal((await terminal(operations, admitted.id)).status, 'succeeded');
});
