import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationManager } from '../src/studio-operations.mjs';
import { createZip, buildIdFor } from '../src/zip.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';

async function makeStore() {
  return mkdtemp(join(tmpdir(), 'agentkit-studio-ops-'));
}

test('operations run to completion, persist records, and dedupe by idempotency key', async () => {
  const store = await makeStore();
  const manager = createOperationManager({ storeDir: store });
  await manager.ready;
  const first = await manager.submit({
    kind: 'build', resourceId: 'agent-1', idempotencyKey: 'build-agent-1-1',
    runner: async () => ({ buildId: 'build_x', summary: 'build_x' }),
  });
  assert.equal(first.status, 'queued');
  const duplicate = await manager.submit({
    kind: 'build', resourceId: 'agent-1', idempotencyKey: 'build-agent-1-1',
    runner: async () => { throw new Error('must not rerun'); },
  });
  assert.equal(duplicate.id, first.id);
  for (let i = 0; i < 40 && ['queued', 'running'].includes((await manager.get(first.id))?.status); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const done = await manager.get(first.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.buildId, 'build_x');
  const listed = await manager.list({ resourceId: 'agent-1' });
  assert.equal(listed.length, 1);
  // A fresh manager instance reads the same persisted records (durable state).
  const reopened = createOperationManager({ storeDir: store });
  await reopened.ready;
  assert.equal((await reopened.get(first.id)).status, 'succeeded');
  await rm(store, { recursive: true, force: true }).catch(() => {});
});

test('failed runners persist the failure and cancel marks a queued operation', async () => {
  const store = await makeStore();
  const manager = createOperationManager({ storeDir: store });
  await manager.ready;
  const failing = await manager.submit({ kind: 'build', resourceId: 'a', idempotencyKey: 'f-1', runner: async () => { throw new Error('boom'); } });
  const cancellable = await manager.submit({ kind: 'build', resourceId: 'a', idempotencyKey: 'c-1', runner: async () => 'never' });
  const cancelled = await manager.cancel(cancellable.id);
  assert.equal(cancelled.status, 'cancelled');
  // Poll until the terminal state lands: leaving `queued` only means the
  // claim phase wrote `running` — the finish write races this read.
  let failed = null;
  for (let i = 0; i < 200; i++) {
    failed = await manager.get(failing.id);
    if (failed?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(failed?.status, 'failed');
  const events = await manager.events(failing.id);
  assert.ok(events.some(event => event.type === 'operation.failed'));
  await rm(store, { recursive: true, force: true }).catch(() => {});
});

test('zip archive is readable and build produces a stable content-addressed bundle', async () => {
  const zip = createZip([
    { name: 'agent-bundle/manifest.json', data: '{"format":"agentkit.agent-bundle/v1"}' },
    { name: 'agent-bundle/README.md', data: 'hello' },
  ]);
  // Local file header + central directory signatures.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) > 0);
  const manifestText = '{"format":"agentkit.agent-bundle/v1"}';
  assert.ok(zip.includes(Buffer.from(manifestText)), 'manifest content present in archive');

  const store = await makeStore();
  const build = createStudioBuild({ storeDir: store });
  const input = { agentId: 'ar-1', agentName: 'A', revision: 2, spec: { runtime: { type: 'dsh-native' } }, bindings: {} };
  const first = await build.build(input);
  const second = await build.build(input);
  assert.equal(first.id, second.id);
  assert.match(first.id, /^build_[0-9a-f]{20}$/);
  assert.equal(first.status, 'SUCCEEDED');
  const artifact = await readFile(await build.artifactPath('ar-1', first.id));
  assert.equal(artifact.readUInt32LE(0), 0x04034b50);
  const listed = await build.list('ar-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, first.id);
  await rm(store, { recursive: true, force: true }).catch(() => {});
});

test('build id changes when the definition changes', () => {
  const a = buildIdFor({ agentId: 'x', revision: 1 });
  const b = buildIdFor({ agentId: 'x', revision: 2 });
  assert.notEqual(a, b);
});

test('a successful local build resolves to its frozen agent definition', async () => {
  const store = await makeStore();
  const build = createStudioBuild({ storeDir: store });
  const input = {
    agentId: 'ar-local-aaaaaaaaaaaaaaaa', agentName: 'Frozen', revision: 7,
    spec: { runtime: { type: 'harness' }, instructions: { system: 'old prompt' } },
    bindings: { mcpServers: [{ resourceId: 'mcp-old' }] },
    metadata: { local: true },
  };
  const record = await build.build(input);
  const frozen = await build.resolve(input.agentId, record.id);
  assert.equal(frozen.buildId, record.id);
  assert.equal(frozen.metadata.local, true);
  assert.equal(frozen.metadata.revision, 7);
  assert.equal(frozen.spec.instructions.system, 'old prompt');
  assert.deepEqual(frozen.bindings, input.bindings);
  await assert.rejects(build.resolve(input.agentId, 'build_00000000000000000000'), error => error.code === 'BUILD_NOT_FOUND');
  await rm(store, { recursive: true, force: true }).catch(() => {});
});
