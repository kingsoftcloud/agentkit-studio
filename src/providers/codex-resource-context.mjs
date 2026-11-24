/** Materialize Codex-bound resources while keeping DSH delivery execution authoritative. */
import { prepareLocalResourceContext, codexToolBindings, writeBoundMemory } from '../local-runtime.mjs';
import { codexPresentationBindings } from './dsh-presentation-tools.mjs';
import { harnessServiceHostBindings } from './dsh-node-builtin-catalog.mjs';
import { nativeAgentPolicyFromSpec } from '../native-agent-policy.mjs';
import { nativeHostToolCallId } from './native-engine-runtime.mjs';
import { nativeMcpInvocation } from './native-mcp-invocation.mjs';

export function createCodexResourceContext({ agentStore: agentStorePromise, builds: studioBuildPromise, resources: resourceAdaptersPromise, augmentContext }) {
  return async ({ agentId, buildId, agentRevision, input, userId, sessionId, toolAdapter, agent, runtime, nativeService, runtimeRecord, authorizeTool } = {}) => {
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
    const nativeBrowser = independent ? toolAdapter?.nativeBrowserTool : undefined;
    const nativeTools = [...nativeA2a.map(tool => ({ ...tool, _source: 'native-a2a' })),
      ...nativeTeam.map(tool => ({ ...tool, _source: 'native-team' })),
      ...(nativeBrowser ? [{ ...nativeBrowser, _source: 'native-browser' }] : [])];
    const nativeByName = new Map(nativeTools.map(tool => [tool.name, tool]));
    const a2aReceipts = typeof toolAdapter?.observeNativeA2aReceipt === 'function'
      && nativeA2a.some(tool => tool.name === 'call_a2a_agent');
    const toolBindings = codexToolBindings([
      ...nativeTools,
      ...prepared.tools.filter(tool => (!presentation.length || tool.name !== 'present')
        && !(tool._source === 'dsh' && nativeByName.has(tool.name)))
        .map(tool => runtime === 'ksxc' ? { ...tool, name: `studio_${tool._source}_${tool.name}`, boundName: tool.name } : tool),
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
        ...(a2aReceipts && tool._source === 'native-a2a' && tool.name === 'call_a2a_agent' ? { receiptObservation: true } : {}),
        ...(tool.readOnly ? {} : { effectProtocol: 'agentkit.engine-host-tool-effect/v1' }),
      } : spec),
      ...(a2aReceipts ? {
        nativeHostReceiptHandler: ({ name, runId, originalOperationKey, arguments: args, observationId, signal }) => {
          if (name !== 'call_a2a_agent' || !runId || !originalOperationKey) return {};
          return toolAdapter.observeNativeA2aReceipt({ agent, sessionId, callId: nativeHostToolCallId(runId, originalOperationKey),
            args, observationId, signal });
        },
      } : {}),
      ...(nativeTools.length ? {
        async nativeHostToolHandler({ name, arguments: args, runId, callId, effect, signal }) {
          const definition = nativeByName.get(name);
          if (!definition) return undefined;
          if (!runId || !callId || !definition.readOnly && (effect?.contract !== 'agentkit.engine-host-tool-effect/v1'
            || typeof effect.operationKey !== 'string' || !effect.operationKey))
            return { status: 'error', content: { code: definition._source === 'native-a2a' ? 'A2A_EFFECT_UNBOUND'
              : definition._source === 'native-browser' ? 'BROWSER_EFFECT_UNBOUND' : 'TEAM_EFFECT_UNBOUND', executed: false } };
          // Model call IDs can repeat across Runs. Tie host effects to their
          // durable engine operation, including calls admitted after approval.
          const identity = effect?.operationKey ?? callId;
          const ownedCallId = nativeHostToolCallId(runId, identity);
          if (definition._source === 'native-browser')
            return toolAdapter.callNativeBrowserTool(args, { agent, callId: ownedCallId, signal });
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
          memoryContract: record?.spec?.memory?.contract,
          memoryDomain: record?.metadata?.local === true ? 'local' : 'cloud',
          profileId: record?.metadata?.profileId || userId,
        })
        : null,
      toolHandler: async ({ name, arguments: args, callId, signal }) => {
        const binding = toolBindings.find(item => item.name === name);
        if (!binding?.tool?._source) {
          const message = runtime === 'ksxc'
            ? `KSXC 工具 ${name} 未绑定，未执行。请使用当前会话可用的工具。`
            : `Codex 请求了未绑定的工具：${name}`;
          throw Object.assign(new Error(message), { code: 'BOUND_TOOL_NOT_FOUND' });
        }
        if (runtime === 'ksxc' && binding.tool._source === 'mcp' && binding.tool.annotations?.readOnlyHint !== true) {
          signal?.throwIfAborted();
          const decision = await authorizeTool?.({ toolName: name, callId,
            reason: '执行已绑定的 KSXC 业务工具', arguments: args || {}, signal });
          signal?.throwIfAborted();
          if (decision !== 'allowed-once') throw Object.assign(new Error('KSXC 业务工具调用未获批准。'), { code: 'KSXC_TOOL_NOT_APPROVED' });
        }
        const boundName = binding.tool.boundName || binding.tool.name;
        if (binding.tool._source === 'dsh-presentation') {
          return toolAdapter.callPresentationTool(binding.tool._dshName, args || {}, { callId, signal, agent });
        }
        if (binding.tool._source === 'dsh') {
          return toolAdapter.callTool(boundName, args || {}, { callId, signal, agent });
        }
        // One composition shared with the Native path so the two runtimes cannot
        // drift apart; Codex labels its own source and forwards the call id.
        // `runId` is intentionally absent: this scope has no DSH Run, and a
        // correlation id is never fabricated from the invocation id.
        return resourceAdapter.callMcpTool(binding.tool._resourceId, boundName, args || {}, { signal,
          invocation: nativeMcpInvocation({ scope: { userId }, agent: { session: { id: sessionId } },
            agentId, callId, source: runtime === 'ksxc' ? 'ksxc' : 'codex' }) });
      },
    };
    return augmentContext ? augmentContext(context, record.spec?.bindings || record.bindings || {}) : context;
  };
}
