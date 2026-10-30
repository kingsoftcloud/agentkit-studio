/** MCP execution remains in the Host-owned adapter. */
export function createBoundResourceToolExecutor({ agents, builds, resources }) {
  return async ({ agentId, agentRevision, buildId, resourceId, name, arguments: args = {}, signal, resultFormat, assertCurrent } = {}) => {
    const store = await agents;
    let record;
    if (buildId) record = await (await builds)?.build?.resolve(agentId, buildId);
    else if (agentRevision !== undefined && agentRevision !== null) {
      const revision = Number(agentRevision);
      if (!Number.isInteger(revision) || revision < 1) throw Object.assign(new Error('Agent 版本无效'), { code: 'AGENT_REVISION_INVALID' });
      record = await store?.getRevision(agentId, revision);
    } else record = await store?.get(agentId);
    if (!record) throw Object.assign(new Error('Agent 不存在'), { code: 'AGENT_NOT_FOUND' });
    const bindings = record.spec?.bindings || record.bindings || {};
    const matches = (Array.isArray(bindings.mcpServers) ? bindings.mcpServers : [])
      .filter(ref => String(typeof ref === 'string' ? ref : ref?.resourceId || ref?.id || '') === String(resourceId || ''));
    if (!matches.length) throw Object.assign(new Error('MCP 未绑定到当前 Agent 版本'), { code: 'MCP_RESOURCE_NOT_BOUND' });
    if (matches.length !== 1) throw Object.assign(new Error('MCP 绑定别名重复'), { code: 'MCP_BINDING_AMBIGUOUS' });
    const adapters = await resources;
    if (typeof adapters?.callMcpTool !== 'function') throw Object.assign(new Error('AgentKit Studio MCP 资源适配器不可用'), { code: 'MCP_RESOURCE_ADAPTER_MISSING' });
    return adapters.callMcpTool(matches[0], name, args, { signal, ...(resultFormat ? { resultFormat } : {}), ...(assertCurrent ? { assertCurrent } : {}) });
  };
}
