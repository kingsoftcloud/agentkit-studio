import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NativeKernel, MemoryRunStore, configure, canonical, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';

const scope = { tenantId: 'inbox-tenant', workspaceId: 'inbox-workspace', userId: 'inbox-user', agentId: 'inbox-agent' };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const input = index => ({ injectionId: `event-${index}`, text: `External record ${index}`, source: { kind: 'channel', ref: `record-${index}` } });
const identity = (runId, sessionId = 'inbox-session') => ({ scope, runId, sessionId, turnId: runId,
  buildId: 'inbox-build', parentRunId: null, taskChainId: runId });
const config = (options = {}) => configure({ profile: { profileId: 'inbox', profileVersion: '1',
  providerFamily: 'fixture', compatibilityDigest: 'inbox/v1' }, contract: { objective: 'Read the available records' },
  inputMessages: [{ role: 'user', content: 'Use the records to answer my question.' }],
  hostBindingDigest: 'inbox-host/v1', sessionInjectionPolicy: 'next-turn-inbox/v1', ...options });
const answer = () => ({ kind: 'final_candidate', text: 'Records reviewed.', toolCalls: [], usage: emptyUsage() });
const injections = messages => messages.filter(message => message.kind === 'session_injection').map(message => JSON.parse(message.content));
function harness(t, backend, generate = async () => answer()) {
  const directory = mkdtempSync(join(tmpdir(), 'native-session-inbox-')), filename = join(directory, 'runs.sqlite');
  const store = backend === 'memory' ? new MemoryRunStore() : new SqliteRunStore(filename);
  const requests = [];
  const kernel = new NativeKernel({ store, owner: 'inbox-test', digest: hash, ports: {
    model: { generate: async request => { requests.push(request); return generate(request); } },
    tools: { execute: async () => assert.fail('Injection cannot dispatch tools') },
  } });
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { store, kernel, requests, filename };
}

for (const backend of ['memory', 'sqlite']) {
  test(`${backend}: C2 accepts 100 records with zero model calls and delivers them in order on the next wake`, async t => {
    const f = harness(t, backend);
    for (let index = 0; index < 100; index++) assert.deepEqual(f.store.inject(scope, 'inbox-session', input(index)), {
      injectionId: `event-${index}`, sequence: index + 1, status: 'accepted', consumedBy: null,
    });
    assert.equal(f.requests.length, 0); assert.deepEqual(f.store.list(scope), []);
    const initial = f.kernel.start(identity('wake-1'), config());
    assert.equal(initial.sessionInjections.length, 100); assert.equal(f.requests.length, 0);
    await f.kernel.runUntilIdle(scope, 'wake-1');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(injections(f.requests[0].messages).map(row => row.text), Array.from({ length: 100 }, (_, index) => input(index).text));
    assert.equal(f.requests[0].messages.filter(message => message.kind === 'session_injection').every(message => message.role === 'user'), true);
    assert.equal(f.requests[0].messages.at(-1).content, config().inputMessages[0].content);
    assert.deepEqual(f.store.inject(scope, 'inbox-session', input(0)), {
      injectionId: 'event-0', sequence: 1, status: 'duplicate', consumedBy: 'wake-1',
    });
    const next = f.kernel.start(identity('wake-2'), config());
    assert.equal(next.sessionInjections, undefined);
    assert.equal(next.messages.filter(message => message.kind === 'session_injection' && message.history).length, 100);
  });

  test(`${backend}: duplicates, payload conflicts and all scope dimensions are isolated`, async t => {
    const f = harness(t, backend);
    f.store.inject(scope, 'inbox-session', input(0));
    assert.equal(f.store.inject(scope, 'inbox-session', input(0)).status, 'duplicate');
    assert.throws(() => f.store.inject(scope, 'inbox-session', { ...input(0), text: 'Changed record' }), { code: 'session_injection_conflict' });
    for (const key of Object.keys(scope)) f.store.inject({ ...scope, [key]: 'foreign' }, 'inbox-session', input(1));
    f.store.inject(scope, 'other-session', input(2));
    const snapshot = f.kernel.start(identity('owned'), config());
    assert.deepEqual(injections(snapshot.messages).map(row => row.injectionId), ['event-0']);
    for (const invalid of [{ ...input(3), role: 'system' }, { ...input(3), text: '' },
      { ...input(3), text: 'x'.repeat(16385) }, { ...input(3), source: { ...input(3).source, permission: 'all' } }])
      assert.throws(() => f.store.inject(scope, 'inbox-session', invalid), { code: 'invalid_session_injection' });
    assert.equal(f.requests.length, 0);
  });

  test(`${backend}: injection during an active model neither steers nor wakes it and belongs to the following turn`, async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const f = harness(t, backend, async () => { started.resolve(); await release.promise; return answer(); });
    f.kernel.start(identity('active'), config());
    const running = f.kernel.runUntilIdle(scope, 'active'); await started.promise;
    const before = f.store.load(scope, 'active');
    f.store.inject(scope, 'inbox-session', input(7));
    assert.deepEqual(f.store.load(scope, 'active'), before);
    assert.equal(f.requests.length, 1); release.resolve(); await running;
    assert.deepEqual(injections(f.requests[0].messages), []);
    f.kernel.start(identity('following'), config()); await f.kernel.runUntilIdle(scope, 'following');
    assert.deepEqual(injections(f.requests[1].messages).map(row => row.injectionId), ['event-7']);
  });

  test(`${backend}: reattaching an original Run never consumes later injections; historical configurations remain unchanged`, async t => {
    const f = harness(t, backend);
    const legacy = config({ sessionInjectionPolicy: undefined });
    f.store.inject(scope, 'inbox-session', input(0));
    f.kernel.start(identity('legacy'), legacy); await f.kernel.runUntilIdle(scope, 'legacy');
    f.kernel.start(identity('wake'), config());
    f.store.inject(scope, 'inbox-session', input(1));
    const repeated = f.kernel.start(identity('wake'), config());
    assert.deepEqual(repeated.sessionInjections, [{ injectionId: 'event-0', sequence: 1 }]);
    await f.kernel.runUntilIdle(scope, 'wake');
    const next = f.kernel.start(identity('next'), config());
    assert.deepEqual(next.sessionInjections, [{ injectionId: 'event-1', sequence: 2 }]);
  });
}

