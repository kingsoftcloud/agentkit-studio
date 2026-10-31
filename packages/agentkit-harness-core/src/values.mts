import type { RunScope } from './contracts.mjs';

// Module instances are not an error contract: two legitimate npm installations
// have different constructors. This in-process marker survives that boundary,
// while JSON/remote exception envelopes remain ordinary untrusted values.
const nativeErrorBrand = Symbol.for('@kingsoftcloud/agentkit-harness-core/NativeError/v1');
export class NativeError extends Error {
  constructor(readonly code: string) {
    super(code); this.name = 'NativeError';
    Object.defineProperty(this, nativeErrorBrand, { value: true });
  }
}
/** Recognize package-authored errors without trusting arbitrary name/code pairs. */
export function isNativeError(value: unknown): value is NativeError {
  try {
    if (value instanceof NativeError) return true;
    if (!(value instanceof Error)) return false;
    const brand = Object.getOwnPropertyDescriptor(value, nativeErrorBrand);
    const code = Object.getOwnPropertyDescriptor(value, 'code');
    const name = Object.getOwnPropertyDescriptor(value, 'name');
    return brand?.value === true && brand.writable === false && brand.enumerable === false
      && brand.configurable === false && typeof code?.value === 'string' && name?.value === 'NativeError';
  } catch {
    // A thrown Proxy/accessor is not a package-authored error proof.
    return false;
  }
}
export function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new NativeError(code);
}
export function canonical(value: unknown): string {
  const active = new Set<object>();
  function visit(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number') {
      invariant(Number.isFinite(item), 'non_json_number');
      if (Object.is(item, -0)) return '-0.0';
      // Keep a Python-float-compatible token when an integral IEEE value is
      // outside the safe integer range. Its shortest decimal integer spelling
      // can differ from the actual binary integer, and must not reopen as int.
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) return item.toExponential();
      return JSON.stringify(item);
    }
    invariant(typeof item === 'object' && item !== null && !active.has(item), 'non_json_value');
    active.add(item);
    let result: string;
    if (Array.isArray(item)) result = '[' + item.map(visit).join(',') + ']';
    else {
      invariant(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'non_json_object');
      result = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + visit((item as Record<string, unknown>)[key])).join(',') + '}';
    }
    active.delete(item);
    return result;
  }
  return visit(value);
}
/** Detach internal JSON state without re-encoding and reparsing its text blobs.
 * Wire decoding and canonical hashing retain their separate, strict boundaries.
 */
export function copy<T>(value: T): T {
  const active = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    invariant(depth <= 1024, 'model_json_nesting_exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') { invariant(Number.isFinite(item), 'non_json_number'); return item; }
    if (typeof item === 'bigint') {
      invariant(item.toString().replace(/^-/, '').length <= 4300, 'model_json_integer_digits_exceeded');
      return item >= BigInt(Number.MIN_SAFE_INTEGER) && item <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(item) : item;
    }
    invariant(typeof item === 'object' && item !== null && !active.has(item), 'non_json_value');
    active.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      const array: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        invariant(Object.hasOwn(item, index), 'invalid_model_json');
        array.push(visit(item[index], depth + 1));
      }
      result = array;
    } else {
      invariant(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'non_json_object');
      const object: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) Object.defineProperty(object, key, {
        value: visit((item as Record<string, unknown>)[key], depth + 1), enumerable: true, configurable: true, writable: true,
      });
      result = object;
    }
    active.delete(item);
    return result;
  }
  return visit(value, 0) as T;
}
export function scopeKey(scope: RunScope): string {
  invariant(scope && Object.keys(scope).length === 4, 'invalid_scope');
  const parts = [scope.tenantId, scope.workspaceId, scope.userId, scope.agentId];
  invariant(parts.every(part => typeof part === 'string' && part.trim().length > 0), 'invalid_scope');
  return canonical(parts);
}
export function runKey(scope: RunScope, runId: string): string {
  invariant(typeof runId === 'string' && runId.trim(), 'invalid_run_id');
  return canonical([scopeKey(scope), runId]);
}
