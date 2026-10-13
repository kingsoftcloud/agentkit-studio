/** Durable schedules belong to Server, never to the desktop's local timer. */
const fail = (code, message) => Object.assign(new Error(message), { code });
const lower = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key[0].toLowerCase() + key.slice(1), item]));
const taskView = task => ({ ...lower(task), scope: 'cloud', target: { agentId: task.AgentId }, command: { payload: { content: task.Prompt } }, deliveryTarget: task.DeliveryTarget ? lower(task.DeliveryTarget) : null });
const specFields = { displayName: 'DisplayName', prompt: 'Prompt', schedule: 'Schedule', continuity: 'Continuity', sessionId: 'SessionId', enabled: 'Enabled', expectedRevision: 'ExpectedRevision' };
const specPayload = spec => {
  const payload = Object.fromEntries(Object.entries(specFields).filter(([key]) => spec[key] !== undefined).map(([key, target]) => [target, spec[key]]));
  if (spec.deliveryTarget !== undefined) payload.DeliveryTarget = spec.deliveryTarget === null ? null
    : { ChannelConfigId: spec.deliveryTarget.channelConfigId, BindingId: spec.deliveryTarget.bindingId };
  return payload;
};

export function createCloudSchedules({ agents, client, deliveryTargets }) {
  const apiFor = async agentId => {
    if (!agentId) throw fail('CLOUD_SCHEDULE_AGENT_REQUIRED', '请选择云端部署的 Agent');
    await (await agents()).get(agentId); // Receipt + current credential scope, not arbitrary cloud IDs.
    return (await client()).forAgent(agentId).schedules;
  };
  async function catalog(agentId) {
    const api = await apiFor(agentId);
    const { data } = await api.list();
    if (!Array.isArray(data?.Tasks)) throw fail('CLOUD_SCHEDULE_RESPONSE_INVALID', '云端定时任务返回格式不兼容');
    if (data.Tasks.some(task => task.AgentId !== agentId)) throw fail('CLOUD_SCHEDULE_SCOPE_MISMATCH', '云端定时任务的 Agent 身份不一致');
    const availability = data.Availability || {};
    return { items: data.Tasks.map(taskView), enabled: availability.Enabled === true,
      deliverySupported: availability.DeliveryContracts?.includes('ChannelOutbox/v1') === true,
      supported: availability.RuntimeContracts?.includes('agentkit.responses/v1') === true };
  }
  async function ready(agentId, needsDelivery = false) {
    const result = await catalog(agentId);
    if (!result.enabled) throw fail('CLOUD_SCHEDULER_DISABLED', '云端调度服务未启用；请启用 Server Cloud Scheduler');
    if (needsDelivery && !result.deliverySupported) throw fail('CLOUD_SCHEDULE_DELIVERY_UNAVAILABLE', '云端渠道投递尚未就绪，请升级并配置云端投递服务');
    if (!result.supported) throw fail('CLOUD_SCHEDULE_RUNTIME_UNSUPPORTED', '云端调度服务尚未支持 Studio 运行时；请升级 Server 的 Responses 调度适配');
  }
  async function ownedTask(agentId, taskId) {
    const api = await apiFor(agentId), { data } = await api.get(taskId);
    if (!data?.Task || data.Task.AgentId !== agentId || data.Task.TaskId !== taskId) throw fail('CLOUD_SCHEDULE_SCOPE_MISMATCH', '任务不属于所选云端 Agent');
    return { api, task: data.Task };
  }
  return {
    async execute(operation, payload = {}) {
      const { agentId, taskId } = payload;
      if (operation === 'list') {
        const catalogResult = agentId ? { items: [{ metadata: { id: agentId } }] } : await (await agents()).list();
        const targets = catalogResult.items;
        const results = await Promise.allSettled(targets.map(target => catalog(target.metadata.id)));
        const warnings = [...(catalogResult.warnings || [])], items = [];
        let active = targets.length > 0, readable = 0;
        const readyAgentIds = [], deliveryReadyAgentIds = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            readable++;
            if (result.value.deliverySupported) deliveryReadyAgentIds.push(targets[index].metadata.id);
            if (result.value.enabled && result.value.supported) readyAgentIds.push(targets[index].metadata.id);
            items.push(...result.value.items);
            if (!result.value.enabled || !result.value.supported) { active = false; warnings.push('云端调度服务未启用或尚未支持 Studio 运行时'); }
          } else { active = false; warnings.push(`云端 Agent ${targets[index].metadata.id} 的任务读取失败：${result.reason?.message || '请求未完成'}`); }
        });
        return { items: items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)), nativeItems: [], warnings: [...new Set(warnings)],
          availability: { scope: 'cloud', alwaysOn: true, lifecycleOwner: 'agentengine-server', triggerActive: active, readyAgentIds, deliveryReadyAgentIds, catalogReadable: targets.length === 0 || readable > 0 } };
      }
      if (operation === 'delivery-targets') {
        await ready(agentId, true);
        if (!deliveryTargets) throw fail('CLOUD_SCHEDULE_DELIVERY_UNAVAILABLE', '渠道连接尚未配置');
        return deliveryTargets(agentId);
      }
      if (operation === 'create') {
        await ready(agentId, Boolean(payload.spec?.deliveryTarget));
        const { data } = await (await apiFor(agentId)).create(specPayload(payload.spec || {}));
        return taskView(data.Task);
      }
      const { api, task } = await ownedTask(agentId, taskId);
      if (operation === 'get') return taskView(task);
      if (operation === 'occurrences') {
        const { data } = await api.occurrences(taskId);
        if (!Array.isArray(data?.Occurrences) || data.Occurrences.some(item => item.TaskId !== taskId || item.AgentId !== agentId)) throw fail('CLOUD_SCHEDULE_SCOPE_MISMATCH', '云端执行记录的任务身份不一致');
        return { items: data.Occurrences.map(lower) };
      }
      if (operation === 'delete') return (await api.remove(taskId)).data;
      if (operation === 'run') { await ready(agentId); return (await api.run(taskId)).data; }
      if (operation === 'update') {
        const spec = payload.patch || {};
        if (spec.enabled !== false || spec.deliveryTarget) await ready(agentId, Boolean(spec.deliveryTarget));
        const { data } = await api.update(taskId, { ...specPayload(spec), ExpectedRevision: spec.expectedRevision ?? task.Revision });
        return taskView(data.Task);
      }
      throw fail('CLOUD_SCHEDULE_ACTION_INVALID', '不支持的云端定时任务操作');
    },
  };
}
