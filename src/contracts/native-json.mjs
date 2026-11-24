import { invariant } from './native-values.mjs';
/** @typedef {import('./types.js').NativeJson} NativeJson */
export const NATIVE_JSON_CODEC = 'agentkit.native-json-integer/v1';
/** Decode ledger/wire JSON while preserving ordinary detached object prototypes. @param {string} text */
export function parseNativeJson(text) { return decodeJson(text, 1024); }
/** @param {string} text @param {number} maxDepth @returns {NativeJson} */
function decodeJson(text, maxDepth) {
    let position = 0;
    // The strict structural decoder still owns duplicate keys, exact integers
    // and depth. Scan text spans in the engine rather than visiting each code
    // unit in JS: persisted code/log strings dominate long-session reads.
    const stringToken = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"/y;
    const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    function space() {
        while (position < text.length) {
            const code = text.charCodeAt(position);
            if (code !== 9 && code !== 10 && code !== 13 && code !== 32)
                break;
            position++;
        }
    }
    /** @returns {string} */
    function string() {
        stringToken.lastIndex = position;
        const token = stringToken.exec(text);
        invariant(token, 'invalid_model_json');
        position = stringToken.lastIndex;
        // Native decoding validates escapes and rejects raw control characters.
        return JSON.parse(token[0]);
    }
    /** @param {number} depth @returns {NativeJson} */
    function value(depth) {
        invariant(depth <= maxDepth, 'model_json_nesting_exceeded');
        space();
        const character = text[position];
        if (character === '"')
            return string();
        if (character === '{') {
            position++;
            space();
            /** @type {import('./types.js').NativeJsonObject} */
            const result = {};
            const keys = new Set();
            if (text[position] === '}') {
                position++;
                return result;
            }
            for (;;) {
                invariant(text[position] === '"', 'invalid_model_json');
                const key = string();
                invariant(!keys.has(key), 'duplicate_model_json_key');
                keys.add(key);
                space();
                invariant(text[position++] === ':', 'invalid_model_json');
                Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
                space();
                if (text[position] === '}') {
                    position++;
                    return result;
                }
                invariant(text[position++] === ',', 'invalid_model_json');
                space();
            }
        }
        if (character === '[') {
            position++;
            space();
            /** @type {NativeJson[]} */
            const result = [];
            if (text[position] === ']') {
                position++;
                return result;
            }
            for (;;) {
                result.push(value(depth + 1));
                space();
                if (text[position] === ']') {
                    position++;
                    return result;
                }
                invariant(text[position++] === ',', 'invalid_model_json');
            }
        }
        /** @type {[string, null | boolean][]} */
        const literals = [['null', null], ['true', true], ['false', false]];
        for (const [literal, result] of literals) {
            if (text.startsWith(literal, position)) {
                position += literal.length;
                return result;
            }
        }
        numberToken.lastIndex = position;
        const number = numberToken.exec(text);
        invariant(number, 'invalid_model_json');
        position = numberToken.lastIndex;
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
    const result = value(0);
    space();
    invariant(position === text.length, 'invalid_model_json');
    return result;
}
/** JSON wire encoding; only genuine bigint primitives become raw numeric tokens. @param {unknown} value */
export function stringifyModelJson(value) {
    return JSON.stringify(value, (_key, item) => {
        const exactInteger = typeof item === 'bigint';
        const negativeZero = typeof item === 'number' && Object.is(item, -0);
        const largeFloat = typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item);
        if (!exactInteger && !largeFloat && !negativeZero)
            return item;
        const raw = /** @type {JSON & {rawJSON?: (text: string) => object}} */ (JSON).rawJSON;
        invariant(typeof raw === 'function', 'exact_integer_wire_codec_unavailable');
        return raw(exactInteger ? item.toString() : negativeZero ? '-0.0' : item.toExponential());
    });
}
/** Values which an ordinary JSON.stringify-based Host boundary cannot preserve.
 * @param {unknown} value @param {Set<object>} [seen] @returns {boolean}
 */
export function requiresExactJsonWire(value, seen = new Set()) {
    if (typeof value === 'bigint')
        return true;
    if (typeof value === 'number')
        return Object.is(value, -0) || Number.isInteger(value) && !Number.isSafeInteger(value);
    if (!value || typeof value !== 'object' || seen.has(value))
        return false;
    seen.add(value);
    return Object.values(value).some(item => requiresExactJsonWire(item, seen));
}
