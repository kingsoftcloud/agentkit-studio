import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexModelCatalog, codexModelSelection, CODEX_PROVIDER } from '../src/providers/codex-models.mjs';

test('Codex catalog uses actual RPC models and configured default with bounded pagination', async () => {
  const calls = []; let killed = false;
  const catalog = createCodexModelCatalog({ spawnImpl: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(String(chunk)); calls.push(message);
      const result = message.method === 'config/read' ? { config: { models: { new_thread: { model: 'model-b' } } } }
        : message.method === 'model/list' ? { data: [{ id: message.params.cursor ? 'model-b' : 'model-a', model: message.params.cursor ? 'model-b' : 'model-a', displayName: 'Real model', isDefault: true }], nextCursor: message.params.cursor ? null : 'page-2' } : {};
      if (message.id) child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
      callback();
    } });
    child.kill = () => { killed = true; child.stdout.end(); child.emit('exit', 0); }; return child;
  } });
  const result = await catalog.list();
  assert.deepEqual(result.items.map(row => row.resourceId), ['model-a', 'model-b']);
  assert.equal(result.defaultModel, 'model-b'); assert.equal(killed, true);
  assert.equal(calls.filter(call => call.method === 'model/list').length, 2);
  assert.deepEqual(codexModelSelection({ spec: { bindings: {} } }, result), { provider: CODEX_PROVIDER, model: 'model-b' });
  assert.deepEqual(codexModelSelection({ spec: { bindings: { modelProfileId: 'model-a', modelProfileIds: ['model-b', 'model-a'] } } }, result), { provider: CODEX_PROVIDER, model: 'model-a' });
  assert.throws(() => codexModelSelection({ spec: { bindings: { modelProfileId: 'gateway-only' } } }, result), { code: 'CODEX_MODEL_UNAVAILABLE' });
  await catalog.list(); assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
});

test('missing Codex binary fails with a typed error without a gateway fallback', async () => {
  const catalog = createCodexModelCatalog({ spawnImpl: () => { throw new Error('missing'); } });
  await assert.rejects(catalog.list(), { code: 'CODEX_PROVIDER_UNAVAILABLE' });
});
