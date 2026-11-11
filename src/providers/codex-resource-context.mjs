/** Materialize Codex-bound resources while keeping DSH delivery execution authoritative. */
import { prepareLocalResourceContext, codexToolBindings, writeBoundMemory } from '../local-runtime.mjs';
import { codexPresentationBindings } from './dsh-presentation-tools.mjs';
import { harnessServiceHostBindings } from './dsh-node-builtin-catalog.mjs';
import { nativeAgentPolicyFromSpec } from '../native-agent-policy.mjs';

export function createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise }) {
  return async ({ agentId, buildId, agentRevision, input, userId, sessionId, toolAdapter, agent, runtime } = {}) => {
    const [store, buildState, resourceAdapter] = await Promise.all([agentStorePromise, studioBuildPromise, resourceAdaptersPromise]);
    let record;
    try { record = buildId ? await buildState.build.resolve(agentId, buildId) : agentRevision ? await store.getRevision(agentId,Number(agentRevision)) : await store.get(agentId); }
    catch (error) {
      console.warn('[agentkit-studio] Codex resource resolution failed:', JSON.stringify({ agentId, buildId: buildId || '', code: error?.code || 'UNKNOWN' }));
      throw error;
    }
    if (!record) throw Object.assign(new Error('本地 Codex Agent 不存在'), { code: 'AGENT_NOT_FOUND' });
    const resourceRecord = runtime === 'native-engine'
      ? { ...record, spec: { ...record.spec, bindings: harnessServiceHostBindings(record.spec?.bindings || record.bindings) } }
      : record;
    const prepared = await prepareLocalResourceContext({
      record: resourceRecord,
      input,
      resourceAdapter,
      toolAdapter,
      userId: userId || 'studio-anonymous',
      agentId,
      agent,
    });
    // A managed Agent declares its platform resources in the runtime manifest,
    // so a declared memory library must always produce either a recall check or
    // an explicit gap report. Never let the turn silently lose memory.
    const declaredMemory = Array.isArray(record?.spec?.bindings?.plugins)
      ? record.spec.bindings.plugins.find(item => item?.config?.binding?.resource?.kind === 'memory-instance')
      : undefined;
    const reportMemoryGap = code => {
      try {
        agent?.session?.append?.('studio/resource-check', {
          kind: 'memory-instance',
          resourceId: String(declaredMemory?.config?.binding?.resource?.id || 'memory-binding'),
          action: 'recall', status: 'failed', code,
        }, { ignorable: true });
      } catch { /* evidence only: a missing Session must not break the turn */ }
      console.warn('[agentkit-studio] managed memory context gap:', code);
    };
    const presentation = codexPresentationBindings(toolAdapter, agent);
    if (declaredMemory && !prepared.memory) reportMemoryGap('MEMORY_BINDING_SKIPPED');
    else if (prepared.memory && prepared.memoryHitCount === null) reportMemoryGap('MEMORY_RECALL_SKIPPED');
    const toolBindings = codexToolBindings([...prepared.tools.filter(tool => !presentation.length || tool.name !== 'present'), ...presentation]);
    const systemPrompt = [
      record.spec?.instructions?.system || record.spec?.description || '',
      record.spec?.instructions?.task || '',
      prepared.resourceContext ? `Relevant resources:\n${prepared.resourceContext}` : '',
      presentation.length ? 'For a separate final deliverable, create the actual file in the current workspace, then call dsh_present with files: [{path, description?}]. This is the official DSH present tool; it validates the file and creates native conversation cards with Sidebar preview. For an inline preview, use ![description](<absolute/path/to/image.png>) in the final reply.' : '',
    ].filter(Boolean).join('\n\n');
    return {
      agentName: String(record.metadata?.name || record.name || ''),
      memory: prepared.memory || null,
      memoryHitCount: prepared.memoryHitCount,
      ...(runtime === 'native-engine' ? { nativeAgentPolicy: nativeAgentPolicyFromSpec(record.spec) } : {}),
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
