import { compileToolInput, NATIVE_JSON_CODEC, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

// This mode is Host-owned. Remote payloads cannot negotiate it or create
// integer wrappers: only numeric JSON tokens become exact integer values.
export const NATIVE_MCP_JSON_CODEC = NATIVE_JSON_CODEC;
export const MCP_JSON_PARSER_CONTRACT = 'mcp.json-parser/v1';
export const nativeMcpJsonParser = parseNativeJson;

// Keep the official client's output-schema validation while allowing the
// same exact integers used by Native input validation and durable receipts.
export const nativeMcpSchemaValidator = {
  getValidator(schema) {
    const validate = compileToolInput(schema);
    return input => validate(input)
      ? { valid: true, data: input, errorMessage: undefined }
      : { valid: false, data: undefined, errorMessage: (validate.errors ?? []).map(error =>
        `${error.instancePath || '/'}: ${error.keyword} ${error.message || 'invalid output'}`).join('; ').slice(0, 1000) };
  },
};
