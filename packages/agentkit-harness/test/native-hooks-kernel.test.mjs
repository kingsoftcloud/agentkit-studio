// Integration: a real NativeKernel + SQLite store drives PreToolUse/PostToolUse/Stop
// hooks and an approval/reopen loop through createNativeHookExecutor. The executor
// is wired in as ports.hooks exactly as a host would; the Kernel still owns effect
// admission, sealed receipts and the separate bounded Stop continuation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, currentHookState, validateHookInvocation } from '../../agentkit-harness-core/dist/index.mjs';
import { scope, digest, acceptance, verificationReport, tool, fixture } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeHookExecutor, nativeHookExecutionPolicyDigest } from '../src/native/hook-executor.mjs';

const CLEANUP = 1000;
const policyDigest = nativeHookExecutionPolicyDigest({ cleanupTimeoutMs: CLEANUP });
const hookDef = (overrides = {}) => ({
  hookId: 'native-exec', sourceRef: 'host://native-exec', bindingDigest: 'sha256:' + 'a'.repeat(64),
  executionPolicyDigest: policyDigest, readOnly: true, events: ['PreToolUse'], timeoutMs: 1000,
  maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block', ...overrides,
});
const output = (o = {}) => ({ action: 'continue', additionalContext: [], updatedArguments: null, ...o });
const finish = () => ({ kind: 'final_candidate', text: 'Finished', toolCalls: [], usage: emptyUsage() });
const toolsResult = (calls) => ({ ...finish(), kind: 'tool_calls', text: '', toolCalls: calls });
const pathTool = () => tool({ parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } });

function sqliteRun(t, config, snapshot, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const filename = join(directory, 'run.sqlite');
  const store = new SqliteRunStore(filename);
  store.create(config, snapshot);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename };
}

test('NativeKernel+SQLite drives PreToolUse/PostToolUse through the executor with sealed receipts and serialized feedback', async (t) => {
  const def = hookDef({ events: ['PreToolUse', 'PostToolUse'] });
  const { config, snapshot } = fixture({ tools: [pathTool()], hooks: [def] });
  const { store } = sqliteRun(t, config, snapshot, 'native-hooks-kernel-');
  const seen = [];
  const executor = createNativeHookExecutor({
    scope, bindings: [{ definition: def, callback: async (req) => {
      const { signal, ...rest } = req;
      validateHookInvocation(rest, digest); // the executor hands the callback a fully valid invocation
      seen.push(req.event);
      if (req.event === 'PostToolUse') assert.equal(req.input.toolResult.content, 'actual rewritten');
      return output({ additionalContext: ['Untrusted hook information'], ...(req.event === 'PreToolUse' ? { updatedArguments: { path: 'rewritten' } } : {}) });
    } }], authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  });
  let models = 0;
  const ports = {
    model: { generate: async (request) => {
      if (++models === 1) return toolsResult([{ callId: 'call', name: 'read', arguments: { path: 'original' } }]);
      const original = request.messages.find((m) => m.toolCalls)?.toolCalls[0];
      assert.equal(original.arguments.path, 'original'); // original protocol arguments are preserved
      const resultIndex = request.messages.findIndex((m) => m.role === 'tool');
      const hookIndexes = request.messages.flatMap((m, i) => (m.kind === 'hook_context' ? [i] : []));
      assert.ok(hookIndexes.length === 2 && hookIndexes.every((i) => i > resultIndex)); // feedback serialized after the tool result
      return finish();
    } },
    tools: { execute: async (request) => { assert.equal(request.call.arguments.path, 'rewritten'); return { status: 'ok', content: 'actual rewritten' }; } },
    hooks: executor,
  };
  const worker = new NativeKernel({ store, ports, digest, owner: 'worker' });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.deepEqual(seen, ['PreToolUse', 'PostToolUse']);
  assert.equal(result.messages.filter((m) => m.kind === 'hook_context').length, 2);
  assert.deepEqual(currentHookState(result).feedback, []);
  const receipts = store.load(scope, 'run').receipts.filter((r) => r.result?.schemaVersion === 'agentkit.native-hook-result/v1');
  assert.equal(receipts.length, 2); // both hook effects have durable receipts
  await executor.close();
});

test('Stop feedback through the executor stays untrusted and does not replace acceptance verification', async (t) => {
  const def = hookDef({ events: ['Stop'] });
  const { config, snapshot } = fixture({ hooks: [def], stopHookContinuationLimit: 2, contract: { objective: 'Complete', acceptance: [acceptance()] } });
  const { store } = sqliteRun(t, config, snapshot, 'native-hooks-stop-');
  let hooks = 0, verifies = 0;
  const executor = createNativeHookExecutor({
    scope, bindings: [{ definition: def, callback: async () => { hooks++; return output({ additionalContext: ['I declare success'] }); } }],
    authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  });
  const ports = {
    model: { generate: async () => finish() },
    hooks: executor,
    verification: { verify: async (request) => {
      verifies++;
      assert.equal(hooks, 1);
      assert.ok(request.snapshot.messages.at(-1).content.includes('untrusted')); // Stop feedback is untrusted context, not a verdict
      return verificationReport(request, { checks: [], status: 'unverified' });
    } },
  };
  const worker = new NativeKernel({ store, ports, digest, owner: 'worker' });
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'unverified'); // the hook never granted completion
  assert.equal(verifies, 1);
  await executor.close();
});

