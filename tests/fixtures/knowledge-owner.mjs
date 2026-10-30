import { createKnowledgeConnection, createStudioKnowledgeTools, knowledgeBindings } from '../../src/knowledge-tools.mjs';
import { createDshNodeKnowledgeTools } from '../../src/providers/dsh-node-knowledge-tools.mjs';
const input = JSON.parse(process.argv[2]);
const connection = await createKnowledgeConnection({ configuration: { resolve: async () => ({ values: { cloudServerUrl: input.url } }) } });
const knowledge = createStudioKnowledgeTools({ agentId: 'agent', connection,
  bindings: knowledgeBindings({ bindings: { plugins: [{ config: { binding: { resource: { kind: 'knowledge-base', id: 'kb' } } } }] } }) });
const owner = createDshNodeKnowledgeTools({ agentId: 'agent', agentRevision: 1, buildId: 'build',
  workspaceRoot: input.workspaceRoot, stateDir: input.stateDir, knowledge });
const args = { query: '保持完整查询😀' }, exec = { name: 'search_knowledge_base', arguments: args,
  callId: input.callId, agent: { session: { id: 'session' } }, signal: new AbortController().signal };
const result = await owner.execute(exec.name, args, exec);
await owner.close();
process.send?.({ pid: process.pid, result });
process.disconnect?.();
