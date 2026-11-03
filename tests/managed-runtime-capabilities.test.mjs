import test from 'node:test';
import assert from 'node:assert/strict';
import { managedRuntimeBootstrap } from '../src/managed-runtime-capabilities.mjs';

const runtime = {
  identity: { agentId: 'ar-capability', versionId: 'version-1', manifestSha256: 'a'.repeat(64), runtimeName: 'codex', runtimeVersion: '0.0.8' },
  declaration: { name: 'capability-proof' },
};
const executionPolicy = { format: 'agentkit.execution-policy/v1', permissionMode: 'workspace-write',
  approvalPolicy: 'never', approvalSource: 'runtime-policy' };
const allowedPermissionModes = ['read-only', 'workspace-write', 'danger-full-access'];

test('the capability payload declares the execution sandbox policy the Host enforces', () => {
  const bootstrap = managedRuntimeBootstrap(runtime, 'model-a', { executionPolicy, allowedPermissionModes });
  assert.deepEqual(bootstrap.ExecutionPolicy, executionPolicy);
  assert.deepEqual(bootstrap.allowedPermissionModes, allowedPermissionModes);
  // Approval stays a separate axis: the fixed risk-only policy is advertised,
  // and the execution tiers never reuse its values.
  assert.deepEqual(bootstrap.Capabilities.ApprovalPolicy, { Modes: ['ask', 'risk'], DefaultMode: 'risk', RuntimeOverride: true });
  assert.equal(bootstrap.ExecutionPolicy.permissionMode, 'workspace-write');
});

test('a Host without a declared policy never invents execution modes', () => {
  const bootstrap = managedRuntimeBootstrap(runtime, 'model-a');
  assert.equal(bootstrap.ExecutionPolicy, null);
  assert.deepEqual(bootstrap.allowedPermissionModes, []);
});
