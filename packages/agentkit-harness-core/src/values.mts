import type { RunScope } from './contracts.mjs';
import { parseNativeJson } from './model-json.mjs';

export class NativeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NativeError'; }
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
export function copy<T>(value: T): T { return parseNativeJson(canonical(value)) as T; }
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
