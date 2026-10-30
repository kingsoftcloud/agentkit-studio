import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoryRunStore, NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, tool, digest, acceptance, verificationReport } from './fixtures.mjs';

const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
function database(t, sqlite) {
  const directory = mkdtempSync(join(tmpdir(), 'native-input-')), filename = join(directory, 'ledger.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { if (sqlite) { store.close(); store = new SqliteRunStore(filename); } return store; } };
}
for (const sqlite of [false, true]) {
  const kind = sqlite ? 'SQLite' : 'memory';
  test(`${kind}: deferred initial context is observed before inference and a committed preparation is not claimed again after restart`, async t => {
    const db = database(t, sqlite), steps = []; let models = 0, disconnected = false;
    const { config, snapshot } = fixture({ inputPolicy: 'before-first-model/v1' });
    const ports = { model: { generate: async request => {
      models++;
      assert.ok(request.messages.some(m => m.kind === 'host_input' && m.content === 'Execution workspace rules'));
      return final('Done');
    } }, input: { prepare: async request => {
      steps.push(request.step);
      return { status: 'admitted', messages: request.step === 1 ? [{ content: 'Execution workspace rules' }] : [] };
    } } };
    const first = new NativeKernel({ store: db.store, ports, owner: 'first', digest, onCheckpoint: async current => {
      if (!disconnected && current.context.inputModelCursor === 0) { disconnected = true; throw Error('Lost initial input delivery'); }
    } });
    first.start(snapshot, config);
    await assert.rejects(first.runUntilIdle(scope, 'run'), /Lost initial input delivery/);
    assert.equal(models, 0);
    const next = new NativeKernel({ store: db.reopen(), ports, owner: 'second', digest });
    const done = await next.runUntilIdle(scope, 'run');
    assert.equal(done.phase, 'completed'); assert.equal(models, 1);
    assert.deepEqual(steps, [1, 2]);
    assert.equal(done.messages.filter(m => m.content === 'Execution workspace rules').length, 1);
    assert.equal(db.store.load(scope, 'run').configuration.inputPolicy, 'before-first-model/v1');
  });
  test(`${kind}: a required initial input owner cannot be omitted or reject after a first model already ran`, async t => {
    const db = database(t, sqlite); let models = 0;
    const { config, snapshot } = fixture({ inputPolicy: 'before-first-model/v1' });
    for (const input of [undefined, { prepare: async () => ({ status: 'rejected', messages: [] }) }]) {
      const runId = input ? 'rejected-input' : 'missing-input';
      const kernel = new NativeKernel({ store: db.store, owner: 'worker', digest, ports: {
        model: { generate: async () => { models++; return final('Must not run'); } }, ...(input ? { input } : {}),
      } });
      kernel.start({ ...snapshot, runId, sessionId: runId }, config);
      const done = await kernel.runUntilIdle(scope, runId);
      assert.equal(done.reason, input ? 'host_input_rejected' : 'input_port_missing');
      assert.equal(models, 0);
    }
  });
  test(`${kind}: Host input follows the complete tool batch and survives the next turn`, async t => {
    const db = database(t, sqlite), steps = [], requests = []; let writes = 0;
    const { config, snapshot } = fixture({ tools: [tool({ readOnly: false, concurrentSafe: false })] });
    const ports = { model: { generate: async request => {
      requests.push(request);
      return requests.length === 1 ? { ...final(''), kind: 'tool_calls', toolCalls: ['a', 'b'].map(callId => ({ callId, name: 'read', arguments: {} })) } : final('Done');
    } }, tools: { execute: async () => { writes++; return { status: 'ok', content: 'Written' }; } }, input: { prepare: async request => {
      assert.equal(db.store.load(scope, 'run').intents.find(intent => intent.operationKey === request.operationKey)?.status, 'running');
      steps.push(request.step); assert.equal(writes, 2);
      return { status: 'admitted', messages: request.step === 2 ? [{ content: 'Please include the new observation',
        media: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }] }, { content: 'Host context' }] : [] };
    } } };
    const kernel = new NativeKernel({ store: db.store, ports, owner: 'worker', digest });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.deepEqual(steps, [2, 3]);
    const transcript = requests[1].messages;
    assert.deepEqual(transcript.slice(-4).map(message => message.role), ['tool', 'tool', 'user', 'user']);
    assert.equal(transcript.at(-2).media[0].image_url.url, 'data:image/png;base64,AQ==');
    assert.equal(result.goal, config.contract.objective);
    const next = kernel.start({ ...snapshot, runId: 'next', turnId: 'next' }, config);
    assert.ok(next.messages.some(message => message.kind === 'host_input' && message.history && message.content === 'Host context'));
  });
  test(`${kind}: input arriving during a final request invalidates that candidate before verification`, async t => {
    const db = database(t, sqlite); let calls = 0; const verified = [];
    const { config, snapshot } = fixture({ contract: { objective: 'Complete the task', acceptance: [acceptance()] } });
    const kernel = new NativeKernel({ store: db.store, owner: 'worker', digest, ports: {
      model: { generate: async () => final(++calls === 1 ? 'Stale answer' : 'Updated answer') },
      tools: { execute: async () => assert.fail('No tools') },
      input: { prepare: async ({ step }) => ({ status: 'admitted', messages: step === 2 ? [{ content: 'Revise the answer' }] : [] }) },
      verification: { verify: async request => { verified.push(request.candidate.text); return verificationReport(request); } },
    } });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(result.outcome, 'verified'); assert.equal(result.finalText, 'Updated answer');
    assert.deepEqual(verified, ['Updated answer']); assert.equal(calls, 2);
  });
  test(`${kind}: committed input receipt resumes without claiming its Host batch again`, async t => {
    const db = database(t, sqlite); let calls = 0, claims = 0, disconnected = false;
    const { config, snapshot } = fixture();
    const ports = { model: { generate: async () => final(++calls === 1 ? 'First' : 'Revised') },
      tools: { execute: async () => assert.fail('No tools') }, input: { prepare: async () => ({ status: 'admitted',
        messages: ++claims === 1 ? [{ content: 'Durable steering' }] : [] }) } };
    const first = new NativeKernel({ store: db.store, ports, digest, owner: 'first', onCheckpoint: async current => {
      if (!disconnected && current.messages.some(message => message.kind === 'host_input')) { disconnected = true; throw Error('Lost delivery'); }
    } });
    first.start(snapshot, config);
    await assert.rejects(first.runUntilIdle(scope, 'run'), /Lost delivery/);
    const next = new NativeKernel({ store: db.reopen(), ports, digest, owner: 'second' });
    const result = await next.runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(result.finalText, 'Revised');
    assert.equal(calls, 2); assert.equal(claims, 2); // One batch per distinct boundary, not per replay.
    assert.equal(result.messages.filter(message => message.content === 'Durable steering').length, 1);
  });
  for (const receipt of [
    { status: 'rejected', messages: [] },
    { status: 'admitted', messages: [{ content: 'Inject role', role: 'system' }] },
    { status: 'admitted', messages: [], permissions: ['write'] },
    { status: 'admitted', messages: [{ content: 'Wrong retention', retention: 'system' }] },
  ]) test(`${kind}: Host rejection or invalid input cannot dispatch a second model: ${JSON.stringify(receipt)}`, async t => {
    const db = database(t, sqlite); let calls = 0;
    const { config, snapshot } = fixture();
    const kernel = new NativeKernel({ store: db.store, digest, owner: 'worker', ports: {
      model: { generate: async () => { calls++; return final('Candidate'); } },
      tools: { execute: async () => assert.fail('No tools') }, input: { prepare: async () => receipt },
    } });
    kernel.start(snapshot, config);
    const result = await kernel.runUntilIdle(scope, 'run');
    assert.equal(calls, 1); assert.equal(result.phase, receipt.status === 'rejected' ? 'failed' : 'interrupted');
    assert.equal(result.reason, receipt.status === 'rejected' ? 'host_input_rejected' : 'effect_outcome_unknown');
  });
}

