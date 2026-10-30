import test from 'node:test';
import assert from 'node:assert/strict';
import { childCommandResource, validChildCommandResource } from '../src/native/child-command-resource.mjs';
import { bindNativeLocalExecution } from '../src/native/local-execution-profile.mjs';

test('child command resources bind the actual execution profile without copying environment values or granting tools', () => {
  const first = bindNativeLocalExecution({ sourceEnv: { PATH: '/usr/bin:/bin', PRIVATE_VALUE: 'never serialize this' },
    modern: true, resourceProfile: 'local-development/v1' });
  const resource = childCommandResource(first.binding);
  assert.equal(validChildCommandResource(resource), true); assert.equal(Object.isFrozen(resource), true);
  assert.equal(Object.hasOwn(resource, 'tools'), false);
  assert.doesNotMatch(JSON.stringify(resource), /never serialize this|PRIVATE_VALUE|\/usr\/bin/);
  const changed = childCommandResource({ ...first.binding, environmentDigest: '0'.repeat(64) });
  assert.notEqual(changed.bindingDigest, resource.bindingDigest);
  assert.equal(childCommandResource(null), null);
  assert.equal(childCommandResource({ backend: 'e2b' }), null);
  assert.throws(() => childCommandResource({ ...first.binding, controls: { contract: 'wrong' } }), /child_command_binding_invalid/);
  assert.equal(validChildCommandResource({ ...resource, tools: ['run_command'] }), false);
});
