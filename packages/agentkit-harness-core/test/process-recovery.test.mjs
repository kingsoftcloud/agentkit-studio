import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeKernel, emptyUsage } from '../dist/index.mjs';
import { SqliteRunStore } from '../../agentkit-harness/src/native/sqlite-store.mjs';
import { digest, scope } from './fixtures.mjs';

const coreUrl = new URL('../dist/index.mjs', import.meta.url).href;
const sqliteUrl = new URL('../../agentkit-harness/src/native/sqlite-store.mjs', import.meta.url).href;
const fixturesUrl = new URL('./fixtures.mjs', import.meta.url).href;

for (const stage of ['prepared', 'claimed', 'after-side-effect']) {
  test(`real process loss at ${stage}: reopened SQLite preserves dispatch safety without Python`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'native-process-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, 'ledger.sqlite'), marker = join(dir, 'writes.txt');
    writeFileSync(marker, '');
    const child = `
      import { NativeKernel, emptyUsage } from ${JSON.stringify(coreUrl)};
      import { SqliteRunStore } from ${JSON.stringify(sqliteUrl)};
      import { fixture, digest, tool } from ${JSON.stringify(fixturesUrl)};
      import { appendFileSync } from 'node:fs';
      const store = new SqliteRunStore(${JSON.stringify(filename)});
      const { config, snapshot } = fixture({
        tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false, timeoutMs: 20 })],
        profile: { profileId:'test', profileVersion:'1', providerFamily:'fixture', compatibilityDigest:'fixture/v1', requestTimeoutMs:50 },
        limits: { leaseMs: 30, effectTimeoutMs:100 },
      });
      const originalCommit = store.commit.bind(store), originalClaim = store.claim.bind(store);
      store.commit = (...args) => {
        const result = originalCommit(...args);
        if (${JSON.stringify(stage)} === 'prepared' && args.at(-1).intents.some(intent => intent.kind === 'tool')) process.exit(91);
        return result;
      };
      store.claim = (...args) => {
        const result = originalClaim(...args);
        if (${JSON.stringify(stage)} === 'claimed' && result.kind === 'tool') process.exit(91);
        return result;
      };
      const kernel = new NativeKernel({ store, digest, owner:'lost-worker', ports: {
        model: { generate: async () => ({kind:'tool_calls',text:'',toolCalls:[{callId:'write-1',name:'write',arguments:{}}],usage:emptyUsage()}) },
        tools: { execute: async () => { appendFileSync(${JSON.stringify(marker)},'write\\n'); process.exit(91); } },
      } });
      kernel.start(snapshot,config);
      await kernel.runUntilIdle(snapshot.scope,snapshot.runId);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { PATH: join(dir, 'no-programs'), NODE_NO_WARNINGS: '1' },
    });
    assert.equal(result.status, 91, result.stderr);
    const store = new SqliteRunStore(filename);
    t.after(() => store.close());
    let resumedWrites = 0;
    const kernel = new NativeKernel({ store, digest, owner: 'replacement', now: () => Date.now() + 10_000, ports: {
      model: { generate: async () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }) },
      tools: { execute: async () => { resumedWrites++; appendFileSync(marker, 'write\n'); return { status: 'ok', content: 'written' }; } },
    } });
    const recovered = await kernel.runUntilIdle(scope, 'run');
    const writes = readFileSync(marker, 'utf8').split('\n').filter(Boolean);
    if (stage === 'prepared') {
      assert.equal(resumedWrites, 1); assert.equal(writes.length, 1); assert.equal(recovered.phase, 'completed');
    } else {
      assert.equal(resumedWrites, 0); assert.equal(writes.length, stage === 'after-side-effect' ? 1 : 0);
      assert.equal(recovered.reason, 'effect_outcome_unknown'); assert.equal(recovered.outcome, 'unverified');
    }
    assert.deepEqual(await kernel.runUntilIdle(scope, 'run'), recovered);
  });
}
