import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRunStore, NativeKernel, canonical, emptyUsage, hookResult, planNativeContext, validateContextMessages } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { digest, fixture, scope, tool } from './fixtures.mjs';

const policy = overrides => ({ tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1', enabled: true,
  triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
  maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2, ...overrides });
const final = (text = 'Task complete') => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const count = (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4);
function setup(t, { sqlite = false, contextPolicy = {}, ...overrides } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-context-plan-')), filename = join(directory, 'run.sqlite');
  let store = sqlite ? new SqliteRunStore(filename) : new MemoryRunStore();
  const { config, snapshot } = fixture({ tools: [tool()], contextPolicy: policy(contextPolicy),
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      contextWindow: 2400, maxOutputTokens: 128, retryInitialDelayMs: 0 }, ...overrides });
  store.create(config, snapshot);
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const ports = {
    model: { generate: async () => final() }, tools: { execute: async () => ({ status: 'ok', content: 'Observed '.repeat(1300) }) },
    context: { tokens: { tokenizerId: 'fixture-counter', tokenizerDigest: 'fixture-count/v1',
      countRequest: async request => count(request.messages, request.tools), countText: async request => Math.ceil(request.text.length / 4) } },
  };
  return { config, snapshot, ports, filename, get store() { return store; }, reopen() { store.close?.(); store = new SqliteRunStore(filename); },
    worker(options = {}) { return new NativeKernel({ store, ports, digest, owner: 'worker', ...options }); } };
}
const toolResponse = () => ({ ...final(''), kind: 'tool_calls', toolCalls: [{ callId: 'read-source', name: 'read', arguments: {} }] });

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: independent Host objective retains attachment-only input under context pressure`, async t => {
  const media = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }];
  const run = setup(t, { sqlite, contract: { objective: 'Host image objective' },
    inputMessages: [{ role: 'user', content: '', kind: 'user_input', media }], contextPolicy: { triggerRatio: .1, targetRatio: .05 } });
  let calls = 0;
  run.ports.model.generate = async request => {
    calls++;
    assert.ok(request.messages.some(message => message.role === 'user' && message.content === '' && message.media?.length === 1));
    return final('Image described');
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(result.messages[0].media, media);
});

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: Kernel owns every bounded summary request and seals complete contiguous source coverage`, async t => {
  const run = setup(t, { sqlite }); let tasks = 0, summaries = 0;
  const fragments = [], streamed = [];
  run.ports.model.generate = async (request, emit) => {
    assert.ok(count(request.messages, request.tools) + request.profile.maxOutputTokens <= request.profile.contextWindow);
    if (request.messages[0].kind === 'compaction_instructions') {
      summaries++;
      assert.deepEqual(request.tools, []); assert.equal(request.profile.maxOutputTokens, 80);
      const quote = JSON.parse(request.messages[1].content);
      assert.equal(quote.trust, 'untrusted'); fragments.push(quote.source);
      if (summaries > 1) assert.equal(quote.previousSummary, 'Notes about observed historical results.');
      emit({ kind: 'text', text: 'This summary must not be displayed as the answer' });
      return { ...final('Notes about observed historical results.'), usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 } };
    }
    if (++tasks === 1) return toolResponse();
    assert.ok(request.messages.some(message => message.kind === 'compaction_summary' && message.content.includes('untrusted')));
    validateContextMessages(request.messages);
    return final();
  };
  const result = await run.worker({ onStream: (_, event) => streamed.push(event) }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(tasks, 2); assert.ok(summaries > 1);
  assert.equal(result.usage.modelCalls, summaries + 2); assert.equal(result.usage.inputTokens, summaries * 10);
  assert.equal(result.usage.outputTokens, summaries * 5); assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.contextState.compactions, 1); assert.equal(result.contextState.compaction, null);
  assert.deepEqual(streamed, []);
  const source = fragments.map(fragment => fragment.text).join('');
  assert.equal(fragments[0].start, 0); assert.equal(fragments.at(-1).stop, source.length);
  fragments.forEach((fragment, index) => { assert.equal(fragment.start, index ? fragments[index - 1].stop : 0); assert.equal(fragment.digest, digest(source)); });
  const quoted = JSON.parse(source);
  assert.equal(quoted.length, 2); assert.equal(quoted[0].message.role, 'assistant'); assert.equal(quoted[1].message.role, 'tool');
  assert.equal(quoted[1].message.content, result.messages.find(message => message.role === 'tool').content);
  assert.equal(result.messages.filter(message => message.kind === 'compaction_summary').length, 0);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'model.completed').length, 2);
  assert.equal(run.store.events(scope, 'run').filter(event => event.kind === 'context.summary_completed').length, summaries);
});

