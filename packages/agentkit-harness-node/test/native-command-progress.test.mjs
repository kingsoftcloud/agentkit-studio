import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeLocalCommandTools, LOCAL_COMMAND_PROGRESS_CONTRACT } from '../src/native/local-command-tools.mjs';
import { LocalCommandStore } from '../src/native/local-background.mjs';
import { createCommandProgressObserver } from '../src/native/command-progress.mjs';

function fixture(t, { durableForeground = false, authority = () => true, authorize = async () => 'allow' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-command-progress-')));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  const store = new LocalCommandStore({ workspaceRoot, stateRoot: join(root, 'commands'), sessionId: 's' });
  t.after(async () => {
    try {
      const id = store.commandId('one-command');
      if (existsSync(join(store.directory, id, 'record.json'))) await store.connect(id).wait({ timeoutMs: 3000 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const tools = createNativeLocalCommandTools({ workspaceRoot, stateRoot: join(root, 'commands'), sessionId: 's',
    authorize, resolveOwnedCommand: () => { throw Error('not a background read'); }, assertAuthority: authority,
    captureWorkspace: () => ({ entries: {} }), durableForeground });
  const controller = new AbortController();
  const request = { runId: 'r', sessionId: 's', operationKey: 'one-command', signal: controller.signal,
    call: { name: 'run_command', callId: 'c', arguments: {
      command: "printf 'before😀'; printf 'diagnostic' >&2; sleep 0.15; printf 'after'", timeout: 10,
    } } };
  return { tools, request, controller };
}

for (const durableForeground of [false, true]) {
  test(`real command output is observed before its final receipt (durable=${durableForeground})`, async t => {
    const f = fixture(t, { durableForeground }), frames = [];
    let settled = false;
    const outcome = await f.tools.execute(f.request, { onProgress: frame => {
      frames.push({ frame, beforeSettled: !settled });
    } });
    settled = true;
    assert.equal(outcome.status, 'ok'); assert.equal(outcome.content.exit_code, 0);
    for (const entry of frames) {
      assert.equal(entry.beforeSettled, true); assert.equal(Object.isFrozen(entry.frame), true);
      assert.equal(entry.frame.contract, LOCAL_COMMAND_PROGRESS_CONTRACT);
      assert.deepEqual(Object.keys(entry.frame).sort(), ['channel', 'contract', 'sequence', 'text']);
    }
    frames.splice(0, frames.length, ...frames.map(entry => entry.frame));
    assert.deepEqual(frames.map(f => f.sequence), frames.map((_, i) => i + 1));
    for (const channel of ['stdout', 'stderr'])
      assert.equal(frames.filter(f => f.channel === channel).map(f => f.text).join(''), outcome.content[channel]);
    assert.equal(outcome.content.stdout, 'before😀after');
    assert.ok(frames.some(f => f.text.includes('before') && !f.text.includes('after')));
  });
  test(`cancellation suppresses later previews without claiming successful execution (durable=${durableForeground})`, async t => {
    const f = fixture(t, { durableForeground }), frames = [];
    const outcome = await f.tools.execute(f.request, { onProgress: frame => {
      frames.push(frame); f.controller.abort(new Error('stop after first output'));
    } });
    assert.equal(outcome.status, 'uncertain');
    assert.equal(frames.length, 1); assert.equal(frames[0].channel, 'stdout');
    assert.ok(!frames.some(f => f.text.includes('after')));
  });
}

test('revoked authority and failed observation consumers cannot publish later data or alter a known result', async t => {
  let current = true;
  const f = fixture(t, { authority: () => current }), frames = [];
  const unknown = await f.tools.execute(f.request, { onProgress: frame => { frames.push(frame); current = false; } });
  assert.equal(unknown.status, 'uncertain'); assert.equal(frames.length, 1);
  assert.deepEqual(unknown.content.command_evidence.causes, ['authority_lost']);
  const independent = fixture(t);
  let calls = 0;
  const known = await independent.tools.execute(independent.request, { onProgress: () => {
    if (++calls === 1) throw Error('view failed');
    return Promise.reject(Error('async view failed'));
  } });
  assert.equal(known.status, 'ok'); assert.equal(known.content.stdout, 'before😀after');
});

test('a completed durable producer drains every retained output window without duplicating bytes', async t => {
  const f = fixture(t, { durableForeground: true }), frames = [];
  f.request.resultGovernance = 'runtime-artifacts/v1';
  f.request.call.arguments.command = "printf '%060000d' 0; printf '%060000d' 0";
  const outcome = await f.tools.execute(f.request, { onProgress: frame => frames.push(frame) });
  assert.equal(outcome.status, 'ok'); assert.equal(outcome.content.exit_code, 0);
  assert.equal(outcome.content.stdout.length, 120000);
  assert.equal(frames.filter(f => f.channel === 'stdout').map(f => f.text).join(''), outcome.content.stdout);
});

test('denied execution produces neither output observations nor a dispatched outcome', async t => {
  const f = fixture(t, { authorize: async () => 'deny' }), frames = [];
  const outcome = await f.tools.execute(f.request, { onProgress: frame => frames.push(frame) });
  assert.equal(outcome.status, 'error'); assert.deepEqual(frames, []);
  assert.equal(outcome.content.error_type, 'policy_denied');
});

test('a real supervised command reaches only the Host-governed preview before returning its receipt', async t => {
  const f = fixture(t, { durableForeground: true }), frames = [];
  f.request.call.arguments.command = "printf 'token=SEC'; sleep 0.1; printf 'RET\n'; sleep 0.1; printf 'done\n'";
  let settled = false;
  const observer = createCommandProgressObserver({ signal: f.controller.signal, isCurrent: () => true,
    project: snapshot => snapshot.stdout.endsWith('\n') && !snapshot.truncated
      ? { kind: 'command_preview', stdout: snapshot.stdout.replaceAll('SECRET', '[redacted]'), stderr: snapshot.stderr } : null,
    publish: frame => frames.push({ frame, beforeSettled: !settled }) });
  try {
    const outcome = await f.tools.execute(f.request, { onProgress: observer.observe }); settled = true;
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome.content)); assert.equal(outcome.content.stdout, 'token=SECRET\ndone\n');
    assert.ok(frames.length >= 1); assert.ok(frames.every(row => row.beforeSettled));
    assert.equal(frames.at(-1).frame.display.stdout, 'token=[redacted]\ndone\n');
    assert.equal(JSON.stringify(frames).includes('SECRET'), false);
  } finally { observer.close(); }
});