test('changed arguments through the executor require approval and are not re-hooked on SQLite reopen', async (t) => {
  const def = hookDef({ events: ['PreToolUse'] });
  const { config, snapshot } = fixture({ tools: [pathTool()], hooks: [def] });
  const { store, filename } = sqliteRun(t, config, snapshot, 'native-hooks-approval-');
  let hooks = 0, actualWrites = 0, models = 0;
  const executor = createNativeHookExecutor({
    scope, bindings: [{ definition: def, callback: async () => { hooks++; return output({ updatedArguments: { path: 'sensitive' } }); } }],
    authorize: async () => 'allow', cleanupTimeoutMs: CLEANUP,
  });
  const ports = {
    model: { generate: async () => ++models === 1 ? toolsResult([{ callId: 'call', name: 'read', arguments: { path: 'original' } }]) : finish() },
    tools: { execute: async (request) => {
      assert.equal(request.call.arguments.path, 'sensitive'); // effective (hook-rewritten) arguments reach the tool
      if (!request.interaction) return { status: 'approval_required', interactionId: 'host-owned', content: null };
      assert.equal(request.interaction.decision, 'allow');
      actualWrites++;
      return { status: 'ok', content: 'approved effect' };
    } },
    hooks: executor,
  };
  let worker = new NativeKernel({ store, ports, digest, owner: 'worker' });
  let result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'awaiting_interaction');
  assert.equal(actualWrites, 0);
  assert.equal(hooks, 1);
  // Reopen from SQLite; the host still owns the same executor across the reopen.
  store.close();
  const reopened = new SqliteRunStore(filename);
  worker = new NativeKernel({ store: reopened, ports, digest, owner: 'worker' });
  worker.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction', payload: { interactionId: result.pendingInteraction.interactionId, decision: 'allow' } });
  result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  assert.equal(actualWrites, 1);
  assert.equal(hooks, 1); // the PreToolUse hook is not repeated on approval reopen
  reopened.close();
  await executor.close();
});

for (const action of ['continue', 'deny']) test(`PreCompact ${action} uses an admitted source through the real executor and SQLite`, async t => {
  const def = hookDef({ events: ['PreCompact'], maxInputBytes: 100000 });
  const { config, snapshot } = fixture({ hooks: [def], tools: [tool()],
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      contextWindow: 2400, maxOutputTokens: 128, retryInitialDelayMs: 0 },
    contextPolicy: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1', enabled: true,
      triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
      maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 },
  });
  const { store } = sqliteRun(t, config, snapshot, 'native-precompact-executor-');
  let tasks = 0, summaries = 0, hooks = 0;
  const executor = createNativeHookExecutor({ scope, cleanupTimeoutMs: CLEANUP,
    bindings: [{ definition: def, callback: async invocation => {
      hooks++;
      assert.equal(invocation.event, 'PreCompact'); assert.equal(summaries, 0);
      const source = invocation.input.compaction;
      assert.equal(source.sourceMessageCount, 3);
      assert.equal(source.messages.length, source.messageRefs.length);
      assert.ok(source.messages.some(message => message.role === 'tool' && message.content.includes('Original observation')));
      assert.ok(source.messageRefs.every(ref => !source.retainedMessageRefs.includes(ref)));
      return output({ action, additionalContext: ['Keep exact source scope'] });
    } }], authorize: async () => 'allow',
  });
  t.after(() => executor.close());
  const ports = {
    hooks: executor,
    context: { tokens: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1',
      countRequest: async request => Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4),
      countText: async request => Math.ceil(request.text.length / 4),
    } },
    tools: { execute: async () => ({ status: 'ok', content: 'Original observation '.repeat(800) }) },
    model: { generate: async request => {
      if (request.messages[0].kind === 'compaction_instructions') {
        summaries++; assert.equal(hooks, 1); assert.equal(action, 'continue');
        assert.deepEqual(request.tools, []);
        return { ...finish(), text: 'Notes about the observed source.' };
      }
      if (++tasks === 1) return toolsResult([{ callId: 'call', name: 'read', arguments: {} }]);
      assert.ok(request.messages.some(message => message.kind === 'hook_context' && message.content.includes('Keep exact source scope')));
      return finish();
    } },
  };
  const result = await new NativeKernel({ store, ports, digest, owner: 'worker' }).runUntilIdle(scope, 'run');
  assert.equal(hooks, 1);
  assert.equal(store.load(scope, 'run').receipts.filter(receipt => receipt.result?.schemaVersion === 'agentkit.native-hook-result/v1').length, 1);
  assert.equal(result.messages.filter(message => message.role === 'tool').length, 1);
  if (action === 'deny') {
    assert.equal(result.outcome, 'blocked'); assert.equal(result.reason, 'precompact_hook_denied');
    assert.equal(summaries, 0); assert.equal(tasks, 1);
  } else {
    assert.equal(result.phase, 'completed'); assert.ok(summaries > 0); assert.equal(tasks, 2);
    assert.equal(result.contextState.compactions, 1);
  }
});
