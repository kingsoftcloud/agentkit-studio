import { Ajv } from 'ajv/dist/ajv.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import draft4 from 'ajv-draft-04';
import draft6 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' };
import formats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import type { Json, ObjectValue, ToolCall, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { compileWithExactIntegers, removeExactIntegerSchema } from './exact-integer-schema.mjs';

const options = { strict: false, allErrors: true, ownProperties: true, addUsedSchema: false, passContext: true, logger: false as const };
const legacyOptions = { ...options, ignoreKeywordsWithRef: true };
// The CJS package exports its constructor as module.exports and .default.
const Ajv4 = draft4 as unknown as new (options: typeof legacyOptions) => InstanceType<typeof Ajv>;
const ajv6 = new Ajv(legacyOptions).addMetaSchema(draft6);
for (const keyword of ['if', 'then', 'else']) ajv6.removeKeyword(keyword);
const ajv4 = new Ajv4(legacyOptions);
for (const keyword of ['const', 'contains', 'propertyNames', 'if', 'then', 'else']) ajv4.removeKeyword(keyword);
const validators = { draft4: ajv4, draft6: ajv6, draft7: new Ajv(legacyOptions),
  draft2019: new Ajv2019(options), draft2020: new Ajv2020(options) };
for (const validator of Object.values(validators)) (formats as unknown as FormatsPlugin)(validator);
type Validator = Ajv | Ajv2019 | Ajv2020;
const compiled = new Map<string, { validate: ValidateFunction; validator: Validator; schema: ObjectValue }>();

function prepareSchema(value: Json, ignoreRefSiblings: boolean): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key)) {
      invariant(typeof child === 'string' && child.startsWith('#'), 'external_tool_schema_reference');
    }
    invariant(key !== '$async' || child !== true, 'asynchronous_tool_schema');
  }
  // Ajv's legacy ignoreKeywordsWithRef still checks `type` before resolving
  // a reference. Older drafts ignore all assertion siblings of $ref.
  if (ignoreRefSiblings && typeof value.$ref === 'string') delete value.type;
  for (const key of ['additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'if', 'then', 'else',
    'propertyNames', 'not', 'unevaluatedItems', 'unevaluatedProperties', 'items']) {
    const child = value[key];
    if (Array.isArray(child)) child.forEach(item => prepareSchema(item, ignoreRefSiblings));
    else if (child !== undefined) prepareSchema(child, ignoreRefSiblings);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const child = value[key];
    if (Array.isArray(child)) child.forEach(item => prepareSchema(item, ignoreRefSiblings));
  }
  for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies']) {
    const child = value[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      Object.values(child).forEach(item => prepareSchema(item, ignoreRefSiblings));
    }
  }
}
export function compileToolInput(schema: ObjectValue): ValidateFunction {
  const key = canonical(schema), cached = compiled.get(key);
  if (cached) return cached.validate;
  schema = copy(schema);
  const dialect = String(schema.$schema ?? 'https://json-schema.org/draft/2020-12/schema');
  let validator: Validator;
  const legacy = /^https?:\/\/json-schema.org\/draft-(04|06|07)\/schema#?$/.exec(dialect);
  if (legacy) {
    validator = legacy[1] === '04' ? validators.draft4 : legacy[1] === '06' ? validators.draft6 : validators.draft7;
    schema.$schema = `http://json-schema.org/draft-${legacy[1]}/schema#`;
  } else if (/^https?:\/\/json-schema.org\/draft\/(2019-09|2020-12)\/schema#?$/.test(dialect)) {
    validator = dialect.includes('2019-09') ? validators.draft2019 : validators.draft2020;
    schema.$schema = `https://json-schema.org/draft/${dialect.includes('2019-09') ? '2019-09' : '2020-12'}/schema`;
  } else invariant(false, 'unsupported_tool_schema_dialect');
  prepareSchema(schema, !!legacy);
  let validate: ValidateFunction;
  try { validate = compileWithExactIntegers(validator, schema, true); }
  catch { invariant(false, 'invalid_tool_input_schema'); }
  if (compiled.size >= 128) {
    const oldest = compiled.keys().next().value!, record = compiled.get(oldest)!;
    record.validator.removeSchema(record.schema); removeExactIntegerSchema(record.validator, record.validate); compiled.delete(oldest);
  }
  compiled.set(key, { validate, validator, schema }); return validate;
}

/** Schema validity is a data fact. It never authorizes the tool callback. */
export function toolInputRejection(definition: ToolDefinition, call: ToolCall): ObjectValue | null {
  if (call.wireArgumentsInvalid) return { code: 'invalid_arguments', reason: 'wire_arguments_invalid', executed: false };
  const validate = compileToolInput(definition.parameters);
  if (validate(copy(call.arguments))) return null;
  return { code: 'invalid_arguments', executed: false, errors: (validate.errors ?? []).map(error => ({
    path: error.instancePath, keyword: error.keyword, message: error.message ?? 'Invalid tool input',
  })) };
}
