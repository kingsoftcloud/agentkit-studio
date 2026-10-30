import type { ValidateFunction, KeywordDefinition } from 'ajv';
import type { Json, ObjectValue } from './contracts.mjs';
import { copy, invariant } from './values.mjs';

type Compiler = { compile(schema: ObjectValue): ValidateFunction; addKeyword(definition: KeywordDefinition): unknown; removeSchema(schema: object): unknown };
const keyword = 'agentkitExactIntegerV1';
const installed = new WeakSet<object>();
const extraSchemas = new WeakMap<ValidateFunction, ObjectValue>();
const scalarSchemas = ['additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'if', 'then', 'else',
  'propertyNames', 'not', 'unevaluatedItems', 'unevaluatedProperties', 'items'];
const arraySchemas = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const mapSchemas = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies'];

function checkReserved(value: Json, modern: boolean): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  invariant(!Object.hasOwn(value, keyword), 'reserved_exact_integer_schema_keyword');
  // Modern meta-schemas permit an empty enum (a false assertion), while
  // AJV's enum code generator rejects it. Keep reference paths in place.
  if (modern && Array.isArray(value.enum) && !value.enum.length
    && (value.allOf === undefined || Array.isArray(value.allOf))) {
    delete value.enum; value.allOf = [...(value.allOf as Json[] ?? []), false];
  }
  for (const key of [...scalarSchemas, ...arraySchemas]) {
    const child = value[key];
    if (Array.isArray(child)) child.forEach(item => checkReserved(item, modern));
    else if (child !== undefined) checkReserved(child, modern);
  }
  for (const key of mapSchemas) {
    const child = value[key];
    if (child && typeof child === 'object' && !Array.isArray(child)) Object.values(child).forEach(item => checkReserved(item, modern));
  }
}

function hasExactInteger(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'bigint') return true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => hasExactInteger(item, seen));
}
function project(value: unknown): unknown {
  if (typeof value === 'bigint') return 0;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(project);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) result[key] = project(item);
  return result;
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === 'bigint' && typeof right === 'number') return Number.isInteger(right) && left === BigInt(right);
  if (typeof right === 'bigint' && typeof left === 'number') return Number.isInteger(left) && right === BigInt(left);
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const l = Object.keys(left), r = Object.keys(right);
  return l.length === r.length && l.every(key => Object.hasOwn(right, key)
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
type Numeric = number | bigint;
function compare(left: Numeric, right: Numeric): number {
  // Relational comparison between bigint and number is exact in ECMAScript;
  // neither operand is converted to Number. Avoid subtraction/coercion.
  return left < right ? -1 : left > right ? 1 : 0;
}
function multiple(value: Numeric, divisor: Numeric): boolean {
  if (typeof value === 'number' && typeof divisor === 'number') return Number.isInteger(value / divisor);
  if (typeof divisor === 'bigint' || Number.isInteger(divisor)) {
    const d = BigInt(divisor);
    return d > 0n && (typeof value === 'bigint' || Number.isInteger(value)) && BigInt(value) % d === 0n;
  }
  if (typeof value !== 'bigint' || divisor <= 0) return false;
  // JSON Schema divisibility is decimal arithmetic. Preserve the integer
  // operand; do not overflow it through Number(value) / divisor.
  const [mantissa, exp = '0'] = divisor.toString().toLowerCase().split('e');
  const parts = mantissa!.split('.'), scale = (parts[1]?.length ?? 0) - Number(exp);
  const numerator = BigInt(parts.join(''));
  return scale >= 0 ? value * 10n ** BigInt(scale) % numerator === 0n
    : value % (numerator * 10n ** BigInt(-scale)) === 0n;
}
function matches(rules: ObjectValue, value: unknown): boolean {
  if (Object.hasOwn(rules, 'const') && !equal(value, rules.const)) return false;
  if (Array.isArray(rules.enum) && !rules.enum.some(item => equal(value, item))) return false;
  if (rules.uniqueItems && Array.isArray(value) && value.some((item, i) => value.slice(0, i).some(other => equal(item, other)))) return false;
  const size = typeof value === 'string' ? { kind: 'Length', size: [...value].length }
    : Array.isArray(value) ? { kind: 'Items', size: value.length }
    : value && typeof value === 'object' ? { kind: 'Properties', size: Object.keys(value).length } : null;
  if (size) {
    const min = rules[`min${size.kind}`], max = rules[`max${size.kind}`];
    if ((typeof min === 'number' || typeof min === 'bigint') && compare(size.size, min) < 0
      || (typeof max === 'number' || typeof max === 'bigint') && compare(size.size, max) > 0) return false;
  }
  if (typeof value !== 'bigint' && typeof value !== 'number') return true;
  for (const [name, limit] of Object.entries(rules)) {
    if (typeof limit !== 'bigint' && typeof limit !== 'number') continue;
    const order = compare(value, limit);
    if (name === 'minimum' && (order < 0 || order === 0 && rules.exclusiveMinimum === true)) return false;
    if (name === 'maximum' && (order > 0 || order === 0 && rules.exclusiveMaximum === true)) return false;
    if (name === 'exclusiveMinimum' && order <= 0 || name === 'exclusiveMaximum' && order >= 0) return false;
    if (name === 'multipleOf' && !multiple(value, limit)) return false;
  }
  if (rules.format === 'int32') return compare(value, -2147483648) >= 0 && compare(value, 2147483647) <= 0
    && (typeof value === 'bigint' || Number.isInteger(value));
  if (rules.format === 'int64') return typeof value === 'bigint' || Number.isInteger(value);
  return true;
}
function transform(value: Json, { legacy, formats, draft4, draft6 }: { legacy: boolean; formats: boolean; draft4: boolean; draft6: boolean }): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  invariant(!Object.hasOwn(value, keyword), 'reserved_exact_integer_schema_keyword');
  const options = { legacy, formats, draft4, draft6 };
  for (const key of scalarSchemas) {
    if (legacy && ['contentSchema', 'unevaluatedItems', 'unevaluatedProperties'].includes(key)
      || draft4 && ['contains', 'propertyNames'].includes(key)
      || (draft4 || draft6) && ['if', 'then', 'else'].includes(key)) continue;
    const child = value[key];
    if (Array.isArray(child)) child.forEach(item => transform(item, options));
    else if (child !== undefined) transform(child, options);
  }
  for (const key of arraySchemas) if (!(legacy && key === 'prefixItems') && Array.isArray(value[key])) value[key].forEach(item => transform(item, options));
  for (const key of mapSchemas) {
    const children = value[key];
    if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(child => transform(child, options));
  }
  const rules: ObjectValue = {};
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'uniqueItems', ...(draft4 ? [] : ['const'])]) {
    if (!Object.hasOwn(value, key)) continue;
    const bound = value[key]!;
    if (['minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key)) {
      invariant(draft4 && key.startsWith('exclusive') ? typeof bound === 'boolean'
        : typeof bound === 'bigint' || typeof bound === 'number' && Number.isFinite(bound), 'invalid_exact_integer_schema');
      if (key === 'multipleOf') invariant((bound as Numeric) > 0, 'invalid_exact_integer_schema');
    }
    if (key === 'enum') invariant(Array.isArray(bound) && (!legacy || bound.length > 0
      && !bound.some((item, index) => bound.slice(0, index).some(other => equal(item, other)))), 'invalid_exact_integer_schema');
    if (key === 'uniqueItems') invariant(typeof bound === 'boolean', 'invalid_exact_integer_schema');
    rules[key] = bound; delete value[key];
  }
  if (formats && ['int32', 'int64', 'float', 'double'].includes(String(value.format))) {
    rules.format = value.format!; delete value.format;
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minProperties', 'maxProperties', 'minContains', 'maxContains']) {
    if (legacy && key.endsWith('Contains')) continue;
    const bound = value[key];
    if (typeof bound !== 'bigint') continue;
    invariant(bound >= 0n, 'invalid_exact_integer_schema');
    if (key.endsWith('Contains')) {
      // An ECMAScript Array has at most 2^32-1 entries. These caps therefore
      // preserve the truth value of a larger exact contains-count bound.
      value[key] = Number(bound > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : bound);
    } else { rules[key] = bound; delete value[key]; }
  }
  if (legacy && typeof value.$ref === 'string') return; // validated assertion siblings are ignored.
  if (Object.keys(rules).length) value[keyword] = rules;
}

