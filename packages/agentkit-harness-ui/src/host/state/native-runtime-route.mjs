/** Runtime routing is resolved before choosing a transcript renderer. A failed
 * lookup is not evidence that the conversation belongs to another runtime. */
export function nativeRuntimeRouteInput(_session, openState, projection, boundPresetId) {
  // Identity comes from the current Session's keyed projection subscription,
  // not the manager's asynchronously batched catalog/list snapshot. Read state
  // only establishes readiness; it cannot overwrite the live preset identity.
  return { presetId: boundPresetId, ready: openState === 'open' && projection?.state === 'ready' };
}

export async function resolveNativeRuntimeRoute({ hostRemote, presetId, resolveAgentFromPreset, signal }) {
  const first = await hostRemote.agents({ source: 'local', pageSize: 100 });
  signal.throwIfAborted();
  if (!Array.isArray(first?.items)) throw Error('智能体目录响应无效');
  const items = [...first.items];
  for (let page = 2; items.length < Number(first.total || 0); page++) {
    const next = await hostRemote.agents({ source: 'local', pageSize: 100, page });
    signal.throwIfAborted();
    if (!next.items?.length) throw Error('智能体目录尚未完整读取');
    items.push(...next.items);
  }
  const agentId = resolveAgentFromPreset(presetId, items);
  if (!agentId) return { kind: 'other', agentId: null };
  const agent = items.find(item => (item.metadata?.id ?? item.id) === agentId);
  if (!agent) throw Error('当前会话的智能体配置暂不可用');
  return agent.spec?.runtime?.type === 'harness' ? { kind: 'native', agentId } : { kind: 'other', agentId };
}
