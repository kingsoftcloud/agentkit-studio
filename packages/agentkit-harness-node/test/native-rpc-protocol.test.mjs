// In-process protocol tests for the Native RPC entry. These exercise the
// ACTUAL bundled dist (dist/rpc-entry.mjs) against the ACTUAL core kernel and
// the real createNativeModelPort adapter — no mocked core. The model is a
// CONTROLLED local HTTP fixture (openai-chat format) on 127.0.0.1, so the same
// one-request adapter runs against it instead of a fake model port. No cloud,
// no real credentials; the fixture is clearly labeled and lives only in tests.
//
// Covers: initialize, happy/cancel/deny/budget runs, subscribe cursor resume,
// requestId idempotency (no re-run on retry), requestId conflict, the
// business-requestId-vs-jsonrpc-id separation, notifications (no response),
// and read-only startup (minimal permissions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '..');

// Resolve the declared public Core dependency normally. Tests never rewrite
// node_modules: concurrent process/protocol suites share the same installation.


const { createNativeRpcServer, buildStartup, RPC_PROTOCOL_VERSION } = await import('../dist/rpc-entry.mjs');
const { SqliteRunStore } = await import('../dist/index.mjs');
const { RpcRequestLedger } = await import('../src/rpc-ledger.mjs');

// ---- CONTROLLED openai-chat HTTP fixture (test-only, not part of the package) ----
function toolCall(id, name, args) {
  return { choices: [{ message: { role: 'assistant', content: '', tool_calls:
    [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
function final(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
const HANG = Symbol('hang');

function startFixture(script) {
  let call = 0;
  const server = createServer((req, res) => {
    call += 1;
    const step = script[Math.min(call - 1, script.length - 1)];
    if (step === HANG) return; // never respond; the kernel aborts via cancel/timeout
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(step));
  });
  return new Promise(resolveP => server.listen(0, '127.0.0.1', () => {
    resolveP({ port: server.address().port, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }),
      calls: () => call, server });
  }));
}

function applyModelEnv(port) {
  const env = {
    NATIVE_MODEL_PROTOCOL: 'openai-chat',
    NATIVE_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NATIVE_MODEL_API_KEY: 'test-key',
    NATIVE_MODEL_NAME: 'test-model',
    NATIVE_MODEL_COMPAT: 'controlled/v1',
    NATIVE_MODEL_MAX_TOKENS: '256',
    NATIVE_MODEL_REQUEST_TIMEOUT_MS: '3000',
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

async function withServer({ script, permissions, maxModelCalls = 8, leaseMs = 1000 }, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-proto-'));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'note.txt'), 'hello from note.txt', 'utf8');
  const fixture = await startFixture(script);
  const restoreEnv = applyModelEnv(fixture.port);
  const startup = buildStartup({
    workspace, permissions: permissions ?? 'workspace:read,workspace:write',
    owner: 'test', 'scope-tenant': 't', 'scope-workspace': 'w', 'scope-user': 'u', 'scope-agent': 'a',
    'lease-ms': String(leaseMs), 'effect-timeout-ms': '8000', 'request-timeout-ms': '3000',
    'max-model-calls': String(maxModelCalls),
    'exec-log': join(workspace, '.native-exec.log'),
  });
  const store = new SqliteRunStore(join(dir, 'run.sqlite'));
  const ledger = new RpcRequestLedger(join(dir, 'ledger.sqlite'));
  const server = createNativeRpcServer({ startup, store, ledger, owner: startup.owner });
  try { await fn({ server, fixture, workspace, dir, startup }); }
  finally {
    try { await server.dispose(); } catch {}
    await fixture.close();
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pollUntil(server, runId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await server.handle({ jsonrpc: '2.0', id: 'poll', method: 'task/status', params: { runId } });
    if (res.error) throw new Error(`status error: ${JSON.stringify(res.error)}`);
    if (predicate(res.result)) return res.result;
    await sleep(50);
  }
  throw new Error(`timed out waiting for run ${runId}`);
}
const isTerminal = r => r.terminal;

// ---- initialize --------------------------------------------------------------
test('initialize declares the protocol version and capabilities', async () => {
  await withServer({ script: [final('done')] }, async ({ server }) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, RPC_PROTOCOL_VERSION);
    assert.deepEqual(res.result.capabilities.methods,
      ['initialize', 'task/submit', 'task/status', 'task/subscribe', 'task/cancel', 'task/resume']);
    assert.ok(res.result.server.permissions.includes('workspace:read'));
    assert.ok(res.result.server.permissions.includes('workspace:write'));
    assert.deepEqual(res.result.server.tools, ['read', 'write']);
    assert.doesNotMatch(JSON.stringify(res), /test-key/); // no credentials leak
  });
});

// ---- happy: read -> write -> final ------------------------------------------
test('task/submit runs a happy read+write run to completion', async () => {
  const script = [
    toolCall('c1', 'read', { path: 'note.txt' }),
    toolCall('c2', 'write', { path: 'out.txt', content: 'written by rpc' }),
    final('done'),
  ];
  await withServer({ script }, async ({ server, fixture, workspace }) => {
    const submit = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'happy-1', objective: 'Read then write then finish.' } });
    assert.equal(submit.result.status, 'accepted');
    const runId = submit.result.runId;
    const r = await pollUntil(server, runId, isTerminal);
    assert.equal(r.phase, 'completed');
    assert.equal(r.outcome, 'unverified'); // no verification port installed
    assert.equal(fixture.calls(), 3, 'exactly three model calls (read, write, final)');
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'written by rpc');
  });
});

// ---- cancel: active model is canceled; receipt uncertain --------------------
test('task/cancel cancels an in-flight run without blocking', async () => {
  await withServer({ script: [HANG] }, async ({ server }) => {
    const submit = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'cancel-1', objective: 'hang then get canceled' } });
    const runId = submit.result.runId;
    await pollUntil(server, runId, r => r.driving, 2000);
    const cancel = await server.handle({ jsonrpc: '2.0', id: 'c1', method: 'task/cancel',
      params: { runId, commandId: 'cancel-1' } });
    assert.ok(['accepted', 'duplicate'].includes(cancel.result.status));
    const r = await pollUntil(server, runId, isTerminal);
    assert.equal(r.phase, 'canceled');
  });
});

