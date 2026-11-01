import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeMcpSchema, NATIVE_MCP_SCHEMA_CONTRACT, snapshotNativeMcpSchema, snapshotNativeMcpPlanAccess, bindNativeMcpPlanAccess } from '../src/providers/native-mcp-schema.mjs';
import { compileToolInput } from '@kingsoftcloud/agentkit-harness-core';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
const integer = 9007199254740993n;
const schema = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: integer, maximum: integer } } };

test('MCP Plan admission follows the pinned explicit-true destructive default and freezes its own fact', () => {
  for (const annotations of [undefined, {}, { readOnlyHint: false }, { destructiveHint: false }, { destructiveHint: true, readOnlyHint: true }]) {
    const descriptor = { annotations }; const snapshot = snapshotNativeMcpPlanAccess(descriptor);
    assert.equal(snapshot.destructive, annotations?.destructiveHint === true);
    const bound = bindNativeMcpPlanAccess(JSON.parse(JSON.stringify(snapshot)));
    snapshot.destructive = !snapshot.destructive; assert.notEqual(bound.destructive, snapshot.destructive);
  }
  for (const value of [{}, { contract: 'zcode-mcp-plan/v1', destructive: 'false' },
    { contract: 'zcode-mcp-plan/v1', destructive: false, readOnly: true }]) assert.throws(() => bindNativeMcpPlanAccess(value));
});

test('Native MCP schemas survive JSON plugin configuration without numeric conversion', () => {
  const original = snapshotNativeMcpSchema({ inputSchema: schema, outputSchema: schema });
  const configured = JSON.parse(JSON.stringify(original));
  assert.deepEqual(configured, original);
  const bound = bindNativeMcpSchema(configured);
  assert.equal(bound.input.properties.id.minimum, integer);
  const validate = compileToolInput(bound.input);
  assert.equal(validate({ id: integer }), true);
  assert.equal(validate({ id: integer - 1n }), false);
  assert.equal(validate({ id: integer + 1n }), false);
  assert.equal(bound.validateOutput({ id: integer }).valid, true);
  assert.equal(bound.validateOutput({ id: integer - 1n }).valid, false);
  assert.equal(bound.registryParameters['x-agentkit-native-input-schema-json'], original.inputJson);
  assert.deepEqual(JSON.parse(JSON.stringify(bound.registryParameters)), bound.registryParameters);
});
test('ordinary Native schemas keep their DSH presentation and metadata cannot disable validation', () => {
  const safe = { type: 'object', required: ['value'], properties: { value: { type: 'string' } } };
  const snapshot = snapshotNativeMcpSchema({ inputSchema: safe });
  const bound = bindNativeMcpSchema(snapshot);
  assert.deepEqual(bound.registryParameters, safe); assert.equal(bound.validateOutput, null);
  for (const bad of [
    { ...snapshot, contract: 'unknown' }, { ...snapshot, inputJson: '{}' , outputJson: 'null' },
    { ...snapshot, inputJson: '{"type":"object","type":"integer"}' },
    { ...snapshot, inputJson: '{"$ref":"https://external.test/schema"}' },
  ]) assert.throws(() => bindNativeMcpSchema(bad));
});
test('an encoded Native MCP schema cannot fall back to the default DSH engine', () => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) assert.throws(() => applyPreset({}, {
    agentId: 'schema', runtime, local: true,
    toolContracts: [{ name: 'exact', executor: 'mcp', nativeMcpSchema: { contract: NATIVE_MCP_SCHEMA_CONTRACT } }],
  }), { code: 'STUDIO_NATIVE_MCP_SCHEMA_ENGINE_REQUIRED' });
});
