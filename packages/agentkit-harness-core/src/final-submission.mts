import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Json, ObjectValue, RunConfiguration, ToolCall, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { parseModelJson } from './model-json.mjs';
import { compileWithExactIntegers, removeExactIntegerSchema } from './exact-integer-schema.mjs';

export const FINAL_SUBMISSION_TOOL = 'submit_final_output';
const validator = new Ajv2020({ strict: false, validateFormats: false, ownProperties: true, addUsedSchema: false, passContext: true });
const compiled = new Map<string, { schema: ObjectValue; validate: ValidateFunction }>();

function bounded(value: Json, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(item => bounded(item, depth + 1));
  return !['$ref', '$dynamicRef', '$recursiveRef'].some(key => Object.hasOwn(value, key))
    && Object.values(value).every(item => bounded(item, depth + 1));
}
function compile(schema: ObjectValue): ValidateFunction {
  const key = canonical(schema), cached = compiled.get(key);
  if (cached) return cached.validate;
  schema = copy(schema);
  // Match the reference's bounded, ASCII-escaped JSON including separator spaces.
  let length = 0, quoted = false, escaped = false;
  for (const character of key.split('')) {
    length += character.charCodeAt(0) >= 127 ? 6 : 1;
    if (!quoted && (character === ':' || character === ',')) length++;
    if (escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
  }
  invariant(schema.type === 'object' && length <= 16384 && bounded(schema), 'invalid_final_submission_schema');
  let validate: ValidateFunction;
  try { validate = compileWithExactIntegers(validator, schema); }
  catch { invariant(false, 'invalid_final_submission_schema'); }
  if (compiled.size >= 64) {
    const oldest = compiled.keys().next().value!;
    const record = compiled.get(oldest)!;
    validator.removeSchema(record.schema); removeExactIntegerSchema(validator, record.validate); compiled.delete(oldest);
  }
  compiled.set(key, { schema, validate }); return validate;
}
export function submissionOutputFormat(schema: ObjectValue, payloadKey: string | null): 'text' | 'json_object' | 'json_value' {
  const properties = schema.properties;
  const property = payloadKey === null ? schema
    : properties && typeof properties === 'object' && !Array.isArray(properties) ? properties[payloadKey] : undefined;
  invariant(property && typeof property === 'object' && !Array.isArray(property), 'invalid_final_submission_payload');
  if (property.type === 'object') return 'json_object';
  if (payloadKey && property.type === 'string') return 'text';
  invariant(payloadKey && typeof property.type === 'string'
    && ['integer', 'number', 'boolean', 'array', 'null'].includes(property.type), 'invalid_final_submission_payload');
  return 'json_value';
}
export function validateSubmissionContract(config: RunConfiguration): void {
  const { finalSubmissionSchema: schema, finalSubmissionPayloadKey: key } = config.contract;
  invariant(!config.tools.some(tool => tool.name === FINAL_SUBMISSION_TOOL), 'reserved_final_submission_tool');
  if (!schema) { invariant(key === null, 'final_submission_schema_missing'); return; }
  compile(schema);
  if (key !== null) invariant(key.trim() && Array.isArray(schema.required) && schema.required.includes(key), 'invalid_final_submission_payload');
  invariant(submissionOutputFormat(schema, key) === config.contract.finalOutputFormat, 'final_submission_format_mismatch');
}
export function finalSubmissionTool(config: RunConfiguration): ToolDefinition | null {
  const schema = config.contract.finalSubmissionSchema;
  if (!schema) return null;
  return { name: FINAL_SUBMISSION_TOOL, description: 'Submit the final structured answer for host verification. This does not execute a workspace action.',
    parameters: schema, readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 1,
    contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' };
}
export function submittedFinalText(call: ToolCall, config: RunConfiguration): string | null {
  const { finalSubmissionSchema: schema, finalSubmissionPayloadKey: key, finalOutputFormat: format } = config.contract;
  if (!schema || call.name !== FINAL_SUBMISSION_TOOL || call.wireArgumentsInvalid || !compile(schema)(call.arguments)) return null;
  const output = key === null ? call.arguments : call.arguments[key];
  if (format === 'text') return typeof output === 'string' ? output : null;
  return output === undefined ? null : canonical(output);
}
export function normalizedFinalText(text: string, format: RunConfiguration['contract']['finalOutputFormat']): string {
  if (format === 'text') return text;
  let candidate = text.trim();
  if (candidate.startsWith('```')) {
    const lines = candidate.split(/\r\n|\n|\r/);
    if (lines.length < 3 || lines.at(-1)!.trim() !== '```'
      || !['', 'json'].includes(lines[0]!.slice(3).trim().toLowerCase())) return text;
    candidate = lines.slice(1, -1).join('\n').trim();
  }
  try {
    const value = parseModelJson(candidate);
    return format === 'json_value' || value !== null && typeof value === 'object' && !Array.isArray(value) ? candidate : text;
  } catch { return text; }
}
