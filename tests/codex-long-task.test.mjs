import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexRuntime } from '../src/providers/codex-runtime.mjs';

function harness(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const requests = [];
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const notify = (method, params = {}) => send({ method, params: { threadId: 'thread', turnId: 'turn', ...params } });
  let killed = false;
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(data, _encoding, done) {
    const request = JSON.parse(String(data)); requests.push(request);
    if (request.method === 'initialize') send({ id: request.id, result: {} });
    if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread' } } });
    if (request.method === 'turn/start') send({ id: request.id, result: { turn: { id: 'turn' } } });
    done();
  } });
  const runtime = createCodexRuntime({ spawnImpl: () => child, ...options });
  const chunks = [];
  const run = async input => {
    try { for await (const chunk of runtime.stream({ input: 'complete the task', ...input })) chunks.push(chunk); return { ok: true }; }
    catch (error) { return { error }; }
  };
  return { run, notify, send, requests, chunks, get killed() { return killed; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('productive Codex turns survive the old three-minute wall-clock limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), result = h.run(); await settle();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(60_000);
    h.notify('item/agentMessage/delta', { itemId: 'progress', delta: `step ${i}` });
    await settle();
  }
  h.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(await result, { ok: true });
  assert.equal(h.chunks.filter(chunk => chunk.type === 'text').length, 5);
  assert.equal(h.killed, true);
});

test('a silent Codex turn times out and aborts a pending bound tool', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ idleTimeoutMs: 15_000 });
  let toolSignal;
  const result = h.run({ dynamicTools: [{ name: 'wait', inputSchema: { type: 'object' } }], toolHandler: async ({ signal }) => {
    toolSignal = signal; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } }); await settle();
  h.send({ id: 88, method: 'item/tool/call', params: { tool: 'wait', callId: 'call', arguments: {} } }); await settle();
  t.mock.timers.tick(15_001); await settle();
  t.mock.timers.tick(180_000); await settle();
  assert.equal((await result).error?.code, 'CODEX_IDLE_TIMEOUT');
  assert.equal(toolSignal.aborted, true);
  assert.equal(h.killed, true);
});

test('explicit total budgets remain enforced even while Codex makes progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ timeoutMs: 30_000, idleTimeoutMs: 20_000 }), result = h.run(); await settle();
  t.mock.timers.tick(15_000); h.notify('item/agentMessage/delta', { delta: 'working' }); await settle();
  t.mock.timers.tick(15_001); await settle();
  assert.equal((await result).error?.code, 'CODEX_TIMEOUT');
  assert.equal(h.killed, true);
});
