import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NativeKernel, BACKGROUND_COMMAND_CONTRACT, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { digest, scope } from './fixtures.mjs';

const coreUrl = new URL('../dist/index.mjs', import.meta.url).href;
const sqliteUrl = import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
const fixturesUrl = new URL('./fixtures.mjs', import.meta.url).href;

for (const stage of ['launch-claimed', 'launch-effect', 'launch-committed', 'observation-read', 'notice-committed']) {
  test(`background process loss at ${stage}: durable evidence controls notification and never repeats launch`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-background-process-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'run.sqlite'), marker = join(directory, 'launches.txt'); writeFileSync(marker, '');
    const child = `
      import { NativeKernel, BACKGROUND_COMMAND_CONTRACT, emptyUsage } from ${JSON.stringify(coreUrl)};
      import { SqliteRunStore } from ${JSON.stringify(sqliteUrl)};
      import { fixture, tool, digest, scope } from ${JSON.stringify(fixturesUrl)};
      import { appendFileSync } from 'node:fs';
      const stage = ${JSON.stringify(stage)}, store = new SqliteRunStore(${JSON.stringify(filename)});
      const { config, snapshot } = fixture({ backgroundNotificationPolicy: 'completed-before-model/v1',
        tools: [tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' })],
        limits: { leaseMs: 30 } });
      const originalCommit = store.commit.bind(store), originalClaim = store.claim.bind(store);
      store.commit = (...args) => {
        const next = originalCommit(...args), batch = args.at(-1);
        if (stage === 'launch-committed' && batch.receipts.length && next.backgroundCommands.length) process.exit(95);
        if (stage === 'notice-committed' && batch.events.some(event => event.kind === 'background.commands_observed')) process.exit(95);
        return next;
      };
      store.claim = (...args) => {
        const intent = originalClaim(...args);
        if (stage === 'launch-claimed' && intent.kind === 'tool') process.exit(95);
        return intent;
      };
      const kernel = new NativeKernel({ store, digest, owner: 'lost-process', now: () => 1, ports: {
        model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
          toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] }) },
        tools: { execute: async request => {
          appendFileSync(${JSON.stringify(marker)}, 'launch\\n');
          if (stage === 'launch-effect') process.exit(95);
          return { status: 'ok', content: { task_id: 'a'.repeat(64) }, backgroundCommandRef: {
            taskId: 'a'.repeat(64), sourceRunId: 'run', operationKey: request.operationKey } };
        } },
        background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async request => {
          if (stage === 'observation-read') process.exit(95);
          return [{ ref: request.refs[0], status: 'completed', exitCode: 0, stdout: 'durable process evidence' }];
        } },
      } });
      kernel.start(snapshot, config);
      const unexpected = await kernel.runUntilIdle(scope, 'run');
      throw Error('Did not reach crash boundary: ' + unexpected.phase + '/' + unexpected.reason);
    `;
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
      env: { PATH: join(directory, 'no-programs'), NODE_NO_WARNINGS: '1' },
    });
    assert.equal(exited.status, 95, exited.stderr);
    const store = new SqliteRunStore(filename); t.after(() => store.close());
    const unknown = stage === 'launch-claimed' || stage === 'launch-effect';
    const before = store.load(scope, 'run');
    assert.equal(before.snapshot.backgroundCommands.length, Number(!unknown));
    assert.equal(before.snapshot.messages.filter(message => message.kind === 'background_command_observation').length, Number(stage === 'notice-committed'));
    let probes = 0, models = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'replacement', now: () => 10_000, ports: {
      background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async request => {
        probes++; return [{ ref: request.refs[0], status: 'completed', exitCode: 0, stdout: 'durable process evidence' }];
      } },
      model: { generate: async request => {
        models++; assert.equal(request.messages.filter(message => message.kind === 'background_command_observation').length, 1);
        return { kind: 'final_candidate', text: 'Complete with observed result', toolCalls: [], usage: emptyUsage() };
      } },
      tools: { execute: async () => assert.fail('recovery cannot relaunch an old command') },
    } });
    const recovered = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
    assert.equal(recovered.phase, unknown ? 'interrupted' : 'completed');
    assert.equal(models, Number(!unknown)); assert.equal(probes, Number(!unknown && stage !== 'notice-committed'));
    assert.equal(readFileSync(marker, 'utf8'), stage === 'launch-claimed' ? '' : 'launch\n');
    assert.equal(record.events.filter(event => event.kind === 'background.commands_observed').length, Number(!unknown));
    assert.equal(recovered.messages.filter(message => message.kind === 'background_command_observation').length, Number(!unknown));
    if (unknown) {
      assert.equal(recovered.reason, 'effect_outcome_unknown');
      assert.equal(record.receipts.find(receipt => receipt.operationKey === before.snapshot.pendingIntent).status, 'uncertain');
    } else assert.equal(recovered.backgroundCommands[0].notified, true);
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), recovered);
  });
}
