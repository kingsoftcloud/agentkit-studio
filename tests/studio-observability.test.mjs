import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioObservability } from '../src/studio-observability.mjs';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-traces-')); }

test('syncTrace projects events into OTLP and persists', async () => {
  const store = await makeStore();
  const obs = createStudioObservability({ storeDir: store });
  try {
    await obs.syncTrace({
      traceId: 'trace_abc', sessionId: 'ses-1', agentId: 'ar-1', agentName: 'My Agent',
      status: 'succeeded', startedAt: '2026-09-29T10:00:00Z', completedAt: '2026-09-29T10:01:00Z',
      events: [
        { seq: 1, event_type: 'turn.start', at: '2026-09-29T10:00:00Z', run_id: 'run-1', session_id: 'ses-1', payload: {} },
        { seq: 2, event_type: 'tool.start', at: '2026-09-29T10:00:10Z', payload: { name: 'read_file' } },
        { seq: 3, event_type: 'tool.completed', at: '2026-09-29T10:00:20Z', payload: { name: 'read_file' } },
        { seq: 4, event_type: 'turn.completed', at: '2026-09-29T10:01:00Z', payload: { usage: { input_tokens: 100, output_tokens: 50 } } },
      ],
    });
    const trace = await obs.get('trace_abc');
    assert.equal(trace.agentId, 'ar-1');
    assert.ok(trace.spans.length >= 1);
    assert.equal(trace.tokenUsage.totalTokens, 150);
    assert.ok(trace.otlp?.resourceSpans?.length > 0);
    const listed = await obs.list({});
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].traceId, 'trace_abc');
    const overview = await obs.overview({});
    assert.equal(overview.totalRuns, 1);
    assert.equal(overview.totalTokens, 150);
    assert.equal(overview.agents[0].agentName, 'My Agent');
    const otlp = await obs.getOtlp('trace_abc');
    assert.ok(otlp.resourceSpans[0].scopeSpans[0].spans.length > 0);
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});

test('overview and list filter by range and agentId', async () => {
  const store = await makeStore();
  const obs = createStudioObservability({ storeDir: store });
  try {
    await obs.syncTrace({ traceId: 't1', agentId: 'ar-1', agentName: 'A', status: 'succeeded', startedAt: '2026-09-29T10:00:00Z', completedAt: '2026-09-29T10:01:00Z', events: [] });
    await obs.syncTrace({ traceId: 't2', agentId: 'ar-2', agentName: 'B', status: 'failed', startedAt: '2026-09-29T11:00:00Z', completedAt: '2026-09-29T11:01:00Z', events: [] });
    const byAgent = await obs.list({ agentId: 'ar-2' });
    assert.equal(byAgent.items.length, 1);
    assert.equal(byAgent.items[0].traceId, 't2');
    const all = await obs.list({});
    assert.equal(all.items.length, 2);
    const overview = await obs.overview({ range: '24h' });
    assert.equal(overview.totalRuns, 2);
    assert.equal(overview.agents.length, 2);
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});