test('fresh complete tool observations remain intact when the hard request fits despite the soft target', async t => {
  const run = setup(t, { contextPolicy: { triggerRatio: .25, targetRatio: .1 } });
  let calls = 0, summaries = 0;
  run.ports.tools.execute = async () => ({ status: 'ok', content: 'Visible complete observation '.repeat(35) });
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final('Summary'); }
    if (++calls === 1) return toolResponse();
    assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('Visible complete observation')));
    return final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(summaries, 0);
});

for (const failure of ['missing', 'changed', 'invalid', 'disabled', 'mandatory']) test(`context ${failure} fails before an unadmitted model request`, async t => {
  const run = setup(t, { contextPolicy: failure === 'disabled' ? { enabled: false } : {} }); let models = 0;
  run.ports.model.generate = async () => { models++; return final(); };
  if (failure === 'missing') delete run.ports.context;
  if (failure === 'changed') run.ports.context.tokens.tokenizerDigest = 'changed';
  if (failure === 'invalid') run.ports.context.tokens.countRequest = async () => NaN;
  if (failure === 'disabled' || failure === 'mandatory') run.ports.context.tokens.countRequest = async () => 10000;
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.outcome, 'blocked'); assert.equal(models, 0);
  assert.equal(result.reason, { missing: 'context_port_missing', changed: 'context_tokenizer_binding_mismatch',
    invalid: 'context_token_count_invalid', disabled: 'context_compaction_disabled', mandatory: 'context_mandatory_state_over_budget' }[failure]);
});

test('idle policy: compaction renews its wait without publishing summary or activity frames', async t => {
  let clock = 0, tasks = 0, summaries = 0; const seen = [];
  const run = setup(t, { tools: [tool({ timeoutMs: 50 })], profile: { profileId: 'summary-idle', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'summary-idle/v1',
    contextWindow: 2400, maxOutputTokens: 128, requestTimeoutMs: 30, streaming: true, streamTimeoutPolicy: 'idle/v1',
    maxProviderRetries: 0, retryInitialDelayMs: 0 }, limits: { effectTimeoutMs: 100, maxWallMs: 10000 } });
  run.ports.model.generate = async (request, emit) => {
    if (request.purpose === 'compaction') {
      summaries++;
      for (let index = 0; index < 3; index++) { clock += 90; emit({ kind: 'activity', text: '' }); }
      emit({ kind: 'text', text: 'Hidden summary draft' }); return final('Archived notes');
    }
    if (++tasks === 1) return toolResponse();
    emit({ kind: 'text', text: 'Answer' }); return final('Answer');
  };
  const result = await run.worker({ monotonicNow: () => clock, onStream: (_, event) => seen.push(event) }).runUntilIdle(scope, 'run');
  assert.equal(result.finalText, 'Answer'); assert.ok(summaries > 0);
  assert.deepEqual(seen, [{ kind: 'text', text: 'Answer' }]);
});

