/** Durable, content-free evidence of actual resource adapter calls. */
export const RESOURCE_CHECK_EVENT = 'studio/resource-check';
export function sanitizeResourceCheck(value) {
  if (!value || !['skill', 'skill-space', 'knowledge-base', 'memory-instance'].includes(value.kind)
    || typeof value.resourceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value.resourceId)
    || !['load', 'search', 'recall', 'write'].includes(value.action) || !['succeeded', 'failed'].includes(value.status)) return null;
  const check = { kind: value.kind, resourceId: value.resourceId, action: value.action, status: value.status };
  for (const key of ['durationMs', 'hitCount', 'definitionCount']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) check[key] = value[key];
  if (typeof value.accepted === 'boolean') check.accepted = value.accepted;
  if (/^[A-Z][A-Z0-9_]{0,100}$/.test(value.code || '')) check.code = value.code;
  return check;
}
export async function checkedResource({ kind, resourceId, action, agent, onResource }, work) {
  const start = Date.now();
  const report = result => {
    const check = { kind, resourceId: String(resourceId), action, durationMs: Date.now() - start, ...result };
    agent?.session?.append(RESOURCE_CHECK_EVENT, check, { ignorable: true });
    onResource?.(check);
  };
  try {
    const value = await work();
    report({ status: 'succeeded', ...(Array.isArray(value) ? { hitCount: value.length } : {}),
      ...(Array.isArray(value?.definitions) ? { definitionCount: value.definitions.length } : {}),
      ...(typeof value?.accepted === 'boolean' ? { accepted: value.accepted } : {}) });
    return value;
  } catch (error) { report({ status: 'failed', code: /^[A-Z][A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'RESOURCE_CALL_FAILED' }); throw error; }
}
