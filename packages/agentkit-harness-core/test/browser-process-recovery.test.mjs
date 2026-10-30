import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { digest, scope } from './fixtures.mjs';

const coreUrl = new URL('../dist/index.mjs', import.meta.url).href;
const sqliteUrl = import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
const fixturesUrl = new URL('./fixtures.mjs', import.meta.url).href;

for (const reobserveAvailable of [false, true]) for (const stage of ['observed', 'prepared', 'claimed', 'after-action']) {
  test(`browser process loss at ${stage}, reobserve=${reobserveAvailable}: old input cannot execute`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-browser-process-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'run.sqlite'), marker = join(directory, 'actions.txt');
    writeFileSync(marker, '');
    const child = `
      import { NativeKernel, emptyUsage, validateBrowserSessionRef, validateBrowserObservation } from ${JSON.stringify(coreUrl)};
      import { SqliteRunStore } from ${JSON.stringify(sqliteUrl)};
      import { fixture, tool, digest, scope } from ${JSON.stringify(fixturesUrl)};
      import { appendFileSync } from 'node:fs';
      const stage = ${JSON.stringify(stage)}, store = new SqliteRunStore(${JSON.stringify(filename)});
      const ref = validateBrowserSessionRef({ sessionId: 'old-page', scope, runId: 'run',
        runtimeId: 'owner', workspaceRevision: 'workspace-1', generation: 1, leaseEpoch: 1 });
      const { config, snapshot } = fixture({ tools: [tool({ name: 'browser', readOnly: false,
        concurrentSafe: false, observationRole: 'browser' })], limits: { leaseMs: 30 } });
      const originalCommit = store.commit.bind(store), originalClaim = store.claim.bind(store);
      store.commit = (...args) => {
        const next = originalCommit(...args), batch = args.at(-1);
        if (stage === 'observed' && batch.receipts.length && next.browserSessionRefs.length) process.exit(91);
        if (stage === 'prepared' && batch.intents.some(intent => intent.kind === 'tool'
          && intent.payload.calls[0].callId === 'old-action')) process.exit(91);
        return next;
      };
      store.claim = (...args) => {
        const intent = originalClaim(...args);
        if (stage === 'claimed' && intent.kind === 'tool' && intent.payload.calls[0].callId === 'old-action') process.exit(91);
        return intent;
      };
      let models = 0;
      const kernel = new NativeKernel({ store, digest, owner: 'lost-worker', now: () => 1, ports: {
        model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
          toolCalls: [{ callId: ++models === 1 ? 'open' : 'old-action', name: 'browser', arguments: {} }] }) },
        tools: { execute: async ({ call }) => {
          appendFileSync(${JSON.stringify(marker)}, call.callId + '\\n');
          if (call.callId === 'old-action') process.exit(91);
          return { status: 'ok', content: 'page observed', browserSessionRef: ref, browserObservation: validateBrowserObservation({
            sessionRef: ref, actionId: 'open', actionSeq: 1,
            status: 'ok', complete: true, retryability: 'safe', viewport: [1280, 720], text: 'old page',
            screenshot: { contentRef: 'host:old-screenshot', width: 1280, height: 720,
              contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } } },
          }) };
        } },
      } });
      kernel.start(snapshot, config);
      const unexpected = await kernel.runUntilIdle(scope, 'run');
      throw new Error('Did not reach crash boundary: ' + unexpected.phase + '/' + unexpected.reason);
    `;
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { PATH: join(directory, 'no-programs'), NODE_NO_WARNINGS: '1' },
    });
    assert.equal(exited.status, 91, exited.stderr);
    const store = new SqliteRunStore(filename);
    t.after(() => store.close());
    const before = store.load(scope, 'run');
    assert.equal(before.snapshot.browserSessionRefs[0].sessionId, 'old-page');
    assert.equal(before.snapshot.lastBrowserObservation.actionId, 'open');
    let probes = 0, models = 0, actions = 0;
    const unknown = stage === 'claimed' || stage === 'after-action', continues = reobserveAvailable && !unknown;
    const kernel = new NativeKernel({ store, digest, owner: 'replacement', now: () => 10_000, ports: {
      browser: { recoverSessions: async ({ refs }) => { probes++; return refs.map(sessionRef => ({
        status: 'lost', sessionRef, lastActionSeq: 1, reason: 'worker_gone', reobserveAvailable,
      })); } },
      model: { generate: async () => {
        models++;
        assert.equal(continues, true);
        return models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
          { callId: 'fresh-observation', name: 'browser', arguments: {} },
        ] } : { kind: 'final_candidate', text: 'Observed without replaying prior actions', toolCalls: [], usage: emptyUsage() };
      } },
      tools: { execute: async ({ call }) => {
        assert.equal(call.callId, 'fresh-observation');actions++;
        const { appendFileSync } = await import('node:fs');
        const { validateBrowserObservation } = await import(coreUrl);
        const ref = { ...before.snapshot.browserSessionRefs[0], generation: 2, leaseEpoch: 2 };
        appendFileSync(marker, call.callId + '\n');
        return { status: 'ok', content: 'fresh observation', browserSessionRef: ref,
          browserObservation: validateBrowserObservation({ sessionRef: ref, actionId: 'fresh', actionSeq: 1,
            status: 'ok', complete: true, retryability: 'safe', viewport: [1280, 720], text: 'fresh page',
            screenshot: { contentRef: 'host:fresh-screenshot', width: 1280, height: 720,
              contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } } },
          }) };
      } },
    } });
    const recovered = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
    assert.equal(recovered.phase, continues ? 'completed' : 'interrupted');
    assert.equal(recovered.reason, unknown ? 'effect_outcome_unknown' : continues ? 'verification_report_missing' : 'browser_session_unavailable');
    if (!continues) { assert.equal(recovered.lastBrowserObservation, null); assert.equal(recovered.candidate, null); }
    else { assert.equal(recovered.lastBrowserObservation.sessionRef.generation, 2);assert.deepEqual(recovered.browserReobservationRefs, []); }
    assert.equal(probes, 1); assert.equal(models, continues ? 2 : 0); assert.equal(actions, continues ? 1 : 0);
    const expectedActions = stage === 'after-action' ? ['open', 'old-action'] : ['open'];
    if (continues) expectedActions.push('fresh-observation');
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), expectedActions);
    if (stage !== 'observed') {
      const old = record.intents.find(intent => intent.kind === 'tool' && intent.payload.calls[0].callId === 'old-action');
      assert.equal(record.receipts.find(receipt => receipt.operationKey === old.operationKey).status, unknown ? 'uncertain' : 'not_dispatched');
    }
    const events = record.events.map(event => event.kind);
    assert.ok(events.indexOf('browser.recovered') >= 0);
    assert.ok(events.indexOf('browser.recovered') < events.indexOf('run.terminal'));
    assert.equal(record.events.find(event => event.kind === 'run.terminal').payload.phase, continues ? 'completed' : 'interrupted');
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), recovered); assert.equal(probes, 1);
  });
}
