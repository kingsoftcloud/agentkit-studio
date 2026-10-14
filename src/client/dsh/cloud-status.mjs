import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { operationalDate } from '../state/operational-data.mjs';

export function createCloudSessionStatus({ ui, hostRemote, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  const { React, ResourceDialog, buttonStyle } = ui;
  const { createElement: h, useEffect, useState } = React;
  function CloudSessionStatus({ sessionId, useSessions }) {
    const session = useSessions(state => state?.byId?.[sessionId]);
    const presetId = session?.projectionValues?.agentPreset;
    const [agent, setAgent] = useState(null), [open, setOpen] = useState(false), [receipt, setReceipt] = useState(null), [error, setError] = useState('');
    useEffect(() => {
      let active = true; setAgent(null); setReceipt(null); setOpen(false);
      (async () => {
        const first = await hostRemote.agents({ source: 'cloud', pageSize: 100 });
        const items = [...(first.items || [])];
        for (let page = 2; active && items.length < Number(first.total || 0); page++) {
          const next = await hostRemote.agents({ source: 'cloud', pageSize: 100, page });
          if (!next.items?.length) break;
          items.push(...next.items);
        }
        return { items };
      })().then(result => {
        const rows = result.items || [], id = agentFromSessionPreset(presetId, rows);
        if (active) setAgent(rows.find(item => item.metadata?.id === id) || null);
      }).catch(() => {});
      return () => { active = false; };
    }, [sessionId, presetId]);
    useEffect(() => {
      if (!open || !agent) return;
      let active = true;
      const load = async () => {
        try {
          const rows = (await hostRemote.traces(`range=7d&agentId=${encodeURIComponent(agent.metadata.id)}`)).items || [];
          if (active) { setReceipt(rows.find(item => item.sessionId === sessionId && item.executionLocation === 'cloud') || null); setError(''); }
        } catch { if (active) setError('执行凭据读取失败，请稍后刷新。'); }
      };
      void load(); const timer = setInterval(load, 5000);
      return () => { active = false; clearInterval(timer); };
    }, [open, agent, sessionId]);
    if (!agent?.deployment) return null;
    const deployment = agent.deployment, bindings = agent.spec?.bindings || {}, plugins = bindings.plugins || [];
    const pairs = [['云端实例', agent.metadata.id], ['环境', `${deployment.environment === 'pre-online' ? '预发' : deployment.environment} · ${deployment.region}`],
      ['当前部署版本', `r${agent.metadata.revision} · ${deployment.buildId}`], ['当前绑定模型', (deployment.models || [deployment.model]).join('、')],
      ['MCP', (bindings.mcpServers || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).join('、') || '未绑定'],
      ['Skill', (bindings.skills || []).map(item => typeof item === 'string' ? item : item.resourceId || item.id).join('、') || '未绑定'],
      ...[['knowledge-base', '知识库'], ['memory-instance', '记忆库'], ['skill-space', 'Skill Center']].map(([kind, label]) => {
        const resource = plugins.find(item => item.config?.binding?.resource?.kind === kind)?.config.binding.resource;
        return [label, resource?.id || resource?.resourceId || '未绑定'];
      })];
    return h(React.Fragment, null, h('button', { type: 'button', onClick: () => setOpen(true), title: agent.metadata.id, style: { ...buttonStyle(), fontSize: '11px', padding: '4px 8px' } }, '云端 · ' + (deployment.environment === 'pre-online' ? '预发' : deployment.environment)),
      open ? h(ResourceDialog, { title: '云端 Agent 与执行凭据', detail: '绑定清单来自云端冻结版本；每轮响应身份由 Host 核验。', onClose: () => setOpen(false), wide: true },
        h('dl', { style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '10px 18px', overflowWrap: 'anywhere' } }, pairs.map(([key, value]) => h(React.Fragment, { key }, h('dt', null, key), h('dd', { style: { margin: 0 } }, value)))),
        receipt ? h('div', null, h('h4', null, '最近一轮 · 云端响应已核验'), h('p', null, `${receipt.status} · ${receipt.provenance.model} · ${operationalDate(receipt.completedAt)}`),
          h('p', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `本轮版本：r${receipt.provenance.revision || '—'} · ${receipt.provenance.buildId}`),
          receipt.provenance.resourceBindings ? h('p', { style: { fontSize: '12px', overflowWrap: 'anywhere' } }, '本轮绑定：',
            [`MCP ${(receipt.provenance.resourceBindings.mcpServers || []).join('、') || '无'}`, `Skill ${(receipt.provenance.resourceBindings.skills || []).join('、') || '无'}`,
              ...(receipt.provenance.resourceBindings.platform || []).map(item => `${{ 'knowledge-base': '知识库', 'memory-instance': '记忆库', 'skill-space': 'Skill Center' }[item.kind] || item.kind} ${item.id}`)].join(' · ')) : null,
          h('p', { style: { overflowWrap: 'anywhere', fontSize: '12px' } }, `Response ID：${receipt.provenance.responseId}`),
          receipt.provenance.resourceChecks?.length ? h('ul', null, receipt.provenance.resourceChecks.map((check, i) => h('li', { key: i }, `${check.kind} · ${check.action} · ${check.resourceId} · ${check.status}${check.hitCount !== undefined ? ` · 命中 ${check.hitCount}` : ''}${check.definitionCount !== undefined ? ` · 已加载 ${check.definitionCount} 项定义` : ''}${check.accepted !== undefined ? ` · 写入${check.accepted ? '已受理' : '未受理'}` : ''}${check.code ? ' · ' + check.code : ''} · ${check.durationMs} ms`))) : h('p', null, '本轮没有资源调用凭据。旧镜像尚不返回此信息；不能据此判定资源执行成功。'))
          : h('p', null, '此会话尚无云端响应凭据。完成一轮云端对话后可核对，历史版本不会补造凭据。'),
        error ? h('p', { role: 'alert' }, error) : null) : null);
  }
  return { CloudSessionStatus };
}
