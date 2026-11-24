import { isRecord } from './native-values.mjs';

export const ENGINE_EVENT_SCHEMA = 'agentkit.engine-event/v1';

/** @param {unknown} path @returns {path is string} */
export function relativeDeliveryPath(path) {
  return typeof path === 'string' && path.length <= 2048 && !/[\\:\u0000-\u001f\u007f?#]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

/** @param {unknown} item @returns {item is {path: string, root: string}} */
function declaredWebDelivery(item) {
  return isRecord(item) && item.kind === 'web' && relativeDeliveryPath(item.path)
    && /\.html?$/i.test(item.path) && (item.root === '.' || relativeDeliveryPath(item.root)
      && item.path.startsWith(item.root + '/'));
}

/** Web cards come from the Run's manifest. Older Runs can name an HTML file
 * explicitly in the final answer; the host still has to confirm it exists.
 * @param {unknown} event
 */
export function engineWebDeliveries(event) {
  if (!isRecord(event) || event.schema !== ENGINE_EVENT_SCHEMA || event.kind !== 'run.terminal' || event.title !== 'completed'
    || !(typeof event.detail === 'string' && event.detail.trim())) return [];
  /** @type {unknown[]} */
  const declared = Array.isArray(event.deliverables) ? event.deliverables : [];
  const web = declared.find(declaredWebDelivery);
  if (web) return [{ path: web.path, root: web.root }];
  if (declared.length) return [];

  const paths = new Set();
  for (const match of event.detail.matchAll(/`([^`\r\n]+)`|\]\(([^\s()]+)\)/g)) {
    const path = (match[1] ?? match[2]).replace(/^\.\//, '');
    if (relativeDeliveryPath(path) && !/[%<>]/.test(path) && /\.html?$/i.test(path)) paths.add(path);
    if (paths.size >= 8) break;
  }
  return [...paths].map(path => ({ path }));
}