// ---- deny: write without workspace:write is rejected -------------------------
test('a write tool is denied when workspace:write is not granted', async () => {
  const script = [toolCall('c1', 'write', { path: 'out.txt', content: 'x' }), final('done without write')];
  await withServer({ script, permissions: 'workspace:read' }, async ({ server, workspace }) => {
    const submit = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'deny-1', objective: 'try to write' } });
    const runId = submit.result.runId;
    const r = await pollUntil(server, runId, isTerminal);
    assert.equal(r.phase, 'failed', 'an unbound write must fail closed');
    assert.equal(r.outcome, 'blocked');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(workspace, 'out.txt')), false, 'denied write must not create out.txt');
  });
});

// ---- budget: maxModelCalls=1 + reserve rejects the tool call -----------------
test('a tool call past the finalization reserve fails with budget_exhausted', async () => {
  const script = [toolCall('c1', 'read', { path: 'note.txt' })];
  await withServer({ script, maxModelCalls: 1 }, async ({ server, fixture }) => {
    const submit = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'budget-1', objective: 'call a tool' } });
    const runId = submit.result.runId;
    const r = await pollUntil(server, runId, isTerminal);
    assert.equal(r.phase, 'failed');
    assert.equal(r.outcome, 'budget_exhausted');
    assert.equal(fixture.calls(), 1, 'the model is called once; the tool is never executed');
  });
});

// ---- requestId idempotency: a retry does NOT re-run the task -----------------
test('a retried requestId returns the stored response without re-running', async () => {
  const script = [toolCall('c1', 'read', { path: 'note.txt' }), final('done')];
  await withServer({ script }, async ({ server, fixture }) => {
    const submit1 = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'idem-1', objective: 'read then finish' } });
    const runId = submit1.result.runId;
    await pollUntil(server, runId, isTerminal);
    assert.equal(fixture.calls(), 2);
    // Retry with the same business requestId and same params: no re-run.
    const submit2 = await server.handle({ jsonrpc: '2.0', id: 'req-2', method: 'task/submit',
      params: { requestId: 'idem-1', objective: 'read then finish' } });
    assert.equal(submit2.result.status, 'completed');
    assert.equal(submit2.result.runId, runId);
    assert.equal(fixture.calls(), 2, 'the retry must not call the model again');
  });
});