test('PreCompact binds actual admitted original source and feedback remains visible to the task model', async t => {
  const hook = { hookId: 'precompact', sourceRef: 'host://precompact', bindingDigest: `sha256:${'a'.repeat(64)}`,
    executionPolicyDigest: `sha256:${'b'.repeat(64)}`, events: ['PreCompact'], readOnly: true, timeoutMs: 100,
    maxInputBytes: 100000, maxOutputBytes: 10000, failureMode: 'block' };
  const run = setup(t, { hooks: [hook] }); let tasks = 0, hooks = 0, summaries = 0;
  run.ports.hooks = { invoke: async request => {
    hooks++;
    assert.equal(summaries, 0); assert.equal(request.event, 'PreCompact');
    const source = request.input.compaction;
    assert.equal(source.messages.length, source.messageRefs.length);
    assert.ok(source.messages.some(message => message.role === 'tool' && message.content.includes('Observed')));
    assert.ok(source.messageRefs.every(ref => !source.retainedMessageRefs.includes(ref)));
    assert.equal(source.sourceMessageCount, 3);
    return hookResult(request, 'ok', { action: 'continue', additionalContext: ['Keep the exact evidence scope'], updatedArguments: null });
  } };
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      summaries++; assert.equal(hooks, 1); assert.equal(request.purpose, 'compaction'); return final('Untrusted historical notes');
    }
    if (++tasks === 1) return toolResponse();
    assert.ok(request.messages.some(message => message.kind === 'hook_context' && message.content.includes('Keep the exact evidence scope')));
    return final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(hooks, 1); assert.ok(summaries > 1);
  assert.deepEqual(result.hookState.feedback, []);
});

test('invalid or oversized summary proposals never replace the original transcript', async t => {
  const run = setup(t, { contextPolicy: { maxSummaryRetries: 1 } }); let tasks = 0, summaries = 0;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final('X'.repeat(400)); }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_summary_validation_exhausted'); assert.equal(summaries, 2);
  assert.equal(result.contextState.history, null); assert.equal(result.contextState.compaction.offset, 0);
  assert.ok(result.messages.some(message => message.role === 'tool' && message.content.includes('Observed')));
});

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: an estimated summary may exceed its target when complete requests fit`, async t => {
  const run = setup(t, { sqlite, contextPolicy: { summaryBudgetMode: 'context_bounded_estimate' } });
  let tasks = 0, summaries = 0;
  const notes = 'X'.repeat(400); // 100 estimated units exceeds the 80-unit summary target.
  run.ports.model.generate = async request => {
    assert.ok(count(request.messages, request.tools) + request.profile.maxOutputTokens <= request.profile.contextWindow);
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final(notes); }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(summaries > 1);
  assert.equal(result.contextState.history.summary, notes); assert.equal(result.contextState.compactions, 1);
  assert.equal(result.messages.some(message => message.content === notes), false);
});

for (const fragmented of [false, true]) test(`estimated summary checks the complete ${fragmented ? 'continuation' : 'sealed task'} envelope before advancing coverage`, async t => {
  const run = setup(t, { contextPolicy: { summaryBudgetMode: 'context_bounded_estimate', maxSummaryRetries: 1 } });
  let tasks = 0, summaries = 0;
  if (!fragmented) run.ports.tools.execute = async () => ({ status: 'ok', content: 'Short source' });
  // An independently small text count must not authorize an oversized wire envelope.
  run.ports.context.tokens.countText = async () => 1;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final('Y'.repeat(12000)); }
    if (++tasks === 1) return toolResponse();
    return { ...final(''), kind: 'context_overflow' };
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_summary_validation_exhausted'); assert.equal(summaries, 2);
  assert.equal(result.contextState.history, null); assert.equal(result.contextState.compaction.offset, 0);
  assert.deepEqual(result.contextState.compaction.coverage, []);
  assert.ok(result.messages.some(message => message.role === 'tool'));
});

test('summary tool calls are rejected data and never dispatched as task tools', async t => {
  const run = setup(t, { contextPolicy: { maxSummaryRetries: 1 } }); let task = 0, tools = 0, summaries = 0;
  run.ports.tools.execute = async () => { tools++; return { status: 'ok', content: 'Observed '.repeat(1300) }; };
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return toolResponse(); }
    return ++task === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_summary_retry_exhausted'); assert.equal(summaries, 2); assert.equal(tools, 1);
});

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: provider and invalid-summary retries keep separate durable limits`, async t => {
  const run = setup(t, { sqlite, contextPolicy: { maxSummaryRetries: 1 } });
  let tasks = 0, summaries = 0;
  run.ports.model.generate = async request => {
    if (request.purpose === 'compaction') {
      summaries++;
      if (summaries === 1) return { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage() };
      if (summaries === 2) return toolResponse();
      return final('Bounded historical notes');
    }
    return ++tasks === 1 ? toolResponse() : final('Task complete');
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed', result.reason);
  assert.equal(tasks, 2);
  assert.ok(summaries >= 3);
  assert.equal(result.usage.modelCalls, tasks + summaries);
  assert.equal(result.contextState.compactions, 1);
});

