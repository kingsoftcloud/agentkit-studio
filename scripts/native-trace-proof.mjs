/** Observe actual mounted Host routes; these reads never advance a Native Run. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createNativeTraceProof() {
  const saved = new Map();
  return { async verify(root, runId) {
    const { origin, cookie } = JSON.parse(await readFile(join(root, 'mounted-host-connection.json'), 'utf8'));
    const rpc = async (method, payload) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const result = (await response.json()).result; assert.equal(result?.ok, true, method); return result.value;
    };
    let item;
    const deadline = Date.now() + 5000;
    do {
      item = (await rpc('traces/list', { query: runId })).items.find(value => value.runId === runId && value.status === 'completed');
      if (item) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.ok(item, 'Actual mounted Host must expose its committed Native Run through the Studio trace route');
    const trace = await rpc('traces/get', { traceId: item.traceId });
    assert.equal(trace.runId, runId); assert.equal(trace.sessionId, 'native-studio-session');
    assert.equal(trace.status, 'completed'); assert.equal(trace.provenance.nativeProjection.runId, runId);
    assert.equal(trace.provenance.nativeProjection.source, 'durable-native-ledger');
    assert.deepEqual(trace.tokenUsage, { inputTokens: 10, outputTokens: 14, totalTokens: 24 });
    assert.ok(trace.events.length > 2);
    assert.equal(new Set(trace.events.map(event => event.native_event_id)).size, trace.events.length);
    assert.ok(trace.events.every(event => event.run_id === runId && event.timing_source === 'projection_observed'));
    assert.ok(trace.spans.some(span => span.name.startsWith('model.')));
    assert.ok(trace.spans.some(span => span.name.startsWith('tool.')));
    assert.equal(JSON.stringify(trace).includes('sk-studio-fixture-secret'), false);
    const otlp = await rpc('traces/otlp', { traceId: item.traceId });
    assert.deepEqual(otlp, trace.otlp);
    for (const [traceId, previous] of saved) assert.deepEqual(await rpc('traces/get', { traceId }), previous,
      'Later turns and actual Host restart must not rewrite earlier Native trace identity, timings or facts');
    saved.set(trace.traceId, trace);
    await writeFile(join(root, 'native-trace-route-proof.json'),
      JSON.stringify({ passed: true, runs: [...saved.values()].map(value => ({ runId: value.runId, traceId: value.traceId,
        eventSeq: value.provenance.nativeProjection.eventSeq, tokenUsage: value.tokenUsage, spanCount: value.spanCount })),
        scope: 'Actual mounted Host authenticated trace list/detail/OTLP routes across process restart; browser rendering is separate.' }, null, 2));
  } };
}
