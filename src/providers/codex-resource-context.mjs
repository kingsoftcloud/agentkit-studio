/** Materialize Codex-bound resources while keeping DSH delivery execution authoritative. */
import { createHash } from 'node:crypto';
import { prepareLocalResourceContext, codexToolBindings, writeBoundMemory } from '../local-runtime.mjs';
import { codexPresentationBindings } from './dsh-presentation-tools.mjs';
import { harnessServiceHostBindings } from './dsh-node-builtin-catalog.mjs';
import { nativeAgentPolicyFromSpec } from '../native-agent-policy.mjs';

export function createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise, augmentContext }) {
  return async ({ agentId, buildId, agentRevision, input, userId, sessionId, toolAdapter, agent, runtime, nativeService, runtimeRecord } = {}) => {
    const [store, buildState, resourceAdapter] = await Promise.all([agentStorePromise, studioBuildPromise, resourceAdaptersPromise]);
    const independent = nativeService === true && runtime === 'native-engine';
    const frozenTeamRole = independent && runtimeRecord?.metadata?.teamRole;
    let record;
    try {
      if (frozenTeamRole) {
        if (runtimeRecord.metadata.id !== agentId || runtimeRecord.metadata.revision !== Number(agentRevision) || buildId)
          throw Object.assign(new Error('团队角色与当前会话不匹配'), { code: 'TEAM_PRESET_CONFLICT' });
        record = runtimeRecord;
      } else {
        record = buildId ? await buildState.build.resolve(agentId, buildId)
          : agentRevision ? await store.getRevision(agentId, Number(agentRevision)) : await store.get(agentId);
      }
    }
    catch (error) {
      console.warn('[agentkit-studio] Codex resource resolution failed:', JSON.stringify({ agentId, buildId: buildId || '', code: error?.code || 'UNKNOWN' }));
      throw error;
    }
    if (!record) throw Object.assign(new Error('本地 Codex Agent 不存在'), { code: 'AGENT_NOT_FOUND' });
    const teamRole = independent && record.metadata?.teamRole;
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
    const nativeA2a = independent && resourceRecord.spec.bindings?.a2a?.length
      ? toolAdapter?.listNativeA2aTools?.() ?? [] : [];
    const nativeTeam = teamRole ? toolAdapter?.listNativeTeamTools?.(agent) ?? [] : [];
    const nativeTools = [...nativeA2a.map(tool => ({ ...tool, _source: 'native-a2a' })),
      ...nativeTeam.map(tool => ({ ...tool, _source: 'native-team' }))];
    const nativeByName = new Map(nativeTools.map(tool => [tool.name, tool]));
    const toolBindings = codexToolBindings([
      ...nativeTools,
      ...prepared.tools.filter(tool => (!presentation.length || tool.name !== 'present')
        && !(tool._source === 'dsh' && nativeByName.has(tool.name))),
      ...presentation,
    ]);
    const systemPrompt = [
      record.spec?.instructions?.system || record.spec?.description || '',
      record.spec?.instructions?.task || '',
      nativeTeam.length ? '你是 Studio 团队的成员。使用团队工具读取、分配和更新共享任务，完成后用 send_message 向 lead 汇报。文件修改限于分配给你的工作范围。' : '',
      prepared.resourceContext ? `Relevant resources:\n${prepared.resourceContext}` : '',
      presentation.length ? 'For a separate final deliverable, create the actual file in the current workspace, then call dsh_present with files: [{path, description?}]. This is the official DSH present tool; it validates the file and creates native conversation cards with Sidebar preview. For an inline preview, use ![description](<absolute/path/to/image.png>) in the final reply.' : '',
    ].filter(Boolean).join('\n\n');
    // Use the same frozen record for resource calls and builtin skill context.
    const context = {
      agentName: String(record.metadata?.name || record.name || ''),
      memory: prepared.memory || null,
      memoryHitCount: prepared.memoryHitCount,
      ...(runtime === 'native-engine' ? { nativeAgentPolicy: nativeAgentPolicyFromSpec(record.spec) } : {}),
      systemPrompt,
      dynamicTools: toolBindings.map(({ spec, tool }) => nativeByName.get(spec.name) === tool ? {
        ...spec, readOnly: tool.readOnly, timeoutMs: tool.timeoutMs,
        ...(tool.readOnly ? {} : { effectProtocol: 'agentkit.engine-host-tool-effect/v1' }),
      } : spec),
      ...(nativeTools.length ? {
        async nativeHostToolHandler({ name, arguments: args, runId, callId, effect, signal }) {
          const definition = nativeByName.get(name);
          if (!definition) return undefined;
          if (!runId || !callId || !definition.readOnly && (effect?.contract !== 'agentkit.engine-host-tool-effect/v1'
            || typeof effect.operationKey !== 'string' || !effect.operationKey))
            return { status: 'error', content: { code: definition._source === 'native-a2a' ? 'A2A_EFFECT_UNBOUND' : 'TEAM_EFFECT_UNBOUND', executed: false } };
          // Model call IDs can repeat across Runs. Tie host effects to their
          // durable engine operation, including calls admitted after approval.
          const identity = effect?.operationKey ?? callId;
          const ownedCallId = 'harness-' + createHash('sha256').update(JSON.stringify([runId, identity])).digest('hex');
          const execute = definition._source === 'native-a2a' ? toolAdapter.callNativeA2aTool : toolAdapter.callNativeTeamTool;
          return execute(name, args, { agent, callId: ownedCallId, signal });
        },
      } : {}),
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
    return augmentContext ? augmentContext(context, record.spec?.bindings || record.bindings || {}) : context;
  };
}
