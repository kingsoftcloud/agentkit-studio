// Multi-turn integration tests for the OpenAI Responses adapter: real
// NativeKernel + SQLite store + compiled core + local HTTP.
//
// These drive the full kernel loop (model -> tools -> verify) against a local
// HTTP server streaming controlled Responses SSE bytes, not mocked fetch and
// not just adapter-internal shapes. They cover the tool replay round-trip
// through the kernel (function_call <-> function_call_output canonical
// pairing), final submission via submit_final_output, and bad-argument
// non-execution (wireArgumentsInvalid). The store is the real SqliteRunStore
// (node:sqlite, :memory:); the core is imported read-only via the sibling
// package path (the same relative import the SQLite store uses).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  configure, NativeKernel, canonical, toolInputRejection,
} from '../../agentkit-harness-core/dist/index.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (d) => `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`;
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

// Responses wire builders.
const rcreated = (id = 'resp-1', model = 'fake-model') => ({ type: 'response.created', response: { id, model } });
const fcallAdded = (idx, itemId, callId, name) => ({ type: 'response.output_item.added', output_index: idx, item: { type: 'function_call', id: itemId, call_id: callId, name, arguments: '' } });
const fcallDone = (idx, item) => ({ type: 'response.output_item.done', output_index: idx, item });
const rcompleted = (id, model, usage, output) => ({ type: 'response.completed', response: { id, model, ...(usage ? { usage } : {}), ...(output ? { output } : {}) } });

function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push(body);
    let spec;
    try { spec = await handler(req, body, requests.length - 1); }
    catch (e) { spec = { status: 500, body: String(e && e.message || e) }; }
    try { res.writeHead(spec.status || 200, spec.headers || {}); res.flushHeaders(); } catch { return; }
    const b = spec.body;
    if (b == null) { try { res.end(); } catch {} return; }
    if (typeof b === 'string' || Buffer.isBuffer(b)) { try { res.end(b); } catch {} return; }
    try { for await (const item of b) { if (res.writableEnded) break; res.write(item); } } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
  });
  server.keepAliveTimeout = 300;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

function makeConfig({ replayMode = 'none' } = {}) {
  return configure({
    profile: {
      profileId: 'p1', profileVersion: '1', providerFamily: 'openai-compatible',
      compatibilityDigest: 'a'.repeat(64), providerReplayMode: replayMode,
      maxOutputTokens: 1024, contextWindow: 8000, requestTimeoutMs: 8000,
    },
    contract: {
      objective: 'Read the file and submit the answer',
      revision: '1',
      acceptance: [{ id: 'a1', required: true, verifierRef: 'v1', verifierVersion: '1', verificationMethod: 'deterministic', description: 'answer correct' }],
      finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      finalSubmissionPayloadKey: 'answer',
      finalOutputFormat: 'text',
    },
    tools: [{
      name: 'read', description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 5000,
      contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal',
    }],
    limits: { maxModelCalls: 10, finalizationReserveModelCalls: 1, maxToolCalls: 10, maxRepairs: 3 },
    hostBindingDigest: 'host-binding-1',
    instructions: 'Be concise.',
  });
}

function makeKernel({ store, modelPort, toolExecutor, verifier }) {
  return new NativeKernel({
    store,
    owner: 'test-worker',
    ports: {
      model: modelPort,
      tools: { execute: toolExecutor },
      verification: { verify: verifier },
    },
    digest: (v) => crypto.createHash('sha256').update(canonical(v)).digest('hex'),
  });
}

function identity() {
  return {
    scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
    runId: 'run-1', sessionId: 'sess-1', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'tc-1',
  };
}

function passingVerifier() {
  return async (req) => {
    const c = req.candidate;
    return {
      status: 'passed', reason: 'ok', candidateId: c.candidateId, contractRevision: '1',
      binding: c.binding, workspaceDependency: 'none', workspaceRevision: c.workspaceRevision,
      checks: [{ id: 'a1', status: 'passed', evidence: 'done', evidenceRefs: ['e1'], verifierId: 'v1', verifierVersion: '1', verificationMethod: 'deterministic' }],
    };
  };
}

test('integration: responses tool loop round-trips through NativeKernel+SQLite and completes verified', async () => {
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      // Turn 1: a read function_call.
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(rcreated('resp-1')),
        sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
        sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: '{"path":"a.txt"}' }),
        sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' })),
        sse(rcompleted('resp-1', 'fake-model', { input_tokens: 4, output_tokens: 3 },
          [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' }])),
      ] };
    }
    // Turn 2: the prior tool receipt must be projected as a function_call_output
    // whose call_id pairs with the assistant function_call (canonical pairing).
    assert.ok(body.includes('"type":"function_call_output"'), 'turn 2 must project the tool receipt as function_call_output');
    assert.ok(body.includes('"call_id":"call-1"'), 'the function_call_output call_id must pair with the function_call');
    return { status: 200, headers: SSE_HEADERS, body: [
      sse(rcreated('resp-2')),
      sse(fcallAdded(0, 'fc-2', 'call-2', 'submit_final_output')),
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-2', delta: '{"answer":"42"}' }),
      sse(fcallDone(0, { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'submit_final_output', arguments: '{"answer":"42"}' })),
      sse(rcompleted('resp-2', 'fake-model', { input_tokens: 6, output_tokens: 2 },
        [{ type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'submit_final_output', arguments: '{"answer":"42"}' }])),
      ] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    let readCalls = 0;
    const kernel = makeKernel({
      store: new SqliteRunStore(':memory:'),
      modelPort,
      toolExecutor: async (req) => {
        const rejection = toolInputRejection(req.definition, req.call);
        if (rejection) return { status: 'error', content: rejection };
        readCalls++;
        return { status: 'ok', content: 'file contents: 42' };
      },
      verifier: passingVerifier(),
    });
    const id = identity();
    kernel.start(id, makeConfig());
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.outcome, 'verified');
    assert.equal(readCalls, 1, 'read executed exactly once');
    assert.equal(snapshot.finalText, '42');
  } finally {
    await server.close();
  }
});

