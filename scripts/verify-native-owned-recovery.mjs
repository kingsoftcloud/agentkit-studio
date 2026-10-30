/** Real Node exits across the DSH JSONL / Native SQLite transaction boundary. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonical, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, keep: { type: 'boolean' } } });
assert.ok(values.source, 'Use --source <built maintained DSH>');
const source = resolve(values.source), repository = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'native-owned-process-'));
let passed = false;
try {
  let installed = repository;
  if (values.archive) {
    const graph = join(directory, 'studio'); await mkdir(graph);
    execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
    installed = join(graph, 'package');
  }
  const dependencies = join(directory, 'node_modules/@deepseek-ai');
  await mkdir(dependencies, { recursive: true });
  // Reuse a fixed installed dependency graph, including Studio's declared
  // runtime packages. This is an archive execution proof, not a fresh install.
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (name.startsWith('.') || ['@deepseek-ai', '@kingsoftcloud'].includes(name)) continue;
    await symlink(join(repository, 'node_modules', name), join(directory, 'node_modules', name));
  }
  const packages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const name of await readdir(packages)) await symlink(join(packages, name), join(dependencies, name));
  const entry = join(directory, 'worker.mjs');
  await writeFile(entry, `
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { runOwnedRecoveryWorker } from ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/native-owned-recovery.mjs')).href)};
await runOwnedRecoveryWorker({ Context, AgentLoop, mountAgentLoopTestDependencies, JsonlSessionPersistence, SessionId, createUserMessage },
  { directory: process.argv[2], fault: process.argv[3], recovering: process.argv[4] === 'recover' });
`);
  const run = (root, fault, recovering) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, root, fault, recovering ? 'recover' : 'crash'], {
      cwd: directory, env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`Worker timed out: ${fault}\n${output}`)); }, 30_000);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  for (const fault of ['admission-only', 'model-committed', 'unknown-write', 'terminal-delivered', 'cancel-admission']) {
    const root = join(directory, fault); await mkdir(root);
    const crashed = await run(root, fault, false);
    assert.equal(crashed.code, 37, `${fault} must reach a real process.exit without disposal: ${crashed.output}`);
    const before = parseNativeJson(await readFile(join(root, 'crash.json'), 'utf8'));
    assert.equal(before.defaultCalls, 0); assert.ok(before.owner);
    assert.equal(before.events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(before.events.filter(event => event.type === 'turn/end').length, 0);
    // Respect the actual crashed executor's persisted lease expiry. No fake
    // clock, forced lease deletion or replacement database is used.
    const expiresAt = before.records[0]?.lease?.expiresAt ?? 0;
    if (expiresAt > Date.now()) await new Promise(resolve => setTimeout(resolve, expiresAt - Date.now() + 20));
    const restored = await run(root, fault, true);
    assert.equal(restored.code, 0, `${fault} recovery failed: ${restored.output}`);
    const { before: opened, after, ending, failure } = parseNativeJson(await readFile(join(root, 'recovered.json'), 'utf8'));
    assert.equal(canonical(opened.events.slice(0, before.events.length)), canonical(before.events), 'No synthetic closers or transcript repairs');
    assert.equal(canonical(opened.owner), canonical(before.owner));
    assert.equal(after.records.length, 1); assert.equal(after.defaultCalls, 0);
    const record = after.records[0], admission = parseNativeJson(before.owner.binding);
    for (const key of ['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'])
      assert.equal(canonical(record.snapshot[key]), canonical(admission.identity[key]), `Original ${key}`);
    assert.equal(record.snapshot.configDigest, admission.configDigest);
    assert.equal(canonical(record.configuration), canonical(admission.configuration));
    assert.equal(after.events.filter(event => event.type === 'turn/start').length, 1, 'Recovery must not start another turn');
    if (fault === 'unknown-write') {
      assert.equal(after.writes, 1, 'The unacknowledged real write must never run again');
      assert.equal(after.modelCalls, 1); assert.equal(record.snapshot.phase, 'interrupted');
      assert.ok(record.receipts.some(receipt => receipt.status === 'uncertain'));
      assert.equal(failure?.code, 'NATIVE_TURN_FAILED'); assert.ok(after.owner);
      assert.equal(after.events.filter(event => event.type === 'turn/end').length, 0, 'Unknown write retains explicit recovery ownership');
      assert.ok(before.records[0].lease, 'Write crashed under an actual lease');
      assert.ok(record.fence > before.records[0].fence, 'Recovery acquired a newer fence');
    } else {
      assert.equal(failure, null); assert.equal(after.owner, null);
      assert.equal(after.events.filter(event => event.type === 'turn/end').length, 1);
      if (fault === 'cancel-admission') {
        assert.equal(before.records.length, 1); assert.ok(before.records[0].commands.some(row => row.command.kind === 'cancel' && !row.consumed));
        assert.equal(after.writes, 0); assert.equal(after.modelCalls, 0); assert.equal(record.snapshot.phase, 'canceled');
        assert.deepEqual(ending, { reason: { kind: 'aborted', reason: { kind: 'user' } } });
      } else {
        assert.equal(record.snapshot.phase, 'completed'); assert.equal(after.writes, 1); assert.equal(after.modelCalls, 2);
        assert.deepEqual(ending, { reason: { kind: 'completed' } });
        assert.equal(after.events.filter(event => event.type === 'tool/call').length, 1);
        assert.equal(after.events.filter(event => event.type === 'tool/result').length, 1);
        if (fault === 'admission-only') { assert.equal(before.records.length, 0); assert.equal(before.modelCalls, 0); }
        if (fault === 'model-committed') { assert.equal(before.modelCalls, 1); assert.equal(before.writes, 0); assert.ok(record.fence > before.records[0].fence); }
        if (fault === 'terminal-delivered') {
          assert.equal(before.records[0].snapshot.phase, 'completed');
          assert.equal(canonical(after.records[0].snapshot), canonical(before.records[0].snapshot));
          assert.equal(after.events.filter(event => event.type === 'assistant/message').length, before.events.filter(event => event.type === 'assistant/message').length);
        }
      }
    }
    console.log(`PASS ${fault}: real Node exit, JSONL reopen, same turn/Run/configuration, ${after.modelCalls} model calls, ${after.writes} writes`);
  }
  passed = true;
} finally {
  if (passed && !values.keep) await rm(directory, { recursive: true, force: true });
  else console.log(`Evidence: ${directory}`);
}
