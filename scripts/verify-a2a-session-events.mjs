/** Exercise the production sink against the actual maintained Session store and
 * projection registry. Local HTTP peers provide only remote A2A services. The
 * persistence listener below is a declared file-backed test carrier, not the
 * full Studio persistence plugin (the mounted Host verifier covers that). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { dshPresetId } from '../src/agent-preset-admission.mjs';
import { createStudioA2aSessionSink, A2A_SESSION_CONTRACT, A2A_SESSION_PROJECTION, A2A_SESSION_EVENT } from '../src/host/services/a2a-session-events.mjs';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../src/providers/native-a2a-host.mjs';
import { internalPeer, scope, spec } from '../tests/fixtures/native-a2a-internal-peer.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' } } });
assert.ok(values.source, '--source <built maintained DSH checkout> is required');
const source = resolve(values.source), require = createRequire(join(source, 'packages/core/session/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { default: SessionStore } = await import(pathToFileURL(join(source, 'packages/core/session/lib/index.js')).href);
const { default: Projections } = await import(pathToFileURL(join(source, 'packages/session/session-projection/lib/index.js')).href);
const { agentPresetProjectionDefinition } = await import(pathToFileURL(join(source, 'packages/preset/agent-preset-registry/lib/index.js')).href);
const signal = () => new AbortController().signal;
const sourceKey = 'a'.repeat(64), owner = { scope, sessionId: 'logical-child' };
function fact(seq, change = {}) {
  return { schema_version: 2, event_id: 'remote-' + seq, seq, timestamp: 1, run_id: 'run', scope_id: 'child',
    event_type: 'item.started', item_id: 'message', item_kind: 'message', ...change };
}
async function harness(t, { seed, preset = dshPresetId('agent', 1), flush = true } = {}) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(Projections);
  ctx.sessionProjections.register(agentPresetProjectionDefinition);
  // Read through a registered fold, including constructor resume markers;
  // never call the deprecated synchronous Session event accessors.
  ctx.sessionProjections.register({ key: 'verificationLog', stateVersion: 1, init: () => [],
    apply: (state, event) => [...state, event], stateSchema: { parse: value => value } });
  const session = ctx.sessions.create('session', { ...(seed ? { seed } : {}), meta: { agentPreset: preset } });
  const log = () => ctx.sessionProjections.stateOf(session, 'verificationLog');
  const sink = createStudioA2aSessionSink({ ctx }), writer = sink.forPreset({ agentId: 'agent' });
  t.after(async () => { await sink.close(); await ctx.fiber.dispose(); });
  let flushCalls = 0, durable = seed?.slice() ?? [], mode = flush;
  const stopFlush = ctx.on('session/flush', selected => {
    assert.equal(selected, session); flushCalls++;
    if (mode instanceof Error) throw mode;
    if (typeof mode === 'function') return mode();
    durable = log().slice();
  });
  if (!flush) stopFlush();
  return { ctx, session, sink, writer, get log() { return log(); }, get durable() { return durable; }, get flushCalls() { return flushCalls; },
    setMode(value) { mode = value; },
    write(events = [fact(1)], extra = {}) { return writer.write({ owner, destinationSessionId: 'session', sourceKey, events, signal: signal(), ...extra }); } };
}

await test('actual Session global seq, concurrent sources, no model history and lossless canonical content', async t => {
  const f = await harness(t);
  const first = fact(1, { initial: { parts: [{ content_type: 'data', data: { value: -0, text: 'accepted' } }] } });
  const [a, b] = await Promise.all([f.write([first]), f.write([fact(1)], { sourceKey: 'b'.repeat(64) })]);
  assert.equal(a.sessionSeq, 0); assert.equal(b.sessionSeq, 1);
  assert.ok(Object.is(JSON.parse(f.log[0].data.eventJson).initial.parts[0].data.value, -0));
  assert.deepEqual(f.session.deriveMessages(), []); assert.equal(f.session.surface.nodes.length, 0);
  assert.ok(f.log.every(e => e.ignorable && !e.surfaceOp && !e.sourceEventSeqs));
  const duplicate = await f.write([first]); assert.equal(duplicate.sessionSeq, 0);
  assert.equal(f.log.length, 2); assert.equal(f.flushCalls, 3); assert.equal(f.durable.length, 2);
  const restored = await harness(t, { seed: f.durable });
  assert.equal((await restored.write([first])).sessionSeq, 0);
  assert.equal(restored.log.filter(e => e.type === A2A_SESSION_EVENT).length, 2);
  assert.equal(restored.ctx.sessionProjections.stateOf(restored.session, A2A_SESSION_PROJECTION).sources[sourceKey].through, 1);
});
await test('lost flush acknowledgement retries without appending again, and still performs a durability barrier', async t => {
  const f = await harness(t, { flush: new Error('carrier unavailable') });
  await assert.rejects(f.write(), /carrier unavailable/); assert.equal(f.log.length, 1); assert.equal(f.durable.length, 0);
  f.setMode(true); await f.write(); assert.equal(f.log.length, 1); assert.equal(f.durable.length, 1); assert.equal(f.flushCalls, 2);
  const missing = await harness(t, { flush: false });
  await assert.rejects(missing.write(), { code: 'A2A_SESSION_NOT_DURABLE' });
});
await test('preset drift, wrong DSH destination, content conflict and sequence gaps fail closed', async t => {
  const f = await harness(t); await f.write();
  await assert.rejects(f.write([fact(1, { timestamp: 9 })]), { code: 'A2A_SESSION_EVENT_CONFLICT' });
  await assert.rejects(f.write([fact(3)]), { code: 'A2A_SESSION_SEQUENCE_GAP' });
  assert.throws(() => f.write([fact(2)], { owner: { agentId: 'agent', agentRevision: 1, buildId: null, sessionId: 'other' } }),
    { code: 'A2A_SESSION_OWNER_CONFLICT' });
  const drift = await harness(t, { preset: dshPresetId('agent', 2) });
  await assert.rejects(drift.write(), { code: 'A2A_SESSION_PRESET_CHANGED' }); assert.equal(drift.log.length, 0);
});
await test('retirement aborts a noncooperative flush and cannot acknowledge its late success', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await harness(t, { flush: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  const write = f.write(); await started; const failed = assert.rejects(write, { name: 'AbortError' });
  await f.sink.close(); await failed; finish();
  assert.throws(() => f.write(), { code: 'A2A_SESSION_SINK_CLOSED' });
});
await test('Frozen revision and Build remain pinned; a replaced live Session cannot receive a late acknowledgement', async t => {
  const f = await harness(t, { preset: dshPresetId('agent', 3, 'build-1') });
  const writer = f.sink.forPreset({ agentId: 'agent', agentRevision: 3, buildId: 'build-1' });
  const args = { owner: { agentId: 'agent', agentRevision: 3, buildId: 'build-1', sessionId: 'session' },
    sourceKey, events: [fact(1)], signal: signal() };
  assert.equal((await writer.write(args)).sessionSeq, 0);
  assert.throws(() => writer.write({ ...args, owner: { ...args.owner, buildId: 'build-2' } }), { code: 'A2A_SESSION_OWNER_CONFLICT' });
  let finish, entered; const started = new Promise(resolve => { entered = resolve; });
  f.setMode(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const pending = writer.write({ ...args, events: [fact(2)] }); await started;
  // Real store disposal detaches this exact Session; the completed flush must
  // not be mistaken for a receipt from a currently admitted live Session.
  await f.ctx.fiber.dispose(); const rejected = assert.rejects(pending); finish(); await rejected;
});

for (const dsh of [false, true]) await test(`${dsh ? 'DSH' : 'Native child'} original journal consumes into actual Session, reopens with no task replay`, async t => {
  const peer = await internalPeer(), f = await harness(t), prepare = dsh ? prepareDshA2AHost : prepareNativeA2AHost;
  const fields = dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope: { ...scope, agentId: 'agent:child:research' } };
  const sessionId = dsh ? 'session' : 'logical-child';
  let available = false, badReceipt = true;
  const receiver = { contract: A2A_SESSION_CONTRACT, async write(args) {
    if (!available) throw new Error('session not opened');
    const receipt = await f.writer.write(args);
    return badReceipt ? { ...receipt, through: receipt.through + 1 } : receipt;
  } };
  const factory = prepare({ env: peer.env, bindings: [spec], sessionEvents: receiver });
  t.after(async () => { await factory.close(); await peer.close(); });
  const admission = { ...fields, sessionId, stateRoot: join(peer.root, 'state'), workspaceRoot: peer.workspaceRoot,
    destinationSessionId: 'session', assertCurrent: () => true };
  const port = factory.forSession(admission); peer.owners.push(port);
  const request = await port.invocation.resolve({ agent: 'research', message: 'hello', signal: signal(),
    [dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId, ...(dsh ? {} : { runId: 'run' }),
      operationKey: 'operation', call: { callId: 'call' } } });
  assert.equal((await port.invocation.dispatch({ request, signal: signal() })).state, 'completed');
  await port.eventDelivery.flush(); await port.eventDelivery.flushSession({ raiseOnError: false });
  const original = peer.record(), immutable = canonical(original.managed.events.log), calls = peer.calls.length;
  assert.equal(original.managed.events.pending.length, 0); assert.equal(original.managed.events.sessionDelivery, undefined);
  assert.equal(original.sessionDestination, 'session'); assert.equal(f.log.length, 0);
  await factory.close(); available = true;
  const restored = prepare({ env: peer.env, bindings: [spec], sessionEvents: receiver }); t.after(() => restored.close());
  assert.equal(restored.restoreEvents({ stateRoot: join(peer.root, 'state'), workspaceRoot: peer.workspaceRoot }), 1);
  const originalPort = restored.forSession(admission);
  assert.equal((await originalPort.eventDelivery.flushSession({ raiseOnError: false })).pending, true);
  assert.equal(peer.record().managed.events.sessionDelivery, undefined, 'mismatched sink acknowledgement cannot advance source cursor');
  badReceipt = false; await originalPort.eventDelivery.flushSession();
  assert.equal(peer.calls.length, calls, 'delivery restoration does not prepare, send, read, bind or append remotely');
  const delivered = peer.record(); assert.equal(delivered.managed.events.sessionDelivery.through, delivered.managed.events.nextSeq - 1);
  assert.equal(canonical(delivered.managed.events.log), immutable); assert.equal(f.log.length, delivered.managed.events.log.length);
  assert.deepEqual(f.log.map(e => e.seq), Array.from({ length: f.log.length }, (_, i) => i));
  assert.ok(f.log.every(e => e.type === A2A_SESSION_EVENT && e.data.owner.sessionId === 'session'));
  assert.deepEqual(f.session.deriveMessages(), []);
  assert.equal((await originalPort.eventDelivery.flushSession()).pending, false);
});

function worker(peer, options) {
  const child = fork(new URL('../tests/fixtures/a2a-session-crash-worker.mjs', import.meta.url), [],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), messages = [];
  let stderr = '', reached;
  const boundary = new Promise(resolve => { reached = resolve; });
  child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => { messages.push(message); if (message.type === 'boundary') reached(message); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid, stderr }));
  });
  child.send({ source, root: peer.root, workspaceRoot: peer.workspaceRoot, env: peer.env, ...options });
  return { child, messages, exit, boundary };
}
for (const dsh of [false, true]) for (const boundary of ['before-flush', 'after-flush']) await test(
  `${dsh ? 'DSH' : 'Native'} SIGKILL ${boundary}: cold Session delivery recovers without remote task effects`, { timeout: 15000 }, async t => {
    const peer = await internalPeer(); t.after(() => peer.close());
    const initial = worker(peer, { dsh, boundary, action: 'dispatch' }); t.after(() => initial.child.kill('SIGKILL'));
    await Promise.race([initial.boundary, initial.exit.then(value => assert.fail('worker exited before fault gate: ' + JSON.stringify({ value, messages: initial.messages })))]);
    const original = peer.record(), calls = peer.calls.length, journal = canonical(original.managed.events.log);
    assert.equal(original.phase, 'terminal'); assert.equal(original.managed.events.pending.length, 0);
    assert.equal(original.managed.events.sessionDelivery, undefined);
    const path = join(peer.root, 'session-durable.json');
    assert.equal(existsSync(path), boundary === 'after-flush');
    if (boundary === 'after-flush') assert.ok(JSON.parse(readFileSync(path, 'utf8')).events.length > 0);
    initial.child.kill('SIGKILL'); const killed = await initial.exit; assert.equal(killed.signal, 'SIGKILL');
    const cold = worker(peer, { dsh, boundary, action: 'restore' }); t.after(() => cold.child.kill('SIGKILL'));
    const exited = await cold.exit; assert.equal(exited.code, 0, JSON.stringify({ exited, messages: cold.messages }));
    assert.notEqual(exited.pid, killed.pid); assert.equal(peer.calls.length, calls);
    const delivered = peer.record(), message = cold.messages.find(value => value.type === 'restored');
    assert.equal(message.restored, 1); assert.equal(message.receipt.pending, false);
    const observations = message.events.filter(e => e.type === A2A_SESSION_EVENT);
    assert.equal(observations.length, original.managed.events.log.length);
    assert.equal(new Set(observations.map(e => e.data.eventId)).size, observations.length);
    assert.deepEqual(observations.map(e => e.data.eventJson), original.managed.events.log.map(canonical));
    assert.equal(delivered.managed.events.sessionDelivery.through, delivered.managed.events.nextSeq - 1);
    assert.equal(canonical(delivered.managed.events.log), journal);
    const final = canonical(delivered), third = worker(peer, { dsh, boundary, action: 'restore' });
    const again = await third.exit; assert.equal(again.code, 0, JSON.stringify({ again, messages: third.messages }));
    assert.equal(third.messages.find(value => value.type === 'restored').restored, 0);
    assert.equal(canonical(peer.record()), final); assert.equal(peer.calls.length, calls);
    t.diagnostic(JSON.stringify({ dsh, boundary, killedPid: killed.pid, coldPid: exited.pid, thirdPid: again.pid,
      immutableEvents: observations.length, localPending: 0, extraRemoteCalls: 0 }));
  });
