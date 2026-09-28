import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalDshSessionAdapter } from '../src/session-adapter.mjs';

/**
 * Project one real official DSH SDK transcript through the Studio adapter and
 * assert the resulting nodes in DSH's own ConversationNodeAssembler. The
 * expected text is deliberately independent of the mapper output: a passing
 * result proves the live SDK boundary is visible in the official node store.
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultDshRoot = resolve(projectRoot, '../../deepseek-harness');
const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || defaultDshRoot);
const reportPath = resolve(process.argv[2] || resolve(projectRoot, '../.scratch/studio-dsh-native-2026-09-24/rc1-sdk-canonical-2026-09-24.json'));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const canonical = report.canonical;
const adapter = new CanonicalDshSessionAdapter();
const wire = adapter.wireSnapshot({
  session_id: 'sdk-canonical-session',
  watermark: canonical.watermark,
  events: canonical.events,
});
const temp = await mkdtemp(join(tmpdir(), 'agentkit-studio-dsh-sdk-node-store-'));
const projected = join(temp, 'projected-events.json');
await writeFile(projected, JSON.stringify(wire));
const probe = join(dshRoot, 'scripts', `.agentkit-studio-sdk-node-store-${process.pid}.spec.ts`);
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
describe('live official DSH SDK transcript in the pinned node store', () => {
  it('renders the real user prompt and assistant answer', () => {
    const assembler = new ConversationNodeAssembler(new EventDefinitions(), new ViewDefinitions())
    assembler.replaceWindow(events.map((event: Record<string, unknown>) => ({ type: 'event', event })), false)
    assembler.activateTarget('chat')
    const snapshot = assembler.snapshot('chat')
    if (snapshot === undefined) throw new Error('official DSH Chat snapshot was not published')
    const user = snapshot.nodes.values().find(node => node.kind === 'user')
    if (user === undefined) throw new Error('official DSH node store has no user node')
    const userData = user.data as { content?: readonly { type?: string; text?: string }[] }
    expect(userData.content?.find(part => part.type === 'text')?.text).toBe('Reply with a short confirmation and do not call tools.')
    const assistant = [...snapshot.nodes.values()].filter(node => node.kind === 'assistant-step' && node.visibility === 'visible')
    expect(assistant).toHaveLength(1)
    expect(assistant[0].data.blocks).toEqual([{ kind: 'text', text: 'DSH SDK canonical boundary is live.' }])
    expect({ userAnchor: user.anchorSeq, assistantAnchor: assistant[0].anchorSeq }).toEqual({ userAnchor: 1, assistantAnchor: 25 })
  })
  it("accepts the adapter contract's official goal/change payload in the DSH goal projection", () => {
    const change = {
      kind: 'goal/change', version: 1, operation: 'create',
      goal: { id: 'goal-live', revision: 1, objective: 'verify', phase: 'active', maxGoalRounds: 3 },
      roundsStarted: 0, createdAt: 1, updatedAt: 1,
    }
    const folded = foldGoal([{ type: 'goal/change', seq: 0, data: change }] as never)
    expect(folded.goal).toEqual(change.goal)
    expect(folded.roundsStarted).toBe(0)
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
