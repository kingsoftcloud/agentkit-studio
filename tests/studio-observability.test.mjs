import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioObservability } from '../src/studio-observability.mjs';
import { createNativeSkillEventJournal, nativeSkillEventEvidence } from '@kingsoftcloud/agentkit-harness-node/native/skill-events';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-traces-')); }

test('durable Skill tool facts project into Studio trace detail and OTLP without duplicate spans', async () => {
  const store = await makeStore(), obs = createStudioObservability({ storeDir: store }), events = [];
  const journal = createNativeSkillEventJournal({ runtimeId: 'runtime', request: { runId: 'run' }, bindingDigest: 'binding', events });
  journal.emit('skill.workflow.started', 'running'); journal.emit('skill.workflow.completed', 'completed');
  const at = new Date().toISOString(), content = JSON.stringify({ ok: true, ...nativeSkillEventEvidence(events) });
  try {
    const facts = [1, 2].map(seq => ({ seq, event_type: 'tool.completed', at, payload: { name: 'execute_skills', content } }));
    await obs.syncTrace({ traceId: 'skill-trace', sessionId: 'session', agentId: 'agent', status: 'completed', startedAt: at, completedAt: at, events: facts });
    const first = await obs.get('skill-trace'), spans = first.spans.filter(span => span.name.startsWith('skill.'));
    assert.deepEqual(spans.map(span => span.name), ['skill.workflow.started', 'skill.workflow.completed']);
    assert.equal(spans[0].attributes['ksadk.skill.run_id'], 'run');
    const reopened = createStudioObservability({ storeDir: store });
    assert.deepEqual((await reopened.get('skill-trace')).spans, first.spans);
    assert.ok((await reopened.getOtlp('skill-trace')).resourceSpans[0].scopeSpans[0].spans.some(span => span.name === 'skill.workflow.completed'));
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('syncTrace projects events into OTLP and persists', async () => {
  const store = await makeStore();
  const obs = createStudioObservability({ storeDir: store });
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const toolStartedAt = new Date(Date.now() - 50_000).toISOString();
  const toolCompletedAt = new Date(Date.now() - 40_000).toISOString();
  const completedAt = new Date(Date.now() - 30_000).toISOString();
  try {
    await obs.syncTrace({
      traceId: 'trace_abc', sessionId: 'ses-1', agentId: 'ar-1', agentName: 'My Agent',
      status: 'succeeded', startedAt, completedAt,
      events: [
        { seq: 1, event_type: 'turn.start', at: startedAt, run_id: 'run-1', session_id: 'ses-1', payload: {} },
        { seq: 2, event_type: 'tool.start', at: toolStartedAt, payload: { name: 'read_file' } },
        { seq: 3, event_type: 'tool.completed', at: toolCompletedAt, payload: { name: 'read_file' } },
        { seq: 4, event_type: 'turn.completed', at: completedAt, payload: { usage: { input_tokens: 100, output_tokens: 50 } } },
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
    assert.match(otlp.resourceSpans[0].scopeSpans[0].spans[0].traceId, /^[0-9a-f]{32}$/);
    assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans[0].kind, 1);
  } finally { await rm(store, { recursive: true, force: true }).catch(() => {}); }
});

test('overview and list filter by range and agentId', async () => {
  const store = await makeStore();
  const obs = createStudioObservability({ storeDir: store });
  const firstStartedAt = new Date(Date.now() - 60_000).toISOString();
  const firstCompletedAt = new Date(Date.now() - 50_000).toISOString();
  const secondStartedAt = new Date(Date.now() - 40_000).toISOString();
  const secondCompletedAt = new Date(Date.now() - 30_000).toISOString();
  try {
    await obs.syncTrace({ traceId: 't1', agentId: 'ar-1', agentName: 'A', status: 'succeeded', startedAt: firstStartedAt, completedAt: firstCompletedAt, events: [] });
    await obs.syncTrace({ traceId: 't2', agentId: 'ar-2', agentName: 'B', status: 'failed', startedAt: secondStartedAt, completedAt: secondCompletedAt, events: [] });
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

test('real trace rows expose measured duration, Run/Session search and completion metrics', async () => {
  const store = await makeStore(); const obs = createStudioObservability({ storeDir: store });
  try {
    const now = Date.now();
    const start = new Date(now-5000).toISOString(); const end = new Date(now-1000).toISOString();
    await obs.syncTrace({ traceId: 'local-trace', sessionId: 'session-canary', agentId: 'agent-canary', status: 'completed', startedAt: start, completedAt: end, events: [] });
    const rows = await obs.list({ query: 'session-canary' }); assert.equal(rows.items.length, 1); assert.equal(rows.items[0].durationMs, 4000);
    assert.equal(rows.items[0].totalTokens, null);
    const overview = await obs.overview({}); assert.equal(overview.successRate, 1); assert.equal(overview.avgDurationMs, 4000);
  } finally { await rm(store, { recursive: true, force: true }); }
});