/** Keep AJV's structural/dialect semantics; exact predicates see the original tree. */
export function compileWithExactIntegers(validator: Compiler, schema: ObjectValue, formats = false): ValidateFunction {
  checkReserved(schema, !/draft-(04|06|07)/.test(String(schema.$schema ?? '')));
  const schemaExact = hasExactInteger(schema);
  // Ordinary schemas pass AJV's meta-schema eagerly. Exact schemas check the
  // extracted rule shapes explicitly and compile their remaining structure.
  const regular = schemaExact ? null : validator.compile(schema);
  let exact: ValidateFunction | null = null;
  const wrapped = ((data: unknown) => {
    if (!schemaExact && !hasExactInteger(data)) { const ok = regular!(data); wrapped.errors = regular!.errors ?? null; return ok; }
    const selected = ensureExact();
    const ok = selected.call({ original: data }, project(data)); wrapped.errors = selected.errors ?? null; return ok;
  }) as ValidateFunction;
  const ensureExact = (): ValidateFunction => {
    if (!exact) {
      if (!installed.has(validator)) {
        validator.addKeyword({ keyword, errors: false, validate: function(this: { original: unknown }, rules: ObjectValue, projected: unknown,
          _schema?: unknown, context?: { instancePath: string }) {
          let original = this.original;
          for (const key of (context?.instancePath ?? '').split('/').slice(1)) {
            const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
            original = original && typeof original === 'object' ? (original as Record<string, unknown>)[decoded] : undefined;
          }
          // propertyNames evaluates a key string at the containing object's path.
          const value = typeof original === typeof projected || typeof original === 'bigint' && typeof projected === 'number' ? original : projected;
          return matches(rules, value);
        } });
        installed.add(validator);
      }
      const transformed = copy(schema), dialect = String(schema.$schema ?? '');
      transform(transformed, { legacy: /draft-(04|06|07)/.test(dialect), draft4: dialect.includes('draft-04'), draft6: dialect.includes('draft-06'), formats });
      exact = validator.compile(transformed); extraSchemas.set(wrapped, transformed);
    }
    return exact;
  };
  if (schemaExact) ensureExact();
  return wrapped;
}
export function removeExactIntegerSchema(validator: Compiler, validate: ValidateFunction): void {
  const schema = extraSchemas.get(validate);
  if (schema) { validator.removeSchema(schema); extraSchemas.delete(validate); }
}
