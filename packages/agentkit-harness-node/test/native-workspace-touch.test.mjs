import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeKernel, emptyUsage, projectWorkspaceTouchEvidence } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { nativeInstructionTouches } from '../src/native/instruction-context.mjs';
import { fixture, tool, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';

function measuredRead(action) {
  const prepare = DatabaseSync.prototype.prepare;let bytes = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = Reflect.apply(prepare, this, args);
    return new Proxy(statement, { get(target, name) {
      const method = Reflect.get(target, name, target);
      if (typeof method !== 'function') return method;
      return (...parameters) => {
        const value = Reflect.apply(method, target, parameters);
        if (['all', 'get'].includes(name)) for (const row of Array.isArray(value) ? value : [value])
          if (row) for (const item of Object.values(row)) if (typeof item === 'string') bytes += Buffer.byteLength(item);
        return value;
      };
    } });
  };
  try { return { value: action(), get bytes() { return bytes; } }; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

test('actual input preparation reads committed workspace facts independently of the presentation cache and raw tool bodies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-workspace-touch-')), file = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(file);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const { config, snapshot } = fixture({ tools: [tool({ name: 'write_workspace_files', readOnly: false, concurrentSafe: false })] });
  const target = join(root, 'nested/AGENTS.md');let models = 0, writes = 0, checked = false;
  const input = { prepare: async () => {
    const full = store.load(scope, 'run'), expected = projectWorkspaceTouchEvidence(full);
    const original = store.load;store.load = () => { throw Error('Input preparation must not reconstruct complete historical results'); };
    let evidence, readBytes;
    try { const read = measuredRead(() => store.workspaceTouchEvidence(scope, 'run'));evidence = read.value;readBytes = read.bytes; }
    finally { store.load = original; }
    assert.deepEqual(evidence, expected);
    const options = { sessionId: snapshot.sessionId, builtinNames: new Set(['write_workspace_files']),
      workspaceToolNames: new Set(['write_workspace_files']), workspace: root };
    if (models === 1) {
      checked = true;assert.deepEqual(nativeInstructionTouches(evidence, options), [target]);
      assert.ok(readBytes < 16384, `Input refresh must not read its 2 MiB raw tool body into Node: ${readBytes}`);
      assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_ARCHIVED_BODY|PRIVATE_WRITE_METADATA/);
      const db = new DatabaseSync(file);
      try {
        const saved = db.prepare("SELECT item_key,data FROM native_delivery_items WHERE collection='events'").all();
        db.exec("UPDATE native_delivery_items SET data=json_set(data,'$.payload.content.path','forged/AGENTS.md') WHERE collection='events'");
        assert.deepEqual(store.workspaceTouchEvidence(scope, 'run'), evidence, 'Display data cannot become instruction evidence');
        for (const row of saved) db.prepare("UPDATE native_delivery_items SET data=? WHERE collection='events' AND item_key=?").run(row.data, row.item_key);
      } finally { db.close(); }
      assert.throws(() => nativeInstructionTouches(evidence, { ...options, sessionId: 'foreign' }), /session_mismatch/);
    }
    return { status: 'admitted', messages: [] };
  } };
  const kernel = new NativeKernel({ store, digest, owner: 'workspace-touch', ports: { input,
    model: { generate: async () => ++models === 1
      ? { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'write', name: 'write_workspace_files', arguments: {} }], usage: emptyUsage() }
      : { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() } },
    tools: { execute: async () => {
      writes++;mkdirSync(join(root, 'nested'), { recursive: true });writeFileSync(target, 'Scoped instructions');
      return { status: 'ok', content: { path: 9, written: [{ path: 'nested/AGENTS.md', private: 'PRIVATE_WRITE_METADATA' }, null, 'invalid', { path: 9 }],
        changed_paths: ['other.ts', 9, null], raw: 'PRIVATE_ARCHIVED_BODY' + 'x'.repeat(2 * 1024 * 1024) },
      context: { content: 'Wrote nested/AGENTS.md.' } };
    } },
  } });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');assert.equal(checked, true);
  assert.equal(writes, 1);assert.equal(readFileSync(target, 'utf8'), 'Scoped instructions');
  const expected = store.workspaceTouchEvidence(scope, 'run');assert.deepEqual(expected.observations, []);
  store.close();store = new SqliteRunStore(file);
  assert.deepEqual(store.workspaceTouchEvidence(scope, 'run'), expected);assert.equal(writes, 1);
  assert.throws(() => store.workspaceTouchEvidence({ ...scope, agentId: 'foreign' }, 'run'), { code: 'run_not_found' });
});
