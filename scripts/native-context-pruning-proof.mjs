/** Actual tokenizer/Host/commands: deterministic cleanup before full summary. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

export function createContextPruningProof() {
  let issued = 0, firstCleared = null, cold = false;
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions'); const body = JSON.parse(raw); requests.push(body);
    assert.ok(requests.length <= 12, 'Bounded task; no summary or unplanned retry calls');
    assert.ok(!body.messages[0]?.content.startsWith('Summarize the quoted historical data'), 'No model summary is needed for local cleanup');
    const cleared = body.messages.filter(message => message.role === 'tool').some(message => message.content.includes('historical_tool_result_cleared'));
    if (cleared && firstCleared === null) firstCleared = requests.length;
    let delta;
    if (cold || cleared) delta = { content: cold ? 'Cold cleanup verified' : 'Early cleanup verified' };
    else {
      assert.ok(++issued <= 10, 'Expected early cleanup of older successful command output');
      const code = `console.log(Array.from({length:150},(_,i)=>"EVIDENCE_${issued}_"+i+" stable token data").join("\\n"))`;
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
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const sessionId = 'native-studio-session';
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, sessionId).runId); } finally { store.close(); } };
    try {
      const firstTurn = await harness.session(sessionId).run('Inspect independent command evidence, then finish once old outputs are locally cleared.');
      await writeFile(join(root, 'context-pruning-first-turn.json'), JSON.stringify(firstTurn));
      assert.equal(firstTurn.finalResponse, 'Early cleanup verified');
      const identity = parseNativeJson(firstTurn.events.find(event => event.type === 'turn/owner').data.binding).identity;
      const original = load(identity.scope, identity.runId), policy = original.configuration.contextPolicy;
      assert.equal(policy.pruneThresholdPolicy, 'zcode-local/v1'); assert.equal(policy.pruneThresholdTokens, undefined);
      const full = (original.configuration.profile.contextWindow - original.configuration.profile.maxOutputTokens) * policy.triggerRatio;
      const facts = original.events.filter(event => event.kind === 'context.tool_results_pruned');
      assert.ok(facts.some(event => event.payload.preInputTokens < full && event.payload.savedTokens >= policy.pruneMinSavedTokens),
        'Actual request counter proves cleanup occurred before the full summary threshold');
      assert.ok(original.snapshot.messages.some(message => message.role === 'tool' && message.content.includes('EVIDENCE_1_')), 'Original transcript remains available');
      assert.equal(original.snapshot.contextState.compactions, 0);
      assert.equal(original.intents.filter(intent => intent.kind === 'tool').length, issued);
      cold = true; await harness.close(); harness = new DeepSeekHarness(options);
      assert.equal((await (await harness.resumeSession(sessionId)).run('Continue without repeating the commands.')).finalResponse, 'Cold cleanup verified');
      assert.deepEqual(load(identity.scope, identity.runId), original);
      assert.equal(load(identity.scope).intents.filter(intent => intent.kind === 'tool').length, 0);
      assert.deepEqual(failures, []);
      await writeFile(join(root, 'context-pruning-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        commandCalls: issued, firstClearedRequest: firstCleared, fullCompactThreshold: full, pruning: facts.map(event => event.payload),
        scope: 'Actual packed Frozen Build Host, local command output, normal tokenizer/request counter, earlier default cleanup and cold continuation; controlled model, no quality or cost benchmark.' }, null, 2));
      console.log('Studio Native early context cleanup PASS: real commands/counter, no summary call, cold continuation without replay.');
    } finally { await harness.close(); }
  }
  return { respond, run };
}