test('summary calls consume the same model budget and cannot spend the finalization reserve', async t => {
  const run = setup(t, { limits: { maxModelCalls: 2, finalizationReserveModelCalls: 1 } }); let tasks = 0, summaries = 0;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final('Untrusted notes'); }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(summaries, 0); assert.equal(result.usage.modelCalls, 1);
  assert.equal(result.reason, 'context_finalization_budget_unavailable');
});

test('SQLite reopen after a committed summary proposal seals it without another provider call or tool execution', async t => {
  const run = setup(t, { sqlite: true }); let tasks = 0, summaries = 0, tools = 0;
  run.ports.tools.execute = async () => { tools++; return { status: 'ok', content: 'Observed '.repeat(1300) }; };
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return final('Committed historical notes'); }
    return ++tasks === 1 ? toolResponse() : final();
  };
  await assert.rejects(run.worker({ onCheckpoint: async snapshot => {
    if (snapshot.contextState?.compaction?.proposal !== null && snapshot.contextState?.compaction?.proposal !== undefined) throw Error('simulated host delivery outage');
  } }).runUntilIdle(scope, 'run'), /delivery outage/);
  assert.equal(summaries, 1); assert.equal(tools, 1);
  const acceptedStop = run.store.load(scope, 'run').snapshot.contextState.compaction.chunk.stop;
  run.reopen();
  let firstResumedSource = null;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      firstResumedSource ??= JSON.parse(request.messages[1].content).source;
      summaries++; return final('Committed historical notes');
    }
    tasks++; return final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(tools, 1); assert.equal(firstResumedSource.start, acceptedStop);
});

test('private protocol replay stays outside quoted facts while historical images remain explicit media', async t => {
  const run = setup(t);
  const image = { type: 'image_url', image_url: { url: 'https://fixture.invalid/historical.png' } };
  const original = { role: 'assistant', content: 'Historical observation '.repeat(1000),
    providerReplay: { compatibilityDigest: 'fixture/v1', privateReasoning: 'NEVER-QUOTE-PRIVATE-REPLAY' },
    replayToolIds: { private: 'canonical' }, media: [image] };
  const snapshot = { ...run.snapshot, messages: [...run.snapshot.messages, original], phase: 'preparing_context' };
  const result = await planNativeContext(snapshot, run.config, run.config.tools, {
    countRequest: async (messages, tools) => count(messages, tools), countText: async text => Math.ceil(text.length / 4),
  }, digest, true, true);
  assert.equal(result.action, 'compact');
  const compaction = result.state.compaction, source = JSON.parse(compaction.sourceText);
  assert.equal(source[0].payloadDigest, digest(original));
  assert.equal(compaction.sourceText.includes('NEVER-QUOTE-PRIVATE-REPLAY'), false);
  assert.equal(compaction.sourceText.includes(image.image_url.url), false);
  assert.equal(source[0].message.media[0].type, 'historical_image_reference');
  assert.deepEqual(compaction.chunk.messages[1].media, [image]);
  assert.equal(snapshot.messages.at(-1).providerReplay.privateReasoning, 'NEVER-QUOTE-PRIVATE-REPLAY');
});

