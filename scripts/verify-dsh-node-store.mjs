import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalDshSessionAdapter } from '../src/session-adapter.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDshRoot = resolve(projectRoot, '../../deepseek-harness');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || defaultDshRoot);
const fixture = JSON.parse(await readFile(join(projectRoot, 'tests/fixtures/p1-runtime-matrix.json'), 'utf8'));
const expectedPath = join(projectRoot, 'tests/fixtures/expected-p1-nodes.json');
const adapter = new CanonicalDshSessionAdapter();
const supplementalEvents = [
  {
    schema_version: 2, event_id: 'p1-goal-change', seq: 21, timestamp: 1700000103.3,
    run_id: 'p1-goal-run', scope_id: 'p1-goal-run',
    source: { framework: 'ksadk', protocol: 'a2ui', metadata: { turn: 4, step: 1 } },
    event_type: 'item.completed', item_id: 'p1-goal', item_kind: 'data',
    snapshot: { parts: [{ content_type: 'data', part_id: 'p1-goal-part', data: {
      type: 'goal/change', data: {
        kind: 'goal/change', version: 1, operation: 'create',
        goal: { id: 'goal-matrix', revision: 1, objective: 'verify', phase: 'active', maxGoalRounds: 3 },
        roundsStarted: 0, createdAt: 1, updatedAt: 1,
      },
    } }] },
  },
  {
    schema_version: 2, event_id: 'p1-deliverable-presented', seq: 22, timestamp: 1700000103.4,
    run_id: 'p1-goal-run', scope_id: 'p1-goal-run',
    source: { framework: 'ksadk', protocol: 'a2ui', metadata: { turn: 4, step: 1 } },
    event_type: 'item.completed', item_id: 'p1-deliverable', item_kind: 'data',
    snapshot: { parts: [{ content_type: 'data', part_id: 'p1-deliverable-part', data: {
      type: 'deliverables/presented', data: {
        turn: 4, callId: 'p1-call', files: [{ path: '/tmp/report.txt' }],
      },
    } }] },
  },
];
const lifecycle = [
  { operation: 'pause', goal: { id: 'goal-matrix', revision: 2, objective: 'verify', phase: 'paused', maxGoalRounds: 3 } },
  { operation: 'resume', goal: { id: 'goal-matrix', revision: 3, objective: 'verify', phase: 'active', maxGoalRounds: 3 } },
  { operation: 'complete', goal: { id: 'goal-matrix', revision: 4, objective: 'verify', phase: 'complete', maxGoalRounds: 3 } },
  { operation: 'create', goal: { id: 'goal-blocked', revision: 1, objective: 'inspect', phase: 'active', maxGoalRounds: 2 } },
  { operation: 'block', goal: { id: 'goal-blocked', revision: 2, objective: 'inspect', phase: 'blocked', maxGoalRounds: 2,
    blockedReason: { code: 'runtime-failed', message: 'Runtime stopped before completion' } } },
];
const lifecycleEvents = lifecycle.map(({ operation, goal }, index) => ({
  schema_version: 2, event_id: `p1-goal-${operation}`, seq: index + 23, timestamp: 1700000103.5 + index / 10,
  run_id: 'p1-goal-run', scope_id: 'p1-goal-run',
  source: { framework: 'ksadk', protocol: 'a2ui', metadata: { turn: 4, step: 1 } },
  event_type: 'item.completed', item_id: `p1-goal-${operation}`, item_kind: 'data',
  snapshot: { parts: [{ content_type: 'data', part_id: `p1-goal-${operation}-part`, data: {
    type: 'goal/change', data: {
      kind: 'goal/change', version: 1, operation, goal,
      roundsStarted: 0, createdAt: goal.id === 'goal-blocked' ? 5 : 1, updatedAt: index + 2,
    },
  } }] },
}));
const events = [
  // Deliberately feed a permuted canonical history page. The expected nodes
  // below were authored independently in expected-p1-nodes.json; in
  // particular the canceled run's late assistant item must never appear.
  ...adapter.wireSnapshot({ ...fixture, events: [...fixture.events].reverse() }),
  ...adapter.wireSnapshot({ session_id: fixture.session_id, watermark: 27, events: [...supplementalEvents, ...lifecycleEvents] }),
];
const temp = await mkdtemp(join(tmpdir(), 'agentkit-studio-dsh-node-store-'));
const projected = join(temp, 'projected-events.json');
await writeFile(projected, JSON.stringify(events));
const probe = join(dshRoot, 'scripts', `.agentkit-studio-node-store-${process.pid}.spec.ts`);
const probeSource = `
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConversationNodeAssembler } from '../packages/client/ui-conversation/src/client/index.ts'
import { messageDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { assistantDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { toolDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/tool.ts'
import { unknownFallbackDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/fallback.ts'
import { chatViewDefinition } from '../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { foldGoal } from '../packages/goal/goal/src/fold.ts'
class EventDefinitions { entries() { return [messageDefinition, assistantDefinition, toolDefinition] } fallbackEntry() { return unknownFallbackDefinition } }
class ViewDefinitions { entries() { return [chatViewDefinition] } }
const events = JSON.parse(readFileSync(${JSON.stringify(projected)}, 'utf8'))
const expected = JSON.parse(readFileSync(${JSON.stringify(expectedPath)}, 'utf8'))
describe('AgentKit Studio adapter in pinned official DSH node store', () => {
  it('publishes user, assistant reasoning, and tool result nodes from the independent fixture', () => {
    const assembler = new ConversationNodeAssembler(new EventDefinitions(), new ViewDefinitions())
    assembler.replaceWindow(events.map((event: Record<string, unknown>) => ({ type: 'event', event })), false)
    assembler.activateTarget('chat')
    const snapshot = assembler.snapshot('chat')
    if (snapshot === undefined) throw new Error('official DSH Chat snapshot was not published')
    const user = snapshot.nodes.values().find(node => node.kind === 'user')
    if (user === undefined) throw new Error('official DSH node store has no user node')
    const data = user.data as { content?: readonly { type?: string; text?: string }[] }
    const assistant = [...snapshot.nodes.values()].filter(node => node.kind === 'assistant-step' && node.visibility === 'visible')
    const tools = [...snapshot.nodes.values()].filter(node => node.kind === 'tool-call' && node.visibility === 'visible')
    const expectedNodes = JSON.parse(readFileSync(${JSON.stringify(expectedPath)}, 'utf8'))
    expect({ kind: user.kind, target: user.target, anchorSeq: user.anchorSeq, text: data.content?.find(part => part.type === 'text')?.text }).toEqual(expectedNodes.user)
    expect(assistant.map(node => ({ kind: node.kind, anchorSeq: node.anchorSeq, blocks: node.data.blocks }))).toEqual(expectedNodes.assistant)
    expect(tools.map(node => ({ kind: node.kind, anchorSeq: node.anchorSeq, callId: node.data.root.callId, result: 'kind' in node.data.root ? node.data.root.content : null }))).toEqual(expectedNodes.tool)
    // DSH intentionally does not materialize ignorable families as chat nodes;
    // assert that the adapter still emitted them with their official wire type
    // and that the assembler accepted the complete window without dropping the
    // proven nodes above.
    const preserved = events.map((event: Record<string, unknown>) => event.type)
    expect(preserved).toEqual(expect.arrayContaining([
      'approval/asked', 'approval/decided', 'goal/change', 'deliverables/presented',
    ]))
  })
  it('folds create, pause, resume, complete and blocked lifecycle through the official goal projection', () => {
    const goals = events.filter((event: Record<string, unknown>) => event.type === 'goal/change')
    expect(goals).toHaveLength(6)
    const expected = [
      { id: 'goal-matrix', revision: 1, phase: 'active' },
      { id: 'goal-matrix', revision: 2, phase: 'paused' },
      { id: 'goal-matrix', revision: 3, phase: 'active' },
      { id: 'goal-matrix', revision: 4, phase: 'complete' },
      { id: 'goal-blocked', revision: 1, phase: 'active' },
      { id: 'goal-blocked', revision: 2, phase: 'blocked' },
    ]
    for (let count = 1; count <= goals.length; count++) {
      const folded = foldGoal(goals.slice(0, count) as never)
      expect({ id: folded.goal?.id, revision: folded.goal?.revision, phase: folded.goal?.phase }).toEqual(expected[count - 1])
      expect(folded.roundsStarted).toBe(0)
    }
  })
})
`;
await writeFile(probe, probeSource);
try {
  execFileSync('pnpm', ['exec', 'vitest', 'run', probe.replace(`${dshRoot}/`, ''), '--config', 'vitest.config.ts'], {
    cwd: dshRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 30_000,
  });
} finally {
  await rm(probe, { force: true });
  await rm(temp, { recursive: true, force: true });
}