// ---- requestId conflict: different params for the same id is rejected -------
test('a requestId reused with different parameters is rejected as a conflict', async () => {
  await withServer({ script: [HANG] }, async ({ server }) => {
    const submit1 = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'conflict-1', objective: 'A' } });
    await pollUntil(server, submit1.result.runId, r => r.driving, 2000);
    const submit2 = await server.handle({ jsonrpc: '2.0', id: 'req-2', method: 'task/submit',
      params: { requestId: 'conflict-1', objective: 'B' } });
    assert.equal(submit2.error.code, -32001, 'request_id_conflict');
    assert.equal(submit2.id, 'req-2'); // the JSON-RPC id is echoed, not the business requestId
  });
});

// ---- business requestId vs JSON-RPC id separation ----------------------------
test('a numeric JSON-RPC id does not collide with the string business requestId', async () => {
  await withServer({ script: [final('done')] }, async ({ server }) => {
    // Two submits with the SAME business requestId but different JSON-RPC ids:
    // the second is a retry (idempotent), not a conflict.
    const a = await server.handle({ jsonrpc: '2.0', id: 123, method: 'task/submit',
      params: { requestId: 'biz-1', objective: 'finish' } });
    const runId = a.result.runId;
    await pollUntil(server, runId, isTerminal);
    const b = await server.handle({ jsonrpc: '2.0', id: '123', method: 'task/submit',
      params: { requestId: 'biz-1', objective: 'finish' } });
    assert.equal(b.result.status, 'completed'); // idempotent, not a conflict
    assert.equal(b.id, '123'); // JSON-RPC id is echoed as-sent (string here)
    assert.equal(a.id, 123); // and number here — the two are NOT treated as the same key
  });
});

// ---- subscribe cursor: resume from a cursor after events --------------------
test('task/subscribe returns events after a cursor and marks terminal', async () => {
  const script = [toolCall('c1', 'read', { path: 'note.txt' }), final('done')];
  await withServer({ script }, async ({ server }) => {
    const submit = await server.handle({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
      params: { requestId: 'sub-1', objective: 'read then finish' } });
    const runId = submit.result.runId;
    const r = await pollUntil(server, runId, isTerminal);
    const sub0 = await server.handle({ jsonrpc: '2.0', id: 's0', method: 'task/subscribe',
      params: { runId, cursor: 0, waitMs: 100 } });
    assert.ok(sub0.result.events.length > 0, 'events must be present after completion');
    assert.equal(sub0.result.terminal, true);
    const midCursor = sub0.result.events[Math.floor(sub0.result.events.length / 2)].seq;
    const subMid = await server.handle({ jsonrpc: '2.0', id: 'sm', method: 'task/subscribe',
      params: { runId, cursor: midCursor, waitMs: 100 } });
    assert.ok(subMid.result.events.every(e => e.seq > midCursor), 'events must be after the cursor');
    assert.equal(subMid.result.terminal, true);
    assert.equal(subMid.result.cursor, r.eventSeq);
  });
});

// ---- notification: no `id` member => no response -----------------------------
test('a notification (no id) is processed but produces no response', async () => {
  await withServer({ script: [HANG] }, async ({ server }) => {
    const res = await server.handle({ jsonrpc: '2.0', method: 'task/cancel',
      params: { runId: 'never', commandId: 'n-1' } });
    // No id => notification => handle returns null (no response written).
    assert.equal(res, null);
    // A cancel for a non-existent run is a notification side effect; it throws
    // internally but is swallowed (notification errors go to stderr only).
  });
});

