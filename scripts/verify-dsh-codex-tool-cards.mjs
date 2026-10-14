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
import { codexToolHistory } from '../src/providers/codex-history.mjs';

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
  const adapter = createDshRuntimeAdapter({ AdapterBase: LlmAdapter, codexRuntime: { async *stream({ toolHistory }) {
    streamed++;
    if (streamed > 1) {
      assert.equal(toolHistory.length, 1);
      if (outcome === 'canceled') assert.equal(toolHistory[0].error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
      else assert.equal(toolHistory[0].content[0].text, 'result-canary');
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
    // JSON persistence and Session replay retain the facts without altering model history.
    const seed = JSON.parse(JSON.stringify(events));
    const restored = ctx.sessions.create(SessionId(`restored-${outcome}`), { seed });
    assert.deepEqual(restored.deriveMessages(), derived);
    assert.deepEqual(codexToolHistory(restored), codexToolHistory(agent.session));
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
          assert.deepEqual(codexToolHistory(replay), codexToolHistory(agent.session));
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
    console.log(JSON.stringify({ outcome, toolName, recorded: tools.length, dshExecutions: executions, restored: true, diskReopened: true, nextTurnContext: true }));
  } finally { disposeRoute(); disposeAdapter(); await ctx.fiber.dispose(); }
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
