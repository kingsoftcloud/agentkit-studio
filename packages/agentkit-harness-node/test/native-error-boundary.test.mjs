import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as source from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';

// Resolve from the Studio consumer, not this package's development workspace
// link, which intentionally points back to source and would erase the boundary.
const consumer = createRequire(new URL('../../../package.json', import.meta.url));
const installed = await import(pathToFileURL(consumer.resolve('@kingsoftcloud/agentkit-harness-core')));
const { SqliteRunStore } = await import(pathToFileURL(consumer.resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')));

test('public error recognition supports two actual Core installations without constructor equality', () => {
  assert.notEqual(source.NativeError, installed.NativeError);
  assert.equal(source.isNativeError(new installed.NativeError('run_not_found')), true);
  assert.equal(installed.isNativeError(new source.NativeError('run_not_found')), true);
});

test('source Kernel and installed SQLite start, settle, reopen and retain one committed write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-package-boundary-')), file = join(root, 'runs.sqlite'), output = join(root, 'writes.txt');
  let store = new SqliteRunStore(file), models = 0, executions = 0;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
  const ports = {
    model: { generate: async () => ++models === 1
      ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }], usage: source.emptyUsage() }
      : { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: source.emptyUsage() } },
    tools: { execute: async () => { executions++; appendFileSync(output, 'written\n'); return { status: 'ok', content: 'Written.' }; } },
  };
  const kernel = new source.NativeKernel({ store, digest, owner: 'source', ports });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const original = store.load(scope, 'run');store.close();store = null;
  store = new SqliteRunStore(file);
  const restored = new source.NativeKernel({ store, digest, owner: 'reopened', ports });
  assert.equal(restored.start(snapshot, config).phase, 'completed');
  assert.equal((await restored.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(models, 2);assert.equal(executions, 1);assert.equal(readFileSync(output, 'utf8'), 'written\n');
  assert.deepEqual(store.load(scope, 'run').receipts, original.receipts);
});

test('installed Kernel accepts a source Store but refuses an ordinary lookalike missing-run exception', () => {
  const { config, snapshot } = fixture();
  const store = new source.MemoryRunStore();
  const kernel = new installed.NativeKernel({ store, digest, owner: 'installed', ports: {} });
  assert.equal(kernel.start(snapshot, config).phase, 'created');
  const untrusted = Object.assign(new Error('private'), { name: 'NativeError', code: 'run_not_found' });
  const invalid = new installed.NativeKernel({ store: { load() { throw untrusted; } }, digest, owner: 'invalid', ports: {} });
  assert.throws(() => invalid.start(snapshot, config), error => error === untrusted);
});

test('a foreign typed error after a write stays unknown across SQLite reopen and cannot replay the effect', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-package-unknown-')), file = join(root, 'runs.sqlite'), output = join(root, 'writes.txt');
  let store = new SqliteRunStore(file), executions = 0, models = 0;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false })] });
  const ports = { model: { generate: async () => { models++; return { kind: 'tool_calls', text: '', usage: source.emptyUsage(),
    toolCalls: [{ callId: 'write-1', name: 'write', arguments: {} }] }; } },
    tools: { execute: async () => { executions++;appendFileSync(output, 'written\n');throw new installed.NativeError('PRIVATE_ERROR_CODE'); } } };
  const kernel = new source.NativeKernel({ store, digest, owner: 'source-unknown', ports });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).reason, 'effect_outcome_unknown');
  const original = store.load(scope, 'run');
  assert.equal(original.events.find(event => event.kind === 'tool.failure_observed')?.payload.cause, 'native_error');
  assert.doesNotMatch(JSON.stringify(original), /PRIVATE_ERROR_CODE/);
  store.close();store = null;store = new SqliteRunStore(file);
  const restored = new source.NativeKernel({ store, digest, owner: 'reopened-unknown', ports });
  assert.equal((await restored.runUntilIdle(scope, 'run')).reason, 'effect_outcome_unknown');
  assert.equal(executions, 1);assert.equal(models, 1);assert.equal(readFileSync(output, 'utf8'), 'written\n');
  assert.deepEqual(store.load(scope, 'run').receipts, original.receipts);
});
