import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRemote } from '../src/client/remote/host-client.mjs';
test('a real FormData file reaches the Host as its content and filename', async () => {
  let sent;
  const remote = createHostRemote({ rpc: { call: async (_channel, endpoint, payload) => { sent = { endpoint, payload }; return { ok: true, value: { id: 'evalset-test' } }; } } }, { window: { location: { origin: 'http://localhost', hash: '' } } });
  const form = new FormData(); form.append('file', new Blob(['cases:\n - input: test']), 'acceptance.yaml');
  const result = await remote.importEvaluationFile(form);
  assert.deepEqual(sent, { endpoint: 'evaluations/import', payload: { content: 'cases:\n - input: test', fileName: 'acceptance.yaml' } });
  assert.equal(result.id, 'evalset-test');
});
