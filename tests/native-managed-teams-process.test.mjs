import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedNativeKernel } from '../src/providers/native-managed-kernel.mjs';
import { permitIssuer, target, binding } from './fixtures/native-managed-kernel.mjs';

for (const mode of ['context-rollback', 'callback-rollback', 'committed']) test(`actual SIGKILL keeps original Teams facts atomic (${mode})`, async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-teams-crash-')));
  const child = fork(new URL('./fixtures/native-managed-teams-process.mjs', import.meta.url), [directory, mode],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', runtime; child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await runtime?.close(); rmSync(directory, { recursive: true, force: true }); });
  const held = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Teams process timeout: ' + stderr)), 15000);
    child.on('message', value => { if (value.kind === 'held') { clearTimeout(timer); resolve(value); } });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(Error(`Teams process exited ${code}/${signal}: ${stderr}`)); });
  });
  assert.equal(held.mode, mode); assert.equal(held.pid, child.pid);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null); assert.equal(signal, 'SIGKILL'); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  const { context, opts, first, pid } = JSON.parse(readFileSync(join(directory, 'process-context.json'), 'utf8'));
  assert.notEqual(pid, process.pid);
  const issuer = permitIssuer(), config = { directory, target, permitVerifier: issuer.verifier,
    assertCurrent: () => true, autoStart: false, resolveBinding: request => binding(request.command) };
  runtime = createManagedNativeKernel(config);
  assert.equal(runtime.teamsContexts.incarnation(), opts.expectedIncarnation);
  assert.equal(runtime.teamsContexts.ownsSession(context.ref.sessionId), mode !== 'context-rollback');
  assert.deepEqual(runtime.teamsContexts.get(context.context_ref, opts), mode === 'context-rollback' ? null : context);
  assert.deepEqual(runtime.teamsContexts.getCallback(context.context_ref, 1, opts), mode === 'context-rollback' ? null : first);
  assert.throws(() => runtime.executionGrants.require(context.grant), { code: 'execution_grant_not_found' });
  if (mode === 'context-rollback') { runtime.teamsContexts.put(context, opts); assert.deepEqual(runtime.teamsContexts.get(context.context_ref, opts), context); }
  await runtime.close(); runtime = createManagedNativeKernel(config);
  assert.deepEqual(runtime.teamsContexts.get(context.context_ref, opts), context);
});
