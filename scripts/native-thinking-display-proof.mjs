/** Public provider reasoning through the packed Host, local history and cold continuation. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';

const firstThought = 'NATIVE_THINK_FIRST\n\nInspect the target.';
const interruptedThought = 'NATIVE_THINK_INTERRUPTED\n\nAwaiting the provider.';
const rows = async path => (await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
})).trim().split('\n').filter(Boolean).map(JSON.parse);

export function createThinkingDisplayProof() {
  let root;
  const livePrefixes = [];
  async function publicPrefix(text) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const frames = (await rows(join(root, 'assistant-stream.jsonl'))).map(row => row.frame);
      const chunk = frames.find(frame => frame.chunk?.text === text);
      if (chunk) {
        const current = frames.filter(frame => frame.attemptId === chunk.attemptId);
        assert.ok(current.some(frame => frame.type === 'start'));
        assert.ok(!current.some(frame => frame.type === 'end'), 'Thinking is visible before durable settlement');
        livePrefixes.push({ text, frames: current });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`No public thinking prefix before provider completion: ${text}`);
  }
  async function respond({ request, response, raw, requests }) {
    assert.equal(request.url, '/v1/chat/completions');
    const body = JSON.parse(raw); requests.push(body);
    const count = requests.length;
    assert.ok(count <= 4, 'Two normal calls, one interrupted call, one recovery; no extra reasoning call');
    assert.equal(body.provider_thinking_display, undefined, 'Visibility is a local option, not a generation parameter');
    assert.ok(body.messages.some(message => message.role === 'system' && message.content.includes('FROZEN_NATIVE_SYSTEM_A')));
    assert.ok(!JSON.stringify(body.messages).includes('LATEST_NATIVE_SYSTEM_B'));
    if (count === 4) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', reasoning_content: 'NATIVE_THINK_RECOVERED', content: 'Thinking connection recovered' } }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `thinking-${count}`,
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (count === 1 || count === 3) {
      const thought = count === 1 ? firstThought : interruptedThought;
      send({ reasoning_content: thought });
      if (count === 3) send({ content: 'Incomplete public answer' });
      await publicPrefix(thought);
      assert.equal((await rows(join(root, 'tool-admissions.jsonl'))).length, count === 1 ? 0 : 1);
      if (count === 3) {
        send({ tool_calls: [{ index: 0, id: 'unsealed-preview', type: 'function',
          function: { name: 'write_workspace_file', arguments: '{"path":' } }] });
        // A fully delivered SSE prefix followed by an actual transport failure.
        await new Promise(resolve => setTimeout(resolve, 30));
        response.destroy(); return;
      }
      send({ tool_calls: [{ index: 0, id: 'thinking-write', type: 'function', function: {
        name: 'write_workspace_file', arguments: JSON.stringify({ path: 'thinking-marker.txt', content: 'exactly-once' }) } }] }, 'tool_calls');
    } else {
      if (count === 2) assert.ok(body.messages.some(message => message.role === 'tool'));
      send({ reasoning_content: count === 2 ? 'NATIVE_THINK_FINAL' : 'NATIVE_THINK_RECOVERED' });
      send({ content: count === 2 ? 'Thinking marker published' : 'Thinking connection recovered' }, 'stop');
    }
    response.end('data: [DONE]\n\n');
  }
  async function run({ harness: first, DeepSeekHarness, options, root: directory, installed, requests, failures }) {
    root = directory; let harness = first;
    const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')).href);
    const load = (scope, runId) => { const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
      try { return store.load(scope, runId ?? store.sessionHead(scope, 'native-studio-session').runId); } finally { store.close(); } };
    try {
      const firstTurn = await harness.session('native-studio-session').run('Publish the thinking marker once and report completion.');
      await writeFile(join(root, 'thinking-first-turn.json'), JSON.stringify(firstTurn));
      assert.equal(firstTurn.finalResponse, 'Thinking marker published');
      const identity = parseNativeJson(firstTurn.events.find(event => event.type === 'turn/owner').data.binding).identity;
      const original = load(identity.scope, identity.runId);
      assert.equal(original.configuration.profile.providerThinkingDisplay, true);
      assert.equal(original.configuration.profile.providerThinkingDisplayPolicy, 'provider-visible/v1');
      assert.equal(original.intents.filter(intent => intent.kind === 'tool').length, 1);
      const content = firstTurn.events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content);
      assert.ok(content.some(block => block.type === 'reasoning' && block.text === firstThought));
      assert.ok(!original.snapshot.messages.some(message => message.content?.includes('NATIVE_THINK_')),
        'Display content never becomes canonical assistant prose');
      await harness.close(); harness = new DeepSeekHarness(options);
      const secondTurn = await (await harness.resumeSession('native-studio-session')).run('Continue after a provider disconnect without repeating the write.');
      await writeFile(join(root, 'thinking-second-turn.json'), JSON.stringify(secondTurn));
      assert.equal(secondTurn.finalResponse, 'Thinking connection recovered');
      assert.deepEqual(load(identity.scope, identity.runId), original, 'Cold continuation does not rewrite the original Run');
      const next = load(identity.scope);
      assert.equal(next.intents.filter(intent => intent.kind === 'tool').length, 0);
      assert.ok(secondTurn.events.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'reasoning' && block.text === 'NATIVE_THINK_RECOVERED')),
      'Buffered provider fallback also persists visible reasoning');
      const incomplete = secondTurn.events.filter(event => event.type === 'assistant/message' && event.data.interrupted);
      assert.equal(incomplete.length, 1);
      assert.deepEqual(incomplete[0].data.message.content, [{ type: 'reasoning', text: interruptedThought },
        { type: 'text', text: 'Incomplete public answer' }]);
      assert.ok(!incomplete[0].data.message.content.some(block => block.type === 'tool-call'));
      assert.equal((await rows(join(root, 'tool-admissions.jsonl'))).length, 1);
      assert.equal(await readFile(join(root, 'workspace/thinking-marker.txt'), 'utf8'), 'exactly-once');
      assert.deepEqual(failures, []);
      assert.equal(requests.length, 4); assert.equal(livePrefixes.length, 2);
      await harness.close(); harness = null;
      const paths = (await readdir(join(root, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'));
      assert.equal(paths.length, 1);
      const history = (await rows(join(root, 'sessions', paths[0]))).filter(event => Number.isSafeInteger(event.seq) && typeof event.type === 'string');
      assert.ok(history.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'reasoning' && block.text === firstThought)));
      const frames = (await rows(join(root, 'assistant-stream.jsonl'))).map(row => row.frame);
      const ended = frames.filter(frame => frame.type === 'end');
      assert.equal(ended.length, 4);
      for (const frame of ended) {
        assert.equal(frame.outcome.eventType, 'assistant/message');
        assert.ok(history.some(event => event.seq === frame.outcome.seq && event.type === frame.outcome.eventType));
      }
      await writeFile(join(root, 'thinking-http-evidence.json'), JSON.stringify({ requests, failures }, null, 2));
      await writeFile(join(root, 'thinking-live-prefixes.json'), JSON.stringify(livePrefixes));
      await writeFile(join(root, 'thinking-display-proof.json'), JSON.stringify({ passed: true, modelCalls: requests.length,
        toolCalls: 1, interruptedMessages: incomplete.length, livePrefixes: livePrefixes.length, persistedFrames: frames.length,
        scope: 'Actual packed Frozen local Host, controlled provider reasoning, transport disconnect, cold continuation and persisted Session history. UI rendering and live model quality are separate checks.' }, null, 2));
      console.log('Studio Native thinking PASS: live reasoning, durable content, interrupted prefix, cold continuation, one write and four model calls.');
    } finally { await harness?.close(); }
  }
  return { respond, run };
}
