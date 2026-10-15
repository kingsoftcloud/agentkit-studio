/** Real pinned DSH loop and Chat assembler; synthetic Codex stream, no model cost. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindDshAgentRoute, createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { CODEX_PROVIDER } from '../src/providers/codex-models.mjs';
import { codexConversationPrompt } from '../src/providers/codex-history.mjs';
import { CODEX_OBSERVATION_SOURCE, migrateLegacyCodexObservations } from '../src/providers/codex-observation.mjs';

const root = resolve(process.env.AGENTKIT_DSH_ROOT || fileURLToPath(new URL('../../../deepseek-harness', import.meta.url)));
const require = createRequire(join(root, 'packages/core/agent-loop/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: LlmRuntime, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { defineContentToolFixture } = await load('@deepseek-ai/dsh-tools');
const persistenceRequire = createRequire(join(root, 'packages/session/session-persistence-jsonl/package.json'));
const { default: JsonlPersistence } = await import(pathToFileURL(persistenceRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);
const histories = [];
const cases = ['lookup', 'codex/command'].flatMap(toolName => ['completed', 'failed', 'canceled'].map(outcome => ({ toolName, outcome })));
for (const { toolName, outcome } of cases) {
  const toolArgs = toolName === 'lookup' ? { card: 'P7' } : { command: 'python3 scripts/check.py', cwd: '/imported/skill' };
  const ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore);
  for (const name of ['session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop']) await ctx.plugin((await load(`@deepseek-ai/dsh-${name}`)).default, name === 'agent-loop' ? { agents: [] } : undefined);
  let executions = 0, streamed = 0;
  ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Must never dispatch from DSH', parameters: {}, execute: async () => { executions++; return [{ type: 'text', text: 'incorrect execution' }]; } }));
  const adapter = createDshRuntimeAdapter({ AdapterBase: LlmAdapter, codexRuntime: { async *stream({ messages }) {
    streamed++;
    if (streamed > 1) {
      const observations = messages.filter(message => message.source?.kind === CODEX_OBSERVATION_SOURCE);
      assert.equal(observations.length, 1);
      if (outcome === 'canceled') assert.match(observations[0].content[0].text, /CODEX_TOOL_OUTCOME_UNKNOWN/);
      else assert.match(observations[0].content[0].text, /result-canary/);
      yield { type: 'text', text: 'Recalled the recorded observation' };
      return;
    }
    yield { type: 'tool', phase: 'started', name: toolName, id: 'same-provider-id', arguments: toolArgs };
    if (outcome === 'canceled') throw Object.assign(new Error('canceled'), { code: 'CODEX_CANCELED' });
    yield { type: 'tool', phase: outcome, name: toolName, id: 'same-provider-id', arguments: toolArgs, result: { content: [{ type: 'text', text: 'result-canary' }] }, ...(outcome === 'failed' ? { error: { message: 'upstream-rejected' } } : {}) };
    yield { type: 'text', text: 'Final answer' };
  } } });
  const disposeAdapter = ctx.llm.registerAdapter([CODEX_PROVIDER], adapter);
  const agent = await ctx.agentLoop.create(SessionId(`codex-cards-${outcome}`), { provider: CODEX_PROVIDER, model: 'fixture' }, { cwd: process.cwd() });
  const disposeRoute = bindDshAgentRoute(agent.id, { agentId: 'fixture', runtime: 'codex', local: true, agent });
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '查询 P7' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    const tools = events.filter(event => event.type === 'agentkit/codex-tool');
    assert.equal(streamed, 1); assert.equal(executions, 0, 'Codex calls must not dispatch through DSH again');
    assert.equal(tools.length, 2); assert.equal(tools[1].data.phase, outcome === 'canceled' ? 'failed' : outcome);
    if (outcome === 'canceled') assert.equal(tools[1].data.error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
    assert.equal(events.some(event => event.type === 'tool/call' || event.type === 'tool/result'), false);
    const derived = agent.session.deriveMessages();
    assert.equal(derived.some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call')), false);
    // Native model observations survive replay without requiring Studio event consumers.
    const seed = JSON.parse(JSON.stringify(events));
    const restored = ctx.sessions.create(SessionId(`restored-${outcome}`), { seed });
    assert.deepEqual(restored.deriveMessages(), derived);
    const observations = derived.filter(message => message.source?.kind === CODEX_OBSERVATION_SOURCE);
    assert.equal(observations.length, 1);
    const withoutCards = ctx.sessions.create(SessionId(`without-cards-${outcome}`), { seed: seed.map(event => event.type === 'agentkit/codex-tool' ? { ...event, type: 'reader-unknown/presentation', data: {} } : event) });
    assert.deepEqual(withoutCards.deriveMessages(), derived, 'ignoring presentation payloads cannot change model history');
    const disk = await mkdtemp(join(tmpdir(), 'studio-codex-persistence-'));
    try {
      const writerContext = new Context();
      try {
        await writerContext.plugin(JsonlPersistence, { root: disk, compression: 'zstd' });
        const writer = await writerContext.sessionPersistence.create(agent.session.header);
        try { await writer.append(events); } finally { await writer.close(); }
      } finally { await writerContext.fiber.dispose(); }
      const readerContext = new Context();
      try {
        await readerContext.plugin(JsonlPersistence, { root: disk, compression: 'zstd' });
        const reader = await readerContext.sessionPersistence.open(agent.id, 'read');
        try {
          const reopened = (await reader.read()).events;
          assert.deepEqual(reopened, events);
          const replay = ctx.sessions.create(SessionId(`disk-replayed-${outcome}`), { seed: reopened });
          assert.deepEqual(replay.deriveMessages(), derived);
        } finally { await reader.close(); }
      } finally { await readerContext.fiber.dispose(); }
    } finally { await rm(disk, { recursive: true, force: true }); }
    histories.push({ outcome, toolArgs, events: seed });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recall the previous tool result without executing it again' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(streamed, 2);
    assert.equal(executions, 0);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'agentkit/codex-tool').length, 2);
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
    const beforeReplacement = agent.session.snapshotEvents();
    const lastObservation = beforeReplacement.findLast(event => event.type === 'user/message' && event.data.source.kind === CODEX_OBSERVATION_SOURCE);
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted tool context' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: lastObservation.seq, endSeq: lastObservation.seq }, sourceEventSeqs: [lastObservation.seq],
    });
    migrateLegacyCodexObservations(agent.session);
    const replacementPrompt = codexConversationPrompt({ input: 'continue', messages: agent.session.deriveMessages() });
    assert.doesNotMatch(replacementPrompt, /result-canary|CODEX_TOOL_OUTCOME_UNKNOWN/);
    assert.deepEqual(agent.session.snapshotEvents().slice(0, beforeReplacement.length), beforeReplacement);
    const replacedReplay = ctx.sessions.create(SessionId(`replaced-${outcome}`), { seed: agent.session.snapshotEvents() });
    migrateLegacyCodexObservations(replacedReplay);
    assert.equal(codexConversationPrompt({ input: 'continue', messages: replacedReplay.deriveMessages() }), replacementPrompt);
    console.log(JSON.stringify({ outcome, toolName, recorded: tools.length, dshExecutions: executions, restored: true, diskReopened: true, nextTurnContext: true, presentationOptional: true, replacedObservationNotReintroduced: true }));
  } finally { disposeRoute(); disposeAdapter(); await ctx.fiber.dispose(); }
}

// Independently authored legacy log: no new native observations in the fixture.
for (const replaced of [false, true]) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  try {
    const session = ctx.sessions.create(SessionId(`legacy-codex-${replaced}`));
    session.append('turn/start', { turn: 1 });
    const original = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Legacy lookup' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('agentkit/codex-tool', { callId: 'legacy:lookup', name: 'lookup', phase: 'completed', arguments: '{}', content: [{ type: 'text', text: 'legacy-result-canary' }] }, { ignorable: true });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    if (replaced) session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Replacement without old details' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
    const oldEvents = session.snapshotEvents();
    migrateLegacyCodexObservations(session);
    const after = session.snapshotEvents();
    assert.deepEqual(after.slice(0, oldEvents.length), oldEvents);
    const prompt = codexConversationPrompt({ input: 'continue', messages: session.deriveMessages() });
    assert.equal(prompt.includes('legacy-result-canary'), !replaced);
    migrateLegacyCodexObservations(session);
    assert.deepEqual(session.snapshotEvents(), after, 'import is idempotent');
    const reopened = ctx.sessions.create(SessionId(`legacy-reopened-${replaced}`), { seed: JSON.parse(JSON.stringify(after)) });
    const resumed = reopened.snapshotEvents();
    assert.deepEqual(resumed.slice(0, after.length), after);
    assert.equal(resumed.at(-1).type, 'session/end-seed');
    migrateLegacyCodexObservations(reopened);
    assert.deepEqual(reopened.snapshotEvents(), resumed);
    assert.equal(codexConversationPrompt({ input: 'continue', messages: reopened.deriveMessages() }), prompt);
    if (!replaced) {
      const observation = after.find(event => event.type === 'user/message' && event.data.source.kind === CODEX_OBSERVATION_SOURCE);
      reopened.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compacted observation' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: observation.seq, endSeq: observation.seq }, sourceEventSeqs: [observation.seq] });
      migrateLegacyCodexObservations(reopened);
      assert.doesNotMatch(codexConversationPrompt({ input: 'continue', messages: reopened.deriveMessages() }), /legacy-result-canary/);
    }
    console.log(JSON.stringify({ legacyImport: true, replaced, oldEventsUnchanged: true, idempotent: true, reopen: true, shadowedNotResurrected: true }));
  } finally { await ctx.fiber.dispose(); }
}

const temp = await mkdtemp(join(tmpdir(), 'studio-codex-cards-'));
const fixture = join(temp, 'events.json');
await writeFile(fixture, JSON.stringify(histories));
const definitionModule = fileURLToPath(new URL('../src/client/dsh/codex-tool.mjs', import.meta.url));
const probe = join(root, 'scripts', `.studio-codex-cards-${process.pid}.spec.ts`);
await writeFile(probe, `
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ConversationNodeAssembler } from '../packages/client/ui-conversation/src/client/index.ts'
import { chatViewDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { codexToolDefinition as definition } from ${JSON.stringify(definitionModule)}
const histories = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf8'))
it('uses the official Chat tool payload live, after JSON replay, and with a result-only window', () => {
  for (const { outcome, toolArgs, events } of histories) {
    const assembler = new ConversationNodeAssembler({ entries: () => [definition], fallbackEntry: () => undefined }, { entries: () => [chatViewDefinition] })
    assembler.activateTarget('chat')
    const tools = events.filter(event => event.type === 'agentkit/codex-tool')
    const prefix = events.filter(event => event.seq <= tools[0].seq)
    assembler.replaceWindow(prefix.map(event => ({ type: 'event', event })), false)
    assembler.flush()
    expect([...assembler.snapshot('chat').nodes.values()][0].data.root.phase).toBe('start')
    for (const window of [events, events.filter(event => event.seq >= tools[1].seq)]) {
      assembler.replaceWindow(window.map(event => ({ type: 'event', event })), false)
      assembler.flush()
      const cards = [...assembler.snapshot('chat').nodes.values()]
      expect(cards).toHaveLength(1)
      expect(cards[0].kind).toBe('tool-call')
      expect(cards[0].data.root.call.argsRaw).toBe(JSON.stringify(toolArgs))
      expect(cards[0].data.root.isError).toBe(outcome !== 'completed')
      if (outcome !== 'canceled') expect(cards[0].data.root.content[0].text).toBe('result-canary')
    }
  }
})
`);
try {
  execFileSync('pnpm', ['exec', 'vitest', 'run', probe.slice(root.length + 1), '--config', 'vitest.config.ts'], { cwd: root, stdio: 'inherit', timeout: 30_000 });
} finally { await rm(probe, { force: true }); await rm(temp, { recursive: true, force: true }); }
