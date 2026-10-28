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