test('Unicode source fragmentation never separates surrogate pairs and reconstructs exact quoted observations', async t => {
  const run = setup(t), fragments = []; let tasks = 0;
  run.ports.tools.execute = async () => ({ status: 'ok', content: 'Read 😀 completed 行\n'.repeat(1300) });
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      const fragment = JSON.parse(request.messages[1].content).source;
      assert.equal(fragment.encoding, 'utf16-code-units/v1');
      assert.equal(/^[\uDC00-\uDFFF]/.test(fragment.text), false); assert.equal(/[\uD800-\uDBFF]$/.test(fragment.text), false);
      fragments.push(fragment); return final('Unicode historical notes');
    }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed');
  const source = JSON.parse(fragments.map(fragment => fragment.text).join(''));
  assert.equal(source.find(entry => entry.message.role === 'tool').message.content, result.messages.find(message => message.role === 'tool').content);
});

test('a tokenizer binding revoked during counting cannot admit a request', async t => {
  const run = setup(t); let models = 0;
  run.ports.context.tokens.countRequest = async () => { run.ports.context.tokens.tokenizerDigest = 'revoked'; return 1; };
  run.ports.model.generate = async () => { models++; return final(); };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_tokenizer_binding_mismatch'); assert.equal(models, 0);
});

test('a provider context overflow reduces the same uncommitted quote and never acknowledges the rejected source span', async t => {
  const run = setup(t); let tasks = 0, summaries = 0, firstStop = 0, secondStop = 0;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      const source = JSON.parse(request.messages[1].content).source;
      if (++summaries === 1) { firstStop = source.stop; return { ...final(''), kind: 'context_overflow' }; }
      if (summaries === 2) { secondStop = source.stop; assert.equal(source.start, 0); assert.ok(secondStop < firstStop); }
      return final('Covered notes');
    }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(secondStop > 0); assert.equal(result.usage.modelCalls, summaries + 2);
});

test('bounded output-limit summaries remain context only and do not spend task continuation counters', async t => {
  const run = setup(t); let tasks = 0, summaries = 0;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') { summaries++; return { ...final('Bounded historical notes'), kind: 'output_limit', textCommitVersion: 'provider-finished-text/v1' }; }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(summaries > 1); assert.equal(result.continuations, 0);
  assert.equal(result.messages.some(message => message.content === 'Bounded historical notes'), false);
});

test('an output-limit summary without provider completion cannot become historical notes', async t => {
  const run = setup(t); let tasks = 0;
  run.ports.model.generate = async request => request.messages[0]?.kind === 'compaction_instructions'
    ? { ...final('Uncommitted transport text'), kind: 'output_limit' } : ++tasks === 1 ? toolResponse() : final();
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'context_summary_provider_commit_missing');
  assert.equal(result.contextState.history, null); assert.equal(result.contextState.compaction.offset, 0);
});

test('summary timeout retries the frozen quote under the provider cap and discards a late result', async t => {
  const run = setup(t, { profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
    contextWindow: 2400, maxOutputTokens: 128, requestTimeoutMs: 25, retryInitialDelayMs: 0 } });
  let tasks = 0, summaries = 0, release;
  const delayed = new Promise(resolve => { release = resolve; }); let originalQuote;
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      if (++summaries === 1) { originalQuote = canonical(request.messages); return delayed; }
      if (summaries === 2) assert.equal(canonical(request.messages), originalQuote);
      return final('Covered notes');
    }
    return ++tasks === 1 ? toolResponse() : final();
  };
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.ok(summaries > 2); assert.equal(result.diagnostics.providerUsageIncomplete, true);
  const revision = result.revision; release(final('LATE SUMMARY MUST NOT COMMIT')); await delayed; await Promise.resolve();
  assert.equal(run.store.load(scope, 'run').snapshot.revision, revision);
  assert.equal(result.messages.some(message => message.content.includes('LATE SUMMARY')), false);
});