// ---- unknown method and invalid request -------------------------------------
test('unknown method returns method_not_found and bad jsonrpc returns invalid_request', async () => {
  await withServer({ script: [final('done')] }, async ({ server }) => {
    const res = await server.handle({ jsonrpc: '2.0', id: 9, method: 'no/such' });
    assert.equal(res.error.code, -32601);
    const bad = await server.handle({ jsonrpc: '1.0', id: 9, method: 'initialize' });
    assert.equal(bad.error.code, -32600);
  });
});

// ---- param validation: missing requestId / objective -------------------------
test('missing requestId or objective is invalid_params and leaves no pending row', async () => {
  await withServer({ script: [final('done')] }, async ({ server, startup }) => {
    const noId = await server.handle({ jsonrpc: '2.0', id: 'x1', method: 'task/submit', params: { objective: 'o' } });
    assert.equal(noId.error.code, -32602);
    const noObj = await server.handle({ jsonrpc: '2.0', id: 'x2', method: 'task/submit', params: { requestId: 'r' } });
    assert.equal(noObj.error.code, -32602);
    // Neither invalid request wrote a ledger row.
    assert.equal(server.ledger.lookup('r'), null);
    assert.equal(server.ledger.lookup('x1'), null);
  });
});

// ---- read-only startup: a write tool is denied even if requested ------------
test('read-only startup grants only workspace:read and denies writes', async () => {
  await withServer({ script: [final('done')], permissions: 'workspace:read' }, async ({ server }) => {
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.deepEqual(init.result.server.permissions, ['workspace:read']);
    assert.deepEqual(init.result.server.tools, ['read']);
  });
});

test('startup defaults are valid and grant no tools; explicit empty grants stay empty', async () => {
  await withServer({ script: [final('done')], permissions: '' }, async ({ server, startup }) => {
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.deepEqual(init.result.server.tools, []);
    const defaults = buildStartup({ workspace: startup.workspaceDir });
    assert.equal(defaults.limits.effectTimeoutMs, 60000);
    assert.deepEqual([...defaults.granted], []);
    assert.throws(() => buildStartup({ workspace: startup.workspaceDir, permissions: 'admin' }), /unknown workspace permission/);
  });
});

test('model binding is frozen, and changed workspace binding cannot resume an existing task', async () => {
  await withServer({ script: [final('done')] }, async ({ server, startup, fixture }) => {
    const old = process.env.NATIVE_MODEL_API_KEY;
    process.env.NATIVE_MODEL_API_KEY = 'changed-after-start';
    try {
      const submit = await server.handle({ jsonrpc: '2.0', id: 1, method: 'task/submit',
        params: { requestId: 'frozen', objective: 'finish' } });
      await pollUntil(server, submit.result.runId, isTerminal);
      assert.equal(fixture.calls(), 1);
      const changed = { ...startup, hostBindingDigest: 'changed' };
      const other = createNativeRpcServer({ startup: changed, store: server.store, ledger: server.ledger });
      const resumed = await other.handle({ jsonrpc: '2.0', id: 2, method: 'task/resume', params: { runId: submit.result.runId } });
      assert.equal(resumed.error.code, -32004);
      const retried = await other.handle({ jsonrpc: '2.0', id: 3, method: 'task/submit', params: { requestId: 'frozen', objective: 'finish' } });
      assert.equal(retried.error.code, -32004);
      assert.equal(fixture.calls(), 1);
    } finally { process.env.NATIVE_MODEL_API_KEY = old; }
  });
});

test('invalid cursors, wait bounds, message ids and unknown submit parameters are rejected', async () => {
  await withServer({ script: [final('done')] }, async ({ server }) => {
    for (const waitMs of ['0', -1, 60001, null]) {
      const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'task/subscribe', params: { runId: 'none', waitMs } });
      assert.equal(res.error.code, -32602);
    }
    const badId = await server.handle({ jsonrpc: '2.0', id: {}, method: 'initialize' });
    assert.equal(badId.error.code, -32600);
    const badSubmit = await server.handle({ jsonrpc: '2.0', id: 2, method: 'task/submit', params: { requestId: 'x', objective: 'x', permissions: ['workspace:write'] } });
    assert.equal(badSubmit.error.code, -32602);
    assert.equal(server.ledger.lookup('x'), null);
  });
});
