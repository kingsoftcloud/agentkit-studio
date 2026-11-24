/** JSON values used by Studio's Native contracts and durable binding digests. */
/** @typedef {import('./types.js').NativeJson} NativeJson */
const errorBrand = Symbol.for('@kingsoftcloud/agentkit-harness-core/NativeError/v1');

export class NativeError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'NativeError';
    // The legacy in-process runtime reads this marker for typed failures.
    Object.defineProperty(this, errorBrand, { value: true });
  }
}

/** @param {unknown} value @param {string} code @returns {asserts value} */
export function invariant(value, code) {
  if (!value) throw new NativeError(code);
}

/** @param {object} item @returns {asserts item is Record<string, unknown>} */
function checkObject(item) {
  invariant(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'non_json_object');
}

/** @param {unknown} value */
export function canonical(value) {
  /** @type {Set<object>} */
  const active = new Set();
  /** @param {unknown} item @returns {string} */
  function visit(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number') {
      invariant(Number.isFinite(item), 'non_json_number');
      if (Object.is(item, -0)) return '-0.0';
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) return item.toExponential();
      return JSON.stringify(item);
    }
    invariant(typeof item === 'object' && item !== null && !active.has(item), 'non_json_value');
    active.add(item);
    let result;
    if (Array.isArray(item)) result = '[' + item.map(visit).join(',') + ']';
    else {
      checkObject(item);
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit(item[key])).join(',') + '}';
    }
    active.delete(item);
    return result;
  }
  return visit(value);
}

/** @template T @param {T} value @returns {T} */
export function copy(value) {
  /** @type {Set<object>} */
  const active = new Set();
  /** @param {unknown} item @param {number} depth @returns {NativeJson} */
  function visit(item, depth) {
    invariant(depth <= 1024, 'model_json_nesting_exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      invariant(Number.isFinite(item), 'non_json_number');
      return item;
    }
    if (typeof item === 'bigint') {
      invariant(item.toString().replace(/^-/, '').length <= 4300, 'model_json_integer_digits_exceeded');
      return item >= BigInt(Number.MIN_SAFE_INTEGER) && item <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(item) : item;
    }
    invariant(typeof item === 'object' && item !== null && !active.has(item), 'non_json_value');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      /** @type {NativeJson[]} */
      const array = [];
      for (let index = 0; index < item.length; index++) {
        invariant(Object.hasOwn(item, index), 'invalid_model_json');
        array.push(visit(item[index], depth + 1));
      }
      result = array;
    } else {
      checkObject(item);
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]));
    }
    active.delete(item);
    return result;
  }
  return /** @type {T} */ (visit(value, 0));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} scope */
export function scopeKey(scope) {
  invariant(isRecord(scope) && Object.keys(scope).length === 4, 'invalid_scope');
  const parts = [scope.tenantId, scope.workspaceId, scope.userId, scope.agentId];
  invariant(parts.every(part => typeof part === 'string' && part.trim().length > 0), 'invalid_scope');
  return canonical(parts);
}

/** @param {unknown} scope @param {unknown} runId */
export function runKey(scope, runId) {
  invariant(typeof runId === 'string' && runId.trim(), 'invalid_run_id');
  return canonical([scopeKey(scope), runId]);
}

/** @param {unknown} phase */
export const isTerminalRunPhase = phase => typeof phase === 'string' && ['completed', 'failed', 'canceled', 'interrupted'].includes(phase);
