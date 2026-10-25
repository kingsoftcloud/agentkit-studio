/** Teams transport uses RFC8785, independently of Native's lossless journal
 * codec. In particular -0 serializes as 0; BigInt and unsafe integral numbers
 * cannot be signed as interoperable Teams JSON. */
import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export function canonicalTeamsJson(value) {
  const active = new Set(), check = condition => invariant(condition, 'NATIVE_TEAMS_JSON_INVALID');
  const string = value => { check(value.isWellFormed()); return JSON.stringify(value); };
  function encode(item, depth) {
    check(depth <= 50);
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') return string(item);
    if (typeof item === 'number') {
      check(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)));
      return JSON.stringify(item);
    }
    check(item && typeof item === 'object' && !active.has(item)); active.add(item);
    let result;
    if (Array.isArray(item)) {
      check(Reflect.ownKeys(item).length === item.length + 1);
      result = '[' + Array.from({ length: item.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, i); check(descriptor && Object.hasOwn(descriptor, 'value'));
        return encode(descriptor.value, depth + 1);
      }).join(',') + ']';
    } else {
      check(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);
      const keys = Reflect.ownKeys(item); check(keys.every(key => typeof key === 'string'));
      result = '{' + keys.sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key); check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        return string(key) + ':' + encode(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(item); return result;
  }
  return encode(value, 0);
}

export const copyTeamsJson = value => JSON.parse(canonicalTeamsJson(value));
