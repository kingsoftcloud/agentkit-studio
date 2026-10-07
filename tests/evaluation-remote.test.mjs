import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/client-fragments/01-loader-and-primitives.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('importEvaluationFile: ') + 'importEvaluationFile: '.length, source.indexOf('        tracesOverview:')).trim().replace(/,$/, '');
test('a real FormData file reaches the Host as its content and filename', async () => {
  let sent;
  const upload = new Function('directServer', 'studioBridgeOperation', 'request', `return (${body});`)(() => true, async (endpoint, payload) => { sent = { endpoint, payload }; return { id: 'evalset-test' }; }, () => {});
  const form = new FormData(); form.append('file', new Blob(['cases:\n - input: test']), 'acceptance.yaml');
  const result = await upload(form);
  assert.deepEqual(sent, { endpoint: 'evaluations/import', payload: { content: 'cases:\n - input: test', fileName: 'acceptance.yaml' } });
  assert.equal(result.id, 'evalset-test');
});
