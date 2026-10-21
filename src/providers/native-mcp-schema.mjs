import { canonical, compileToolInput, invariant, parseNativeJson, requiresExactJsonWire } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeMcpSchemaValidator } from './native-mcp-json.mjs';

export const NATIVE_MCP_SCHEMA_CONTRACT = 'agentkit.native-mcp-schema/v1';

/** JSON text keeps exact numeric constraints through ordinary plugin configuration. */
export function snapshotNativeMcpSchema(tool) {
  const snapshot = { contract: NATIVE_MCP_SCHEMA_CONTRACT,
    inputJson: canonical(tool.inputSchema ?? { type: 'object', properties: {} }),
    outputJson: tool.outputSchema == null ? null : canonical(tool.outputSchema) };
  bindNativeMcpSchema(snapshot);
  return snapshot;
}

/** Native owns validation/model schemas; DSH retains its permission/execution pipeline. */
export function bindNativeMcpSchema(snapshot) {
  invariant(snapshot?.contract === NATIVE_MCP_SCHEMA_CONTRACT
    && typeof snapshot.inputJson === 'string'
    && (snapshot.outputJson === null || typeof snapshot.outputJson === 'string'), 'studio_native_mcp_schema_contract_invalid');
  const input = parseNativeJson(snapshot.inputJson);
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'studio_native_mcp_input_schema_invalid');
  compileToolInput(input);
  const output = snapshot.outputJson === null ? null : parseNativeJson(snapshot.outputJson);
  invariant(snapshot.outputJson === null || output && typeof output === 'object' && !Array.isArray(output), 'studio_native_mcp_output_schema_invalid');
  // DSH cannot snapshot bigint/negative zero as ordinary JSON. Its carrier
  // retains the complete schema text; it never supplies the Native model or
  // validates these inputs. Safe schemas keep their normal DSH presentation.
  const registryParameters = requiresExactJsonWire(input)
    ? { type: 'object', 'x-agentkit-native-input-schema-json': snapshot.inputJson } : structuredClone(input);
  return { input, registryParameters,
    validateOutput: output === null ? null : nativeMcpSchemaValidator.getValidator(output) };
}
