import type { Json } from './contracts.mjs';
import { invariant } from './values.mjs';

/** Decode one finite JSON value without silently accepting duplicate object keys. */
export function parseModelJson(text: string): Json {
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
    invariant(depth <= 256, 'model_json_nesting_exceeded'); space();
    const character = text[position];
    if (character === '"') return string();
    if (character === '{') {
      position++; space();
      const result: Record<string, Json> = Object.create(null) as Record<string, Json>, keys = new Set<string>();
      if (text[position] === '}') { position++; return result; }
      for (;;) {
        invariant(text[position] === '"', 'invalid_model_json');
        const key = string(); invariant(!keys.has(key), 'duplicate_model_json_key'); keys.add(key); space();
        invariant(text[position++] === ':', 'invalid_model_json'); result[key] = value(depth + 1); space();
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
    const result = Number(number[0]); invariant(Number.isFinite(result), 'non_finite_model_json_number'); return result;
  }
  const result = value(0); space(); invariant(position === text.length, 'invalid_model_json'); return result;
}