test('canceling a running summary preserves the completed tool and prevents any further model call', async t => {
  const run = setup(t); let tasks = 0, summaries = 0, tools = 0;
  let worker;
  run.ports.tools.execute = async () => { tools++; return { status: 'ok', content: 'Observed '.repeat(1300) }; };
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      summaries++; worker.submit(scope, 'run', { commandId: 'stop-summary', kind: 'cancel', payload: {} });
      return new Promise((_, reject) => { if (request.signal.aborted) reject(request.signal.reason);
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); });
    }
    return ++tasks === 1 ? toolResponse() : final();
  };
  worker = run.worker();
  const result = await worker.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'canceled'); assert.equal(summaries, 1); assert.equal(tools, 1); assert.equal(result.usage.modelCalls, 2);
  assert.ok(result.messages.some(message => message.role === 'tool' && message.content.includes('Observed')));
});

for (const recovery of ['manual', 'pure-inference/v1']) test(`actual process loss of a summary response respects ${recovery} recovery and retains the sealed quote`, async t => {
  const run = setup(t, { sqlite: true, modelRecoveryPolicy: recovery });
  const marker = join(run.filename, '..', 'dispatched-summary.json'); run.store.close();
  const script = `
    import {writeFileSync} from 'node:fs';
    import {NativeKernel,canonical,emptyUsage} from './packages/agentkit-harness-core/dist/index.mjs';
    import {SqliteRunStore} from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
    import {scope,digest} from './packages/agentkit-harness-core/test/fixtures.mjs';
    const store=new SqliteRunStore(${JSON.stringify(run.filename)});
    const worker=new NativeKernel({store,digest,owner:'exiting-summary-worker',ports:{
      context:{tokens:{tokenizerId:'fixture-counter',tokenizerDigest:'fixture-count/v1',
        countRequest:async request=>Math.ceil(canonical({messages:request.messages,tools:request.tools}).length/4),
        countText:async request=>Math.ceil(request.text.length/4)}},
      tools:{execute:async()=>({status:'ok',content:'Observed '.repeat(1300)})},
      model:{generate:async request=>{
        if(request.messages[0]?.kind==='compaction_instructions'){
          writeFileSync(${JSON.stringify(marker)},canonical({operationKey:request.operationKey,messages:request.messages}));process.exit(0);
        }
        return {kind:'tool_calls',text:'',toolCalls:[{callId:'read-source',name:'read',arguments:{}}],usage:emptyUsage()};
      }}
    }}); await worker.runUntilIdle(scope,'run'); throw Error('Expected abrupt summary worker exit');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-'], { input: script,
    cwd: new URL('../../../', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  const original = JSON.parse(readFileSync(marker, 'utf8'));
  run.reopen(); let summaries = 0, tools = 0;
  run.ports.tools.execute = async () => { tools++; throw Error('Completed tool must not replay'); };
  run.ports.model.generate = async request => {
    if (request.messages[0]?.kind === 'compaction_instructions') {
      if (++summaries === 1) { assert.equal(canonical(request.messages), canonical(original.messages)); assert.notEqual(request.operationKey, original.operationKey); }
      return final('Recovered historical notes');
    }
    return final();
  };
  const result = await run.worker({ owner: 'summary-takeover', now: () => Date.now() + 120000 }).runUntilIdle(scope, 'run');
  assert.equal(tools, 0);
  if (recovery === 'manual') { assert.equal(result.phase, 'interrupted'); assert.equal(summaries, 0); }
  else { assert.equal(result.phase, 'completed'); assert.ok(summaries > 1); assert.equal(result.usage.modelCalls, summaries + 3); }
  assert.equal(result.diagnostics.providerUsageIncomplete, true);
  assert.ok(run.store.load(scope, 'run').receipts.some(receipt => receipt.operationKey === original.operationKey && receipt.status === 'uncertain'));
});

test('successful new source observations advance compaction progress while identical repeated reads do not', async t => {
  const run = setup(t, { tools: [tool({ contextRole: 'workspace_read' })] }); let models = 0, reads = 0;
  run.ports.tools.execute = async () => ({ status: 'ok', content: ++reads <= 2 ? 'same observed page' : 'next actual page' });
  run.ports.model.generate = async () => {
    if (++models <= 3) return { ...toolResponse(), toolCalls: [{ callId: `page-${models}`, name: 'read', arguments: models === 3 ? { offset: 100 } : {} }] };
    return final();
  };
  const revisions = [];
  const result = await run.worker({ onCheckpoint: async snapshot => {
    if (snapshot.context.observedSourceRevision !== undefined) revisions.push(snapshot.context.observedSourceRevision);
  } }).runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.context.observedSourceRevision, 2);
  assert.equal(Object.keys(result.context.observedSourceDigests).length, 2);
  assert.ok(revisions.includes(1)); assert.ok(revisions.includes(2));
});

test('persistent tool results protect their complete call/result group during later compaction', async t => {
  const run = setup(t, { tools: [tool({ contextRetention: 'persistent' })] });
  const snapshot = { ...run.snapshot, phase: 'preparing_context', messages: [...run.snapshot.messages,
    { role: 'assistant', content: '', toolCalls: [{ callId: 'permanent', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'permanent', name: 'read', content: 'permanent observed state', persistent: true },
    { role: 'assistant', content: 'ordinary past prose '.repeat(1300) }] };
  const result = await planNativeContext(snapshot, run.config, run.config.tools, {
    countRequest: async (messages, tools) => count(messages, tools), countText: async text => Math.ceil(text.length / 4),
  }, digest, true, true);
  assert.equal(result.action, 'compact');
  const quoted = JSON.parse(result.state.compaction.sourceText);
  assert.equal(quoted.some(entry => entry.message.callId === 'permanent' || entry.message.toolCalls?.some(call => call.callId === 'permanent')), false);
  assert.equal(result.state.compaction.retainedRefs.length, 3);
});

test('pre-model budget compacts older history while retaining the entire fresh parallel tool batch', async t => {
  const run = setup(t, { contextPolicy: { budgetTiming: 'before-model/v1', triggerRatio: .4, targetRatio: .2 } });
  const old = [
    { role: 'assistant', content: '', toolCalls: [{ callId: 'old', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'old', content: 'Historical result '.repeat(220) },
  ];
  const latest = [
    { role: 'assistant', content: '', toolCalls: [{ callId: 'fresh-a', name: 'read', arguments: {} }, { callId: 'fresh-b', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'fresh-a', content: 'Fresh complete A' },
    { role: 'tool', callId: 'fresh-b', content: 'Fresh complete B' },
  ];
  const snapshot = { ...run.snapshot, phase: 'preparing_context', messages: [...run.snapshot.messages, ...old, ...latest] };
  assert.ok(count(snapshot.messages, run.config.tools) + run.config.profile.maxOutputTokens < run.config.profile.contextWindow);
  const plan = await planNativeContext(snapshot, run.config, run.config.tools, {
    countRequest: async (messages, tools) => count(messages, tools), countText: async text => Math.ceil(text.length / 4),
  }, digest, false, true);
  assert.equal(plan.action, 'compact');
  const quoted = JSON.parse(plan.state.compaction.sourceText);
  assert.deepEqual(quoted.map(entry => entry.message), old);
  assert.equal(quoted.some(entry => entry.message.callId?.startsWith('fresh')), false);
  assert.equal(plan.state.compaction.retainedRefs.length, run.snapshot.messages.length + latest.length);
  assert.deepEqual(snapshot.messages.slice(-3), latest);
});
