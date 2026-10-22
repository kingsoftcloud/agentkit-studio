/** Materialize Codex-bound resources while keeping DSH delivery execution authoritative. */
import { prepareLocalResourceContext, codexToolBindings, writeBoundMemory } from '../local-runtime.mjs';
import { codexPresentationBindings } from './dsh-presentation-tools.mjs';

export function createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise }) {
  return async ({ agentId, buildId, agentRevision, input, userId, sessionId, toolAdapter, agent } = {}) => {
    const [store, buildState, resourceAdapter] = await Promise.all([agentStorePromise, studioBuildPromise, resourceAdaptersPromise]);
    let record;
    try { record = buildId ? await buildState.build.resolve(agentId, buildId) : agentRevision ? await store.getRevision(agentId,Number(agentRevision)) : await store.get(agentId); }
    catch (error) {
      console.warn('[agentkit-studio] Codex resource resolution failed:', JSON.stringify({ agentId, buildId: buildId || '', code: error?.code || 'UNKNOWN' }));
      throw error;
    }
    if (!record) throw Object.assign(new Error('本地 Codex Agent 不存在'), { code: 'AGENT_NOT_FOUND' });
    const prepared = await prepareLocalResourceContext({
      record,
      input,
      resourceAdapter,
      toolAdapter,
      userId: userId || 'studio-anonymous',
      agentId,
      agent,
    });
    const presentation = codexPresentationBindings(toolAdapter, agent);
    const toolBindings = codexToolBindings([...prepared.tools.filter(tool => !presentation.length || tool.name !== 'present'), ...presentation]);
    const systemPrompt = [
      record.spec?.instructions?.system || record.spec?.description || '',
      record.spec?.instructions?.task || '',
      prepared.resourceContext ? `Relevant resources:\n${prepared.resourceContext}` : '',
      presentation.length ? 'For a separate final deliverable, create the actual file in the current workspace, then call dsh_present with files: [{path, description?}]. This is the official DSH present tool; it validates the file and creates native conversation cards with Sidebar preview. For an inline preview, use ![description](<absolute/path/to/image.png>) in the final reply.' : '',
    ].filter(Boolean).join('\n\n');
    return {
      agentName: String(record.metadata?.name || record.name || ''),
      systemPrompt,
      dynamicTools: toolBindings.map(item => item.spec),
      writeMemory: prepared.memoryWrite
        ? async assistantText => writeBoundMemory({
          agent,
          binding: prepared.memory,
          resourceAdapter,
          input,
          assistantText,
          userId: userId || 'studio-anonymous',
          sessionId,
          agentId,
        })
        : null,
      toolHandler: async ({ name, arguments: args, callId, signal }) => {
        const binding = toolBindings.find(item => item.name === name);
        if (!binding?.tool?._source) {
          throw Object.assign(new Error(`Codex 请求了未绑定的工具：${name}`), { code: 'BOUND_TOOL_NOT_FOUND' });
        }
        if (binding.tool._source === 'dsh-presentation') {
          return toolAdapter.callPresentationTool(binding.tool._dshName, args || {}, { callId, signal, agent });
        }
        if (binding.tool._source === 'dsh') {
          return toolAdapter.callTool(binding.tool.name, args || {}, { callId, signal, agent });
        }
        return resourceAdapter.callMcpTool(binding.tool._resourceId, binding.tool.name, args || {}, { signal });
      },
    };
  };
}
