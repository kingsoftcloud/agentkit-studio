import type { Json } from './contracts.mjs';
import { invariant } from './values.mjs';

export const NATIVE_JSON_CODEC = 'agentkit.native-json-integer/v1' as const;

/** Decode one finite JSON value without silently accepting duplicate object keys. */
export function parseModelJson(text: string): Json { return decodeJson(text, false, 256); }
/** Decode ledger/wire JSON while preserving ordinary detached object prototypes. */
export function parseNativeJson(text: string): Json { return decodeJson(text, true, 1024); }
function decodeJson(text: string, plainObjects: boolean, maxDepth: number): Json {
  let position = 0;
  function space(): void { while (/[\u0009\u000a\u000d\u0020]/.test(text[position] ?? '\0')) position++; }
  function string(): string {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    invariant(false, 'invalid_model_json');
  }
  function value(depth: number): Json {
    invariant(depth <= maxDepth, 'model_json_nesting_exceeded'); space();
    const character = text[position];
    if (character === '"') return string();
    if (character === '{') {
      position++; space();
      const result: Record<string, Json> = plainObjects ? {} : Object.create(null) as Record<string, Json>, keys = new Set<string>();
      if (text[position] === '}') { position++; return result; }
      for (;;) {
        invariant(text[position] === '"', 'invalid_model_json');
        const key = string(); invariant(!keys.has(key), 'duplicate_model_json_key'); keys.add(key); space();
        invariant(text[position++] === ':', 'invalid_model_json');
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true }); space();
        if (text[position] === '}') { position++; return result; }
        invariant(text[position++] === ',', 'invalid_model_json'); space();
      }
    }
    if (character === '[') {
      position++; space(); const result: Json[] = [];
      if (text[position] === ']') { position++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space();
        if (text[position] === ']') { position++; return result; }
        invariant(text[position++] === ',', 'invalid_model_json');
      }
    }
    for (const [literal, result] of [['null', null], ['true', true], ['false', false]] as const) {
      if (text.startsWith(literal, position)) { position += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(position));
    invariant(number, 'invalid_model_json'); position += number[0].length;
    const lexeme = number[0], result = Number(lexeme);
    if (!/[.eE]/.test(lexeme) && !Number.isSafeInteger(result)) {
      // Python's JSON decoder uses arbitrary precision int, with its default
      // decimal conversion limit. Decimal/exponent tokens retain float semantics.
      invariant(lexeme.replace(/^-/, '').length <= 4300, 'model_json_integer_digits_exceeded');
      return BigInt(lexeme);
    }
    invariant(Number.isFinite(result), 'non_finite_model_json_number');
    return lexeme === '-0' ? 0 : result;
  }
  const result = value(0); space(); invariant(position === text.length, 'invalid_model_json'); return result;
}

/** JSON wire encoding; only genuine bigint primitives become raw numeric tokens. */
export function stringifyModelJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    const exactInteger = typeof item === 'bigint';
    const negativeZero = typeof item === 'number' && Object.is(item, -0);
    const largeFloat = typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item);
    if (!exactInteger && !largeFloat && !negativeZero) return item;
    const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
    invariant(typeof raw === 'function', 'exact_integer_wire_codec_unavailable');
    return raw(exactInteger ? item.toString() : negativeZero ? '-0.0' : (item as number).toExponential());
  });
}

/** Values which an ordinary JSON.stringify-based Host boundary cannot preserve. */
export function requiresExactJsonWire(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') return Object.is(value, -0) || Number.isInteger(value) && !Number.isSafeInteger(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value); return Object.values(value).some(item => requiresExactJsonWire(item, seen));
}
