import test from 'node:test';
import assert from 'node:assert/strict';
import { frozenModels } from '../src/frozen-models.mjs';
test('frozen model keys retain unique provider routes and omit disabled credentials', () => {
  const models = frozenModels([{ id: 'provider-a', modelName: 'shared', default: true, credentialName: 'private-a' },
    { id: 'provider-b', modelName: 'shared', credentialName: 'private-b' }, { id: 'unique', modelName: 'unique-model' },
    { id: 'disabled', modelName: 'other', enabled: false }]);
  assert.deepEqual(models.map(item => item.id), ['provider-a', 'provider-b', 'unique-model']);
  assert.equal(models[0].default, true); assert.equal(models[2].profileId, 'unique');
  assert.doesNotMatch(JSON.stringify(models), /private/);
});
