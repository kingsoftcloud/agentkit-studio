import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, tool, digest } from '../../agentkit-harness-core/test/fixtures.mjs';
import { createNativeArtifactStore } from '../src/native/artifact-store.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

// A test Host forwards its one admitted export tool to the real ArtifactPort.
// Production overflow scheduling and ArtifactRead authorization are separate work.
for (const missingReceipt of [false, true]) test(`artifact publication ${missingReceipt ? 'without' : 'with'} a tool receipt survives SQLite reopen without another effect`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-artifact-kernel-')), filename = join(directory, 'ledger.sqlite');
  let store = new SqliteRunStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let artifacts = await createNativeArtifactStore({ directory: join(directory, 'host-state'), scope });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'export', readOnly: false, concurrentSafe: false })] });
  store.create(config, snapshot);
  let modelCalls = 0, writes = 0, lostDelivery = false, ref;
  const content = '\uFEFFExported 原文 😀\n';
  const ports = () => ({ artifacts, model: { generate: async () => ++modelCalls === 1
    ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'export-call', name: 'export', arguments: {} }] }
    : { kind: 'final_candidate', text: 'Export completed', usage: emptyUsage(), toolCalls: [] } },
  tools: { execute: async request => {
    assert.equal(store.load(scope, 'run').intents.find(intent => intent.operationKey === request.operationKey)?.status, 'running');
    writes++;
    ref = await artifacts.write({ ...request, content, mediaType: 'text/plain', metadata: { source: 'export' } });
    if (missingReceipt) throw Error('Connection lost after artifact publication');
    return { status: 'ok', content: { artifact: ref }, artifactRefs: [ref] };
  } } });
  const first = new NativeKernel({ store, digest, owner: 'first', ports: ports(), onCheckpoint: async current => {
    if (!missingReceipt && !lostDelivery && current.artifactRefs.length) {
      lostDelivery = true; throw Error('Session disconnected after committed tool receipt');
    }
  } });
  if (missingReceipt) assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'interrupted');
  else await assert.rejects(first.runUntilIdle(scope, 'run'), /Session disconnected/);
  const before = store.load(scope, 'run');
  assert.equal(before.snapshot.artifactRefs.length, missingReceipt ? 0 : 1);
  assert.equal(before.receipts.find(receipt => receipt.result.results)?.result.results[0].status, missingReceipt ? 'uncertain' : 'ok');
  store.close(); store = new SqliteRunStore(filename);
  artifacts = await createNativeArtifactStore({ directory: join(directory, 'host-state'), scope });
  const replacement = new NativeKernel({ store, digest, owner: 'replacement', ports: ports() });
  const result = await replacement.runUntilIdle(scope, 'run');
  assert.equal(result.phase, missingReceipt ? 'interrupted' : 'completed');
  assert.equal(writes, 1); assert.equal(modelCalls, missingReceipt ? 1 : 2);
  assert.equal(await artifacts.usageBytes({ scope, runId: 'run' }), Buffer.byteLength(content, 'utf8'));
  const request = { ...snapshot, operationKey: 'inspect', signal: new AbortController().signal, ref, offset: 0, limit: 32000 };
  assert.deepEqual(await artifacts.read(request), { content, nextOffset: null });
  await assert.rejects(artifacts.read({ ...request, scope: { ...scope, agentId: 'foreign' } }), /artifact_scope_mismatch/);
  if (!missingReceipt) {
    assert.deepEqual(result.artifactRefs, [ref]);
    const next = fixture({ contract: { objective: 'Continue' }, tools: config.tools }).config;
    const followUp = replacement.start({ ...snapshot, runId: 'follow-up', turnId: '2', parentRunId: null }, next);
    assert.deepEqual(followUp.artifactRefs, [ref]);
  } else {
    // A stored artifact alone cannot turn an unknown export into acknowledged success.
    assert.equal(result.artifactRefs.length, 0); assert.equal(result.reason, 'effect_outcome_unknown');
  }
});