test('integration: responses bad-argument tool call is not executed and the run still completes', async () => {
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      // Turn 1: read function_call with INVALID argument JSON -> wireArgumentsInvalid.
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(rcreated('resp-1')),
        sse(fcallAdded(0, 'fc-1', 'call-1', 'read')),
        sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: '{"path":' }),
        sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":' })),
        sse(rcompleted('resp-1', 'fake-model', { input_tokens: 3, output_tokens: 2 },
          [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read', arguments: '{"path":' }])),
      ] };
    }
    // Turn 2: submit the final answer (after the non-executed tool error).
    return { status: 200, headers: SSE_HEADERS, body: [
      sse(rcreated('resp-2')),
      sse(fcallAdded(0, 'fc-2', 'call-2', 'submit_final_output')),
      sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-2', delta: '{"answer":"ok"}' }),
      sse(fcallDone(0, { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'submit_final_output', arguments: '{"answer":"ok"}' })),
      sse(rcompleted('resp-2', 'fake-model', { input_tokens: 5, output_tokens: 2 },
        [{ type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'submit_final_output', arguments: '{"answer":"ok"}' }])),
    ] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    let readExecutions = 0;
    const kernel = makeKernel({
      store: new SqliteRunStore(':memory:'),
      modelPort,
      toolExecutor: async (req) => {
        const rejection = toolInputRejection(req.definition, req.call);
        if (rejection) return { status: 'error', content: rejection };
        readExecutions++;
        return { status: 'ok', content: 'x' };
      },
      verifier: passingVerifier(),
    });
    const id = identity();
    kernel.start(id, makeConfig());
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(readExecutions, 0, 'the invalid-argument read was never executed');
    assert.equal(snapshot.finalText, 'ok');
    assert.ok(snapshot.messages.some((m) => m.role === 'tool' && m.content.includes('wire_arguments_invalid')),
      'ledger must record the non-execution tool error');
  } finally {
    await server.close();
  }
});

test('integration: responses finalization-only turn keeps submit_final_output on the wire', async () => {
  // Force a finalization-only turn by exhausting the model budget to the
  // reserve: maxModelCalls=2, finalizationReserveModelCalls=2 -> the very first
  // model call is finalization-only, so only submit_final_output is advertised.
  const server = await startServer((req, body, idx) => {
    if (idx === 0) {
      assert.ok(body.includes('submit_final_output'), 'finalization-only turn must advertise submit_final_output');
      assert.ok(!body.includes('"name":"read"'), 'finalization-only turn must not advertise normal tools');
      return { status: 200, headers: SSE_HEADERS, body: [
        sse(rcreated('resp-1')),
        sse(fcallAdded(0, 'fc-1', 'call-1', 'submit_final_output')),
        sse({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc-1', delta: '{"answer":"final"}' }),
        sse(fcallDone(0, { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'submit_final_output', arguments: '{"answer":"final"}' })),
        sse(rcompleted('resp-1', 'fake-model', { input_tokens: 4, output_tokens: 2 },
          [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'submit_final_output', arguments: '{"answer":"final"}' }])),
      ] };
    }
    return { status: 200, headers: SSE_HEADERS, body: [
      sse(rcreated('resp-2')), sse(rcreated()),
      sse({ type: 'response.output_text.delta', response_id: 'resp-2', delta: 'final' }),
      sse(rcompleted('resp-2', 'fake-model', { input_tokens: 2, output_tokens: 1 },
        [{ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'final' }] }])),
    ] };
  });
  try {
    const modelPort = createNativeModelPort({
      resolveProfile: async () => ({ protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fake-key', model: 'fake-model' }),
      fetchImpl: fetch, maxResponseBytes: 1024 * 1024, idleTimeoutMs: 8000,
    });
    const kernel = makeKernel({
      store: new SqliteRunStore(':memory:'),
      modelPort,
      toolExecutor: async () => ({ status: 'ok', content: 'x' }),
      verifier: passingVerifier(),
    });
    const config = configure({
      profile: { profileId: 'p1', profileVersion: '1', providerFamily: 'openai-compatible',
        compatibilityDigest: 'a'.repeat(64), providerReplayMode: 'none', maxOutputTokens: 1024, contextWindow: 8000, requestTimeoutMs: 8000 },
      contract: { objective: 'Submit', revision: '1',
        acceptance: [{ id: 'a1', required: true, verifierRef: 'v1', verifierVersion: '1', verificationMethod: 'deterministic', description: 'ok' }],
        finalSubmissionSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
        finalSubmissionPayloadKey: 'answer', finalOutputFormat: 'text' },
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        readOnly: true, concurrentSafe: false, permissions: [], timeoutMs: 5000,
        contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }],
      limits: { maxModelCalls: 2, finalizationReserveModelCalls: 2, maxToolCalls: 10, maxRepairs: 3 },
      hostBindingDigest: 'host-binding-1', instructions: '',
    });
    const id = identity();
    kernel.start(id, config);
    const snapshot = await kernel.runUntilIdle(id.scope, id.runId, { waitForRetry: false });
    assert.equal(snapshot.phase, 'completed');
    assert.equal(snapshot.finalText, 'final');
  } finally {
    await server.close();
  }
});
