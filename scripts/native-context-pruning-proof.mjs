import { createRequire } from 'node:module';
/** Actual tokenizer/Host/commands: deterministic cleanup before full summary. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

export function createContextPruningProof({ summary = false, idle = false } = {}) {
  let issued = 0, firstCleared = null, cold = false, summaryCalls = 0;
  const summarySources = [];
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    assert.ok(requests.length <= 12, 'Bounded task and summaries');
    const isSummary = body.messages[0]?.content.startsWith('Summarize the quoted historical data');
    assert.ok(summary || !isSummary, 'No model summary is needed for early local cleanup');
    const cleared = body.messages.filter(message => message.role === 'tool').some(message => message.content.includes('historical_tool_result_cleared'));
    if (cleared && firstCleared === null) firstCleared = requests.length;
    let delta;
    if (isSummary) {
      summaryCalls++;
      const source = JSON.parse(body.messages.find(message => message.role === 'user').content).source;
      assert.ok(!/EVIDENCE_1_\d+ stable token data/.test(source.text),
        'Summary never consumes the cleared old command output; original call arguments remain available');
      summarySources.push(source);
      delta = { content: 'The local commands completed. Newer EVIDENCE_2_ observations are available in the original transcript.' };
    } else if (cold || cleared || summaryCalls) delta = { content: cold ? 'Cold cleanup verified'
      : summary ? 'Cleaned summary verified' : 'Early cleanup verified' };
    else {
      assert.ok(++issued <= 10, 'Expected early cleanup of older successful command output');
      assert.ok(!summary || issued <= 2, 'Summary scenario requires exactly two real commands');
      const code = `console.log(Array.from({length:${summary ? issued === 1 ? 600 : 900 : 150}},(_,i)=>"EVIDENCE_${issued}_"+i+" stable token data").join("\\n"))`;
      const command = `${JSON.stringify(process.execPath)} -e '${code}'`;
      delta = { tool_calls: [{ index: 0, id: `pruning-${issued}`, type: 'function', function: {
        name: 'run_command', arguments: JSON.stringify({ command }) } }] };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(`data: ${JSON.stringify({ id: `pruning-${requests.length}`, choices: [{ index: 0, delta,
      finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  }
  async function run({ harness: first, DeepSeekHarness, options, root, installed, requests, failures }) {
    let harness = first;
    const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')).href);
    const sessionId = 'native-studio-session';
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    try {
      const firstTurn = await harness.session(sessionId).run('Inspect independent command evidence, then finish once old outputs are locally cleared.');
      await writeFile(join(root, 'context-pruning-first-turn.json'), JSON.stringify(firstTurn));
      await writeFile(join(root, 'context-pruning-http-evidence.json'), JSON.stringify({ requests, failures }, null, 2));
      assert.equal(firstTurn.finalResponse, summary ? 'Cleaned summary verified' : 'Early cleanup verified');
      const identity = parseNativeJson(firstTurn.events.find(event => event.type === 'turn/owner').data.binding).identity;
      const original = load(identity.scope, identity.runId), policy = original.configuration.contextPolicy;
      assert.equal(policy.pruneThresholdPolicy, idle ? undefined : 'zcode-local/v1');
      assert.equal(policy.pruneThresholdTokens, idle ? 100000 : undefined);
      assert.equal(policy.pruneSummaryPolicy, 'zcode-local/v1');
      assert.equal(policy.pruneIdleThresholdMinutes, idle ? 0 : 60);
      const full = (original.configuration.profile.contextWindow - original.configuration.profile.maxOutputTokens) * policy.triggerRatio;
      const facts = original.events.filter(event => event.kind === 'context.tool_results_pruned');
      if (summary) {
        assert.equal(issued, 2); assert.ok(summaryCalls >= 1 && summaryCalls <= 6);
        assert.ok(facts.some(event => event.payload.postInputTokens >= full && event.payload.savedTokens >= policy.pruneMinSavedTokens));
        assert.ok(summarySources.some(source => source.text.includes('historical_tool_result_cleared')));
        assert.ok(summarySources.some(source => source.text.includes('EVIDENCE_2_')));
        assert.equal(original.snapshot.contextState.compactions, 1);
      } else {
        assert.ok(facts.some(event => event.payload.preInputTokens < full && event.payload.savedTokens >= policy.pruneMinSavedTokens),
          'Actual request counter proves cleanup occurred before the full summary threshold');
        assert.equal(original.snapshot.contextState.compactions, 0);
        if (idle) {
          assert.equal(issued, 2);
          assert.ok(facts.some(event => event.payload.trigger === 'idle' && event.payload.idleElapsedMs > 0
            && event.payload.preInputTokens < policy.pruneThresholdTokens), 'Idle observation triggers cleanup without token pressure');
          assert.ok(original.snapshot.messages.filter(message => message.role === 'assistant').every(message => Number.isSafeInteger(message.completedAtMs)));
          assert.ok(!JSON.stringify(requests).includes('completedAtMs'), 'Internal completion clocks never become provider protocol fields');
        }
      }
      assert.ok(original.snapshot.messages.some(message => message.role === 'tool' && message.content.includes('EVIDENCE_1_')), 'Original transcript remains available');
      assert.equal(original.intents.filter(intent => intent.kind === 'tool').length, issued);
      cold = true; await harness.close(); harness = new DeepSeekHarness(options);
      const continued = await (await harness.resumeSession(sessionId)).run('Continue without repeating the commands.');
      await writeFile(join(root, 'context-pruning-http-evidence.json'), JSON.stringify({ requests, failures }, null, 2));
      assert.equal(continued.finalResponse, 'Cold cleanup verified');
      assert.deepEqual(load(identity.scope, identity.runId), original);
      const followup = load(identity.scope);
      assert.equal(followup.intents.filter(intent => intent.kind === 'tool').length, 0);
      const coldPruning = followup.events.filter(event => event.kind === 'context.tool_results_pruned').map(event => event.payload);
      if (idle) {
        assert.equal(followup.configuration.contextPolicy.pruneIdleThresholdMinutes, 0);
        assert.ok(coldPruning.some(fact => fact.trigger === 'idle' && fact.idleElapsedMs > 0));
        assert.ok(followup.snapshot.messages.some(message => message.history && Number.isSafeInteger(message.completedAtMs)));
      }
      assert.deepEqual(failures, []);
      await writeFile(join(root, 'context-pruning-proof.json'), JSON.stringify({ passed: true, summary, idle, summaryCalls, modelCalls: requests.length,
        commandCalls: issued, firstClearedRequest: firstCleared, fullCompactThreshold: full, pruning: facts.map(event => event.payload), coldPruning,
        scope: 'Actual packed Frozen Build Host, local command output, normal tokenizer/request counter, default cleanup and optional still-needed summary, cold continuation; controlled model, no quality or cost benchmark.' }, null, 2));
      console.log(`Studio Native context cleanup PASS: real commands/counter, ${summaryCalls} summary calls, cold continuation without replay.`);
    } finally { await harness.close(); }
  }
  return { respond, run };
}
