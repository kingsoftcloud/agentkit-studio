export function operationalCollection(payload, keys = ['items']) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  const nested = payload?.data || payload?.Data;
  if (Array.isArray(nested)) return nested;
  if (nested && typeof nested === 'object') {
    for (const key of keys) if (Array.isArray(nested[key])) return nested[key];
  }
  return [];
}

export function operationalId(item, fallback = '') {
  return String(item?.metadata?.id || item?.id || item?.Id || item?.caseId || item?.traceId || item?.TraceId || item?.runId || item?.RunId || fallback);
}

export function operationalLabel(item, fallback = '—') {
  return String(item?.metadata?.name || item?.name || item?.Name || item?.title || item?.Title || item?.displayName || item?.DisplayName || fallback);
}

export function operationalDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
