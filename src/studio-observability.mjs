/** Local trace store for the Studio plugin Node host.
 *
 * Port of the legacy Studio trace projection: run events are projected into
 * OTLP-shaped JSON files under ~/.agentkit/studio/traces. The read model
 * serves overview, list, detail, and raw OTLP to the observability page.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class StudioObservabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioObservabilityError';
    this.code = code;
    this.details = details;
  }
}

function parseRange(range) {
  const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 }[String(range || '24h')] || 24;
  return hours * 3600 * 1000;
}

function projectSpans(events) {
  const spans = [];
  const rootSpanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const rootStart = events.length ? new Date(events[0].at).getTime() : Date.now();
  const rootEnd = events.length ? new Date(events[events.length - 1].at).getTime() : rootStart;
  spans.push({ spanId: rootSpanId, parentSpanId: null, name: 'run', kind: 'INTERNAL', startedAt: new Date(rootStart).toISOString(), endedAt: new Date(rootEnd).toISOString(), attributes: { 'run.id': events[0]?.run_id || '', 'session.id': events[0]?.session_id || '' } });
  for (const event of events) {
    const type = String(event.event_type || event.type || '');
    if (type.startsWith('tool.') || type.startsWith('turn.')) {
      spans.push({ spanId: randomUUID().replace(/-/g, '').slice(0, 16), parentSpanId: rootSpanId, name: type, kind: 'INTERNAL', startedAt: event.at, endedAt: event.at, attributes: { seq: event.seq || 0, ...event.payload } });
    }
  }
  return spans;
}

function extractTokenUsage(events) {
  let inputTokens = 0, outputTokens = 0;
  for (const event of events) {
    const usage = event?.payload?.usage || event?.payload?.tokenUsage;
    if (usage) { inputTokens += Number(usage.input_tokens || usage.inputTokens || 0); outputTokens += Number(usage.output_tokens || usage.outputTokens || 0); }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function createStudioObservability({ storeDir } = {}) {
  async function ensureDir() { await mkdir(storeDir, { recursive: true, mode: 0o700 }); }

  async function syncTrace({ traceId, sessionId, agentId, agentName, status, startedAt, completedAt, events = [] }) {
    await ensureDir();
    const spans = projectSpans(events);
    const tokenUsage = extractTokenUsage(events);
    const record = {
      traceId: String(traceId || `trace_${randomUUID().replace(/-/g, '')}`),
      sessionId: String(sessionId || ''), agentId: String(agentId || ''), agentName: String(agentName || ''),
      status: String(status || 'completed'), startedAt: String(startedAt || (events[0]?.at || new Date().toISOString())),
      completedAt: String(completedAt || (events[events.length - 1]?.at || new Date().toISOString())),
      tokenUsage, spanCount: spans.length, spans, events,
      otlp: { resourceSpans: [{ resource: { attributes: [{ key: 'agent.id', value: { stringValue: String(agentId || '') } }, { key: 'agent.name', value: { stringValue: String(agentName || '') } }] }, scopeSpans: [{ spans: spans.map(span => ({ traceId: traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, kind: span.kind, startTimeUnixNano: String(new Date(span.startedAt).getTime() * 1e6), endTimeUnixNano: String(new Date(span.endedAt).getTime() * 1e6), attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) })) }] }] },
    };
    await writeFile(join(storeDir, `${record.traceId}.json`), JSON.stringify(record, null, 2));
    return record;
  }

  async function loadAll() {
    let names;
    try { names = await readdir(storeDir); } catch { return []; }
    const records = [];
    for (const name of names.filter(item => item.endsWith('.json')).sort()) {
      try { records.push(JSON.parse(await readFile(join(storeDir, name), 'utf8'))); } catch { /* skip */ }
    }
    return records;
  }

  async function overview({ range = '24h', agentId, query } = {}) {
    const ms = parseRange(range);
    const cutoff = Date.now() - ms;
    const records = (await loadAll()).filter(record => new Date(record.startedAt).getTime() >= cutoff && (!agentId || record.agentId === agentId));
    const bucketMs = ms <= 6 * 3600 * 1000 ? 15 * 60 * 1000 : 3600 * 1000;
    const buckets = {};
    for (const record of records) {
      const bucketStart = Math.floor(new Date(record.startedAt).getTime() / bucketMs) * bucketMs;
      const key = new Date(bucketStart).toISOString();
      if (!buckets[key]) buckets[key] = { startedAt: key, runs: 0, completed: 0, failed: 0 };
      buckets[key].runs++;
      if (record.status === 'completed' || record.status === 'succeeded') buckets[key].completed++;
      if (record.status === 'failed') buckets[key].failed++;
    }
    const agentMap = {};
    for (const record of records) { const key = record.agentId || 'unknown'; if (!agentMap[key]) agentMap[key] = { agentId: key, agentName: record.agentName || key, runs: 0 }; agentMap[key].runs++; }
    return { buckets: Object.values(buckets).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), totalRuns: records.length, totalTokens: records.reduce((sum, r) => sum + (r.tokenUsage?.totalTokens || 0), 0), agents: Object.values(agentMap) };
  }

  async function list({ range = '24h', agentId, query, limit = 200 } = {}) {
    const ms = parseRange(range);
    const cutoff = Date.now() - ms;
    const records = (await loadAll()).filter(record => new Date(record.startedAt).getTime() >= cutoff && (!agentId || record.agentId === agentId) && (!query || `${record.agentName} ${record.traceId} ${record.status}`.toLowerCase().includes(String(query).toLowerCase())));
    return { items: records.slice(0, Number(limit)).map(record => ({ traceId: record.traceId, agentId: record.agentId, agentName: record.agentName, sessionId: record.sessionId, status: record.status, startedAt: record.startedAt, completedAt: record.completedAt, tokenUsage: record.tokenUsage, spanCount: record.spanCount })) };
  }

  async function get(traceId) {
    try { return JSON.parse(await readFile(join(storeDir, `${traceId}.json`), 'utf8')); } catch { return null; }
  }

  async function getOtlp(traceId) {
    const trace = await get(traceId);
    return trace?.otlp || null;
  }

  return { syncTrace, overview, list, get, getOtlp };
}
