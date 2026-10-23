import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAgentStore } from '../../src/agent-store.mjs';
import { createSkillDiscovery } from '../../src/skill-discovery.mjs';
import { createStudioSkillManagement } from '../../src/skill-management.mjs';
import { createDshNodeSkillManagement } from '../../src/providers/dsh-node-skill-management.mjs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const agents = createAgentStore({ storeDir: join(input.root, 'agents') });
const skillDiscovery = createSkillDiscovery({ storeDir: join(input.root, 'skills') });
const source = { search() { throw new Error('cold source forbidden'); }, inspect() { throw new Error('cold source forbidden'); } };
const management = createStudioSkillManagement({ workspaceRoot: join(input.root, 'workspace'), stateDir: join(input.root, 'state'),
  agentId: input.agentId, agents, skillDiscovery, source });
const execute = management.execute.bind(management);
if (input.killAfterEffect) management.execute = async (...args) => {
  await execute(...args);
  process.send({ published: true, pid: process.pid });
  await new Promise(() => {});
};
const port = createDshNodeSkillManagement({ agentId: input.agentId, agentRevision: 1, buildId: 'build-1',
  workspaceRoot: join(input.root, 'workspace'), stateDir: join(input.root, 'state'), management,
  ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
const exec = { name: input.name, arguments: input.args, callId: input.callId, signal: AbortSignal.timeout(15000),
  agent: { session: { id: 'session-1' } } };
if (input.waitForGo) { const go = once(process, 'message'); process.send({ ready: true }); await go; }
try {
  const result = await port.execute(exec.name, exec.arguments, exec);
  console.log(JSON.stringify({ pid: process.pid, result }));
} finally { await port.close(); process.disconnect?.(); }
