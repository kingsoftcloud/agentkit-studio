import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildRoutes } from '../src/host/routes/builds.mjs';

const route = portableBundles => payload => createBuildRoutes({ studioBuildPromise: Promise.resolve({}), portableBundles })('builds/export-portable', payload);

test('export rejection obeys DSH Connection failure contract and does not expose raw upstream errors', async () => {
  for (const error of [Object.assign(new Error('请选择网关模型'), { code: 'PORTABLE_CODEX_MODEL_UNAVAILABLE' }), new Error('upstream private diagnostic')]) {
    const result = await route({ prepare: async () => { throw error; } })({ agentId: 'agent', buildId: 'build' });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, 'string');
    assert.equal(typeof result.error.message, 'string');
    assert.deepEqual(result.error.details, {});
    assert.equal(result.error.message.includes('private diagnostic'), false);
    if (error.code) assert.equal(result.error.message, error.message);
  }
});
