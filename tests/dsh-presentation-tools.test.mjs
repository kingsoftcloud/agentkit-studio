import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshPresentationTools, codexPresentationBindings } from '../src/providers/dsh-presentation-tools.mjs';

const schema = { name: 'present', description: 'official file delivery', parameters: { files: { type: 'array', required: true } } };
for (const mode of ['native', 'ptc']) {
  test(`Codex reuses official present under ${mode} with the owning DSH Agent`, async () => {
    const calls = [], agent = { id: 'session', session: { header: { cwd: '/tmp/workspace' } } };
    const adapter = createDshPresentationTools({ tools: {
      schemas: owner => { assert.equal(owner, agent); return [schema]; }, modeFor: () => mode,
      execute: async call => { calls.push(call); return { content: [{ type: 'text', text: 'Presented result.svg' }] }; },
    } });
    const bindings = codexPresentationBindings(adapter, agent);
    assert.equal(bindings[0].name, 'dsh_present');
    assert.deepEqual(bindings[0].parameters, schema.parameters);
    const files = [{ path: 'result.svg', description: 'preview' }];
    await adapter.callPresentationTool('present', { files }, { agent, callId: 'actual-call' });
    assert.equal(calls[0].agent, agent);
    assert.equal(calls[0].callId, 'actual-call');
    assert.equal(calls[0].name, mode === 'ptc' ? 'run_code' : 'present');
    if (mode === 'ptc') assert.equal(calls[0].arguments.code, `return await tools.present(${JSON.stringify({ files })});`);
    else assert.deepEqual(calls[0].arguments, { files });
    await assert.rejects(adapter.callPresentationTool('bash', {}, { agent }), { code: 'TOOL_NOT_FOUND' });
  });
}
test('missing or failed official present cannot become a fabricated delivery', async () => {
  const missing = createDshPresentationTools({ tools: { schemas: () => [] } });
  assert.deepEqual(codexPresentationBindings(missing, {}), []);
  const failed = createDshPresentationTools({ tools: { schemas: () => [schema], modeFor: () => 'native', execute: async () => ({ isError: true, error: { code: 'FS_NOT_FOUND' } }) } });
  await assert.rejects(failed.callPresentationTool('present', { files: [{ path: 'missing.svg' }] }, { agent: {} }), { code: 'FS_NOT_FOUND' });
});