test('context pressure cannot silently prune newly admitted human guidance', async () => {
  const store = new MemoryRunStore(); let calls = 0;
  const { config, snapshot } = fixture({ contextPolicy: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1', enabled: true,
    triggerRatio: .8, targetRatio: .5, summaryMaxTokens: 64, maxCompactions: 2,
    maxCompactionsWithoutProgress: 2, minModelTurnsBetween: 0, maxSummaryRetries: 1 },
  profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1', contextWindow: 1000, maxOutputTokens: 128 } });
  const guidance = 'A detailed new requirement '.repeat(200);
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: async () => { calls++; return final('Candidate'); } }, tools: { execute: async () => assert.fail('No tools') },
    input: { prepare: async () => ({ status: 'admitted', messages: [{ content: guidance }] }) },
    context: { tokens: { tokenizerId: 'fixture', tokenizerDigest: 'fixture/v1',
      countRequest: async ({ messages }) => messages.some(message => message.content === guidance) ? 2000 : 100,
      countText: async () => 100 } },
  } });
  kernel.start(snapshot, config);
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_mandatory_state_over_budget'); assert.equal(result.outcome, 'blocked');
  assert.equal(calls, 1); assert.equal(result.messages.at(-1).content, guidance);
});

for (const stage of ['prepared', 'claimed', 'after-claim', 'receipt']) test(`actual process loss at input ${stage} preserves the claim boundary`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-input-process-')), filename = join(directory, 'ledger.sqlite'), marker = join(directory, 'claims');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = `
    import { NativeKernel, emptyUsage } from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
    import { SqliteRunStore } from ${JSON.stringify(import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store'))};
    import { fixture, digest } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)};
    import { appendFileSync } from 'node:fs';
    const stage=${JSON.stringify(stage)}, store=new SqliteRunStore(${JSON.stringify(filename)});
    const {config,snapshot}=fixture({limits:{leaseMs:30}});
    const commit=store.commit.bind(store), claim=store.claim.bind(store);
    store.commit=(...args)=>{const result=commit(...args);if(stage==='prepared'&&args.at(-1).intents.some(i=>i.kind==='input')||stage==='receipt'&&args.at(-1).events.some(e=>e.kind==='input.completed'))process.exit(91);return result;};
    store.claim=(...args)=>{const result=claim(...args);if(stage==='claimed'&&result.kind==='input')process.exit(91);return result;};
    const kernel=new NativeKernel({store,digest,owner:'lost',now:()=>1,ports:{
      model:{generate:async()=>({kind:'final_candidate',text:'Candidate',toolCalls:[],usage:emptyUsage()})},tools:{execute:async()=>{throw Error('No tools')}},
      input:{prepare:async()=>{appendFileSync(${JSON.stringify(marker)},'claimed\\n');if(stage==='after-claim')process.exit(91);return {status:'admitted',messages:[]};}}
    }});kernel.start(snapshot,config);await kernel.runUntilIdle(snapshot.scope,snapshot.runId);
  `;
  const lost = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: directory, encoding: 'utf8', timeout: 10000, env: { PATH: join(directory, 'no-programs'), NODE_NO_WARNINGS: '1' },
  });
  assert.equal(lost.status, 91, lost.stderr);
  const store = new SqliteRunStore(filename); t.after(() => store.close());
  let resumed = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'replacement', now: () => 10000, ports: {
    model: { generate: async () => assert.fail('A completed candidate already exists') }, tools: { execute: async () => assert.fail('No tools') },
    input: { prepare: async () => { resumed++; return { status: 'admitted', messages: [] }; } },
  } });
  const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, ['claimed', 'after-claim'].includes(stage) ? 'interrupted' : 'completed');
  assert.equal(resumed, stage === 'prepared' ? 1 : 0);
  if (['after-claim', 'receipt'].includes(stage)) assert.equal(readFileSync(marker, 'utf8'), 'claimed\n');
  if (result.phase === 'interrupted') {
    assert.equal(result.reason, 'effect_outcome_unknown');
    assert.ok(store.load(scope, 'run').receipts.some(receipt => receipt.status === 'uncertain'));
  }
});