test('SQLite: failed Run transaction rolls back inbox ownership and two connections share one ordered sequence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-inbox-transaction-')), filename = join(directory, 'runs.sqlite');
  let fail = true;
  const first = new SqliteRunStore(filename, { beforeCommit: () => { if (fail) throw Error('injected commit failure'); } });
  const second = new SqliteRunStore(filename);
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let index = 0; index < 100; index++) (index % 2 ? first : second).inject(scope, 'inbox-session', input(index));
  const kernel = new NativeKernel({ store: first, ports: {}, owner: 'transaction-test', digest: hash });
  assert.throws(() => kernel.start(identity('rolled-back'), config()), /injected commit failure/);
  assert.equal(first.sessionHead(scope, 'inbox-session'), null); fail = false;
  const snapshot = kernel.start(identity('committed'), config());
  assert.deepEqual(snapshot.sessionInjections.map(row => row.sequence), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(second.inject(scope, 'inbox-session', input(0)).consumedBy, 'committed');
});

test('SQLite: actual process loss after atomic admission retains the exact inbox and cannot redeliver it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-inbox-process-')), filename = join(directory, 'runs.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {NativeKernel, configure, canonical} from '@kingsoftcloud/agentkit-harness-core';
    import {SqliteRunStore} from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
    import {createHash} from 'node:crypto';
    const store = new SqliteRunStore(${JSON.stringify(filename)}), scope=${JSON.stringify(scope)};
    for(let i=0;i<100;i++) store.inject(scope,'inbox-session',{injectionId:'event-'+i,text:'External record '+i,source:{kind:'channel',ref:'record-'+i}});
    const kernel=new NativeKernel({store,ports:{},owner:'old',digest:v=>createHash('sha256').update(canonical(v)).digest('hex')});
    kernel.start(${JSON.stringify(identity('original'))},configure(${JSON.stringify(config())}));
    process.kill(process.pid,'SIGKILL');
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const store = new SqliteRunStore(filename); t.after(() => store.close());
  let calls = 0;
  const kernel = new NativeKernel({ store, ports: { model: { generate: async request => {
    calls++; assert.equal(injections(request.messages).length, 100); return answer();
  } } }, owner: 'replacement', digest: hash });
  const original = kernel.start(identity('original'), config());
  assert.equal(original.sessionInjections.length, 100);
  await kernel.runUntilIdle(scope, 'original');
  const next = kernel.start(identity('next'), config());
  assert.equal(next.sessionInjections, undefined); assert.equal(calls, 1);
});
