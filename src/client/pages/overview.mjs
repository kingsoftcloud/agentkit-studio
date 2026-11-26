import { ALLOWED_RUNTIME_TYPES as DEFAULT_ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS as DEFAULT_RUNTIME_LABELS } from '../theme.mjs';
import { requestManualAgentCreate } from '../state/agent-create-intent.mjs';
import { operationalCollection, operationalId } from '../state/operational-data.mjs';

function agentIdentity(agent) {
  return String(agent?.metadata?.id || agent?.id || '');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return '—';
  return duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`;
}

function runStatus(value) {
  const status = String(value || 'unknown').toUpperCase();
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'PASSED'].includes(status)) return ['已完成', 'ok'];
  if (['FAILED', 'ERROR', 'CANCELLED', 'REJECTED'].includes(status)) return ['失败', 'err'];
  if (['RUNNING', 'ACTIVE', 'IN_PROGRESS'].includes(status)) return ['运行中', 'run'];
  if (['PENDING', 'QUEUED', 'WAITING'].includes(status)) return ['等待中', 'warn'];
  if (status === 'INTERRUPTED') return ['已中断', 'warn'];
  return [status.toLowerCase(), 'neutral'];
}

function hasUsableModel(settings) {
  if (!Array.isArray(settings?.modelProfiles)) return true;
  return settings.modelProfiles.some(profile => profile?.enabled !== false && String(profile?.modelName || '').trim());
}

export function createOverviewPage({
  ui: { React: { createElement: h, useEffect, useState }, EmptyState, StartChecks, buttonStyle, ALLOWED_RUNTIME_TYPES = DEFAULT_ALLOWED_RUNTIME_TYPES, RUNTIME_LABELS = DEFAULT_RUNTIME_LABELS },
  hostRemote, actions, window = globalThis.window, CustomEvent = globalThis.CustomEvent
}) {
  function OverviewPage({ onNavigate }) {
    const directServerMode = Boolean(window.__AGENTKIT_STUDIO__?.controlPlane === 'agentengine-server');
    const [connection, setConnection] = useState({ status: 'loading', agents: 0, runtimes: 0, agentItems: [], traces: [], schedules: [], error: '' });
    const [credential, setCredential] = useState({ status: 'loading', configured: true, modelConfigured: true });
    const [bindingAgent, setBindingAgent] = useState('');
    const load = async () => {
      setConnection(current => ({ ...current, status: 'loading', error: '' }));
      try {
        const activityPromise = Promise.allSettled([
          hostRemote.tracesOverview('range=24h'),
          hostRemote.traces('range=24h&limit=6'),
          hostRemote.schedules(undefined, 'local'),
        ]);
        const [health, bootstrap, agentResult, runtimeResult] = await Promise.all([
          hostRemote.health(), hostRemote.bootstrap(), hostRemote.agents(), hostRemote.runtimes(),
        ]);
        const [overviewResult, tracesResult, schedulesResult] = await activityPromise;
        const runtimeItems = Array.isArray(runtimeResult?.items)
          ? runtimeResult.items.filter(item => ALLOWED_RUNTIME_TYPES.includes(item.runtimeType)) : [];
        setConnection({
          status: health?.status === 'ok' && bootstrap?.workspaceReady !== false ? 'ready' : 'error',
          agents: Number(agentResult?.total) || (Array.isArray(agentResult?.items) ? agentResult.items.length : 0),
          agentItems: Array.isArray(agentResult?.items) ? agentResult.items : [],
          cloudConnected: agentResult?.cloudConnected !== false,
          warning: (agentResult?.warnings || []).map(item => item.message).join(' '),
          runtimes: runtimeResult?.source === 'dsh' ? null : runtimeItems.length,
          traceOverview: overviewResult.status === 'fulfilled' ? overviewResult.value : null,
          traces: tracesResult.status === 'fulfilled' ? operationalCollection(tracesResult.value, ['items', 'traces']) : [],
          schedules: schedulesResult.status === 'fulfilled' ? operationalCollection(schedulesResult.value) : [],
          activityError: [overviewResult, tracesResult, schedulesResult].some(item => item.status === 'rejected') ? '部分运行数据暂不可用。' : '',
          error: health?.status === 'ok' ? '' : 'Host health 未通过',
        });
      } catch (reason) {
        setConnection({ status: 'error', agents: 0, runtimes: 0, agentItems: [], traces: [], schedules: [], error: reason?.message || (directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 不可达') });
      }
    };
    useEffect(() => { void load(); }, []);
    useEffect(() => {
      let active = true;
      Promise.allSettled([hostRemote.modelCredentialStatus(), hostRemote.settings()]).then(([credentialResult, settingsResult]) => {
        if (!active) return;
        if (credentialResult.status === 'rejected') {
          setCredential({ status: 'error', configured: true, modelConfigured: true, error: credentialResult.reason?.message || '凭证状态暂不可用' });
          return;
        }
        const configured = credentialResult.value?.configured === true;
        const modelConfigured = settingsResult.status === 'fulfilled' ? hasUsableModel(settingsResult.value) : true;
        setCredential({ status: 'ready', configured, modelConfigured, source: credentialResult.value?.source || 'unknown' });
      });
      return () => { active = false; };
    }, []);
    const hostReady = connection.status === 'ready';
    const onboarding = hostReady && connection.agents === 0;
    const recentAgents = [...(connection.agentItems || [])].sort((a, b) => {
      const aTime = a?.metadata?.updatedAt || a?.metadata?.createdAt || a?.updatedAt || a?.createdAt || '';
      const bTime = b?.metadata?.updatedAt || b?.metadata?.createdAt || b?.updatedAt || b?.createdAt || '';
      return String(bTime).localeCompare(String(aTime));
    }).slice(0, 5);
    const agentNames = new Map((connection.agentItems || []).map(agent => [agentIdentity(agent), agent?.metadata?.name || agent?.name || agentIdentity(agent)]));
    const recentTraces = (connection.traces || []).slice(0, 5);
    const upcomingSchedules = (connection.schedules || []).filter(task => task?.enabled !== false && task?.nextRunAt)
      .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt))).slice(0, 4);
    const runTotal = connection.traceOverview?.total ?? connection.traceOverview?.totalRuns;
    const successRate = connection.traceOverview?.successRate;
    const openAuthoring = () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-authoring'));
    const openManualCreate = () => { onNavigate?.('agents'); requestManualAgentCreate(window); };
    const bindAgent = async agent => {
      const id = agentIdentity(agent);
      if (!id || bindingAgent) return;
      setBindingAgent(id);
      try { await actions?.bindAgent?.(id); } finally { setBindingAgent(''); }
    };
    const stats = [
      ['Agent', hostReady ? String(connection.agents) : '—', '本地与云端 Agent', 'agents'],
      ['可用运行时', !hostReady ? '—' : connection.runtimes === null ? '1' : String(connection.runtimes), connection.runtimes === null ? 'DSH Native Harness' : '当前 Host 可创建的运行目标', null],
      ['24 小时运行', hostReady && runTotal != null ? String(runTotal) : '—', 'Trace 运行记录', null],
      ['运行完成率', hostReady && successRate != null ? `${Math.round(Number(successRate) * 100)}%` : runTotal != null ? '暂无' : '未上报', runTotal === 0 ? '还没有运行记录' : '近 24 小时已完成运行', null],
    ];
    const configurationNeeded = credential.status === 'ready' && (!credential.configured || credential.modelConfigured === false);
    const configurationMessage = !credential.configured ? '先配置一个模型凭证，即可开始对话。' : '还没有可用的模型，请先配置并启用一个模型。';
    const createActions = compact => [
      h('button', { key: 'conversation', type: 'button', className: compact ? 'studio-overview-primary-action' : 'studio-start-card', 'data-primary': compact ? undefined : true, onClick: openAuthoring },
        h('span', { className: compact ? 'studio-overview-action-glyph' : 'studio-tile', 'aria-hidden': 'true' }, '✦'),
        h(compact ? 'span' : 'strong', null, '对话创建'),
        compact ? null : h('small', null, '和 AI 一起完善配置')),
      h('button', { key: 'manual', type: 'button', className: compact ? 'studio-overview-secondary-action' : 'studio-start-card', onClick: openManualCreate },
        h('span', { className: compact ? 'studio-overview-action-glyph' : 'studio-tile', 'aria-hidden': 'true' }, '+'),
        h(compact ? 'span' : 'strong', null, '手动配置'),
        compact ? null : h('small', null, '选择运行时与能力')),
      h('button', { key: 'template', type: 'button', className: compact ? 'studio-overview-secondary-action' : 'studio-start-card', onClick: () => onNavigate?.('experts') },
        h('span', { className: compact ? 'studio-overview-action-glyph' : 'studio-tile', 'aria-hidden': 'true' }, '◈'),
        h(compact ? 'span' : 'strong', null, '从模板开始'),
        compact ? null : h('small', null, '复用专家模板')),
    ];
    const onboardingPanel = h('section', { className: 'studio-overview-panel studio-overview-guide' },
      h('div', { className: 'studio-overview-panel-heading' }, h('div', null, h('h2', null, '三步开始'), h('p', null, '不需要先理解所有概念，创建一个 Agent 即可'))),
      h('ol', { className: 'studio-overview-guide-list' }, [
        ['描述你的需求', '告诉 AI 这个 Agent 要做什么、面向哪些场景，以及希望如何回答。'],
        ['确认能力与配置', '选择运行时，按需绑定模型、Skill、MCP 和知识库。'],
        ['开始对话或构建', '先在会话中验证效果，再将满意的版本构建和部署。'],
      ].map(([title, detail], index) => h('li', { key: title },
        h('span', { className: 'studio-overview-guide-number' }, String(index + 1).padStart(2, '0')),
        h('div', null, h('strong', null, title), h('p', null, detail))))));
    return h('div', { className: 'studio-overview studio-page' },
      configurationNeeded ? h('section', { role: 'status', className: 'studio-credential-note' }, h('span', null, configurationMessage), h('button', { type: 'button', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings')), style: buttonStyle('ghost') }, '去配置')) : null,
      onboarding ? h('section', { className: 'studio-overview-onboarding' },
        h('div', { className: 'studio-overview-section-heading' }, h('div', null, h('h2', null, '创建你的第一个 Agent'), h('p', null, '从一个想法开始，或复用已经验证过的专家配置。'))),
        h('div', { className: 'studio-start-cards' }, createActions(false))) : h('section', { className: 'studio-overview-command', 'aria-label': '创建 Agent' },
        h('div', { className: 'studio-overview-command-copy' },
          h('span', { className: 'studio-overview-command-icon', 'aria-hidden': 'true' }, '✦'),
          h('div', null, h('h2', null, '创建新的 Agent'), h('p', null, '描述你的需求，和 AI 一起完成配置。'))),
        h('div', { className: 'studio-overview-command-actions' }, createActions(true))),
      hostReady && !onboarding ? h('section', { className: 'studio-overview-metrics', 'aria-label': '工作区统计' }, stats.map(([label, value, detail, target]) => h(target ? 'button' : 'article', {
        key: label, type: target ? 'button' : undefined, onClick: target ? () => onNavigate?.(target) : undefined, className: 'studio-overview-metric',
      }, h('span', { className: 'studio-overview-metric-label' }, label), h('strong', null, value), h('small', null, detail)))) : null,
      connection.warning ? h('p', { role: 'status', className: 'studio-inline-note', title: connection.warning }, connection.warning) : null,
      connection.status === 'loading' ? h(EmptyState, { icon: '·', title: directServerMode ? '正在读取 AgentEngine Server' : '正在读取 DSH Host' }) : connection.status === 'error' ? h(EmptyState, { icon: '!', title: directServerMode ? 'AgentEngine Server 不可达' : 'DSH Host 尚未连接', detail: connection.error, action: h('button', { type: 'button', onClick: load, style: buttonStyle() }, '重新连接') }) : null,
      hostReady ? h('div', { className: 'studio-overview-grid studio-overview-grid-primary' },
        onboarding ? onboardingPanel : h('section', { className: 'studio-overview-panel studio-overview-agents' },
          h('div', { className: 'studio-overview-panel-heading' },
            h('div', null, h('h2', null, '最近 Agent'), h('p', null, '继续配置，或直接开始一次对话')),
            h('button', { type: 'button', className: 'studio-overview-link', onClick: () => onNavigate?.('agents') }, `全部 ${connection.agents} 个`, h('span', { 'aria-hidden': 'true' }, ' →'))),
          recentAgents.length ? h('div', { className: 'studio-overview-agent-list' }, recentAgents.map(agent => {
            const metadata = agent?.metadata || agent || {};
            const spec = agent?.spec || {};
            const id = agentIdentity(agent);
            const runtime = spec.runtime?.type || agent?.runtime?.type || 'harness';
            const revision = Number(metadata.revision || 1);
            const built = (agent?.builds || []).some(build => String(build?.status || '').toUpperCase() === 'SUCCEEDED' && Number(build?.revision || 1) === revision);
            return h('article', { key: id, className: 'studio-overview-agent-row', 'data-overview-agent': id },
              h('span', { className: 'studio-overview-agent-icon', 'aria-hidden': 'true' }, '✦'),
              h('div', { className: 'studio-overview-row-main' },
                h('strong', null, metadata.name || id || '未命名 Agent'),
                h('div', { className: 'studio-overview-row-meta' }, `${RUNTIME_LABELS[runtime] || runtime} · r${revision} · ${formatDate(metadata.updatedAt || metadata.createdAt || agent?.updatedAt || agent?.createdAt)}`)),
              h('span', { className: 'studio-st studio-overview-agent-status', 'data-tone': built ? 'ok' : 'neutral' }, built ? '已构建' : '配置中'),
              h('button', { type: 'button', className: 'studio-overview-row-action', disabled: Boolean(bindingAgent), onClick: () => void bindAgent(agent) }, bindingAgent === id ? '绑定中…' : '对话'));
          })) : h('div', { className: 'studio-overview-compact-empty' }, connection.agents ? 'Agent 列表暂未读取，请在智能体页查看。' : '还没有 Agent，从一次对话开始吧。')),
        h('section', { className: 'studio-overview-panel studio-overview-health' },
          h('div', { className: 'studio-overview-panel-heading' }, h('div', null, h('h2', null, '工作区状态'), h('p', null, '运行前的关键配置检查'))),
          h('div', { className: 'studio-overview-health-list' },
            h('div', { className: 'studio-overview-health-row' }, h('span', null, 'Host 连接'), h('span', { className: 'studio-st', 'data-tone': hostReady ? 'ok' : 'err' }, hostReady ? '连接正常' : '未连接')),
            h('div', { className: 'studio-overview-health-row' }, h('span', null, '模型配置'),
              configurationNeeded ? h('button', { type: 'button', className: 'studio-overview-health-action', onClick: () => window.dispatchEvent(new CustomEvent('agentkit-studio:open-settings')) }, !credential.configured ? '缺凭证 · 去配置' : '无可用模型 · 去配置') : h('span', { className: 'studio-st', 'data-tone': credential.status === 'loading' ? 'neutral' : 'ok' }, credential.status === 'loading' ? '检查中' : '已配置')),
            h('div', { className: 'studio-overview-health-row' }, h('span', null, '运行目标'), h('span', { className: 'studio-st', 'data-tone': connection.runtimes || connection.runtimes === null ? 'ok' : 'warn' }, connection.runtimes === null ? '由 DSH 管理' : `${connection.runtimes || 0} 个可用`))),
          h('details', { className: 'studio-start-checks' }, h('summary', null, '查看启动检查', h('span', { 'aria-hidden': 'true' }, '›')), h(StartChecks)))) : null,
      hostReady && !onboarding ? h('div', { className: 'studio-overview-grid studio-overview-grid-secondary' },
        h('section', { className: 'studio-overview-panel' },
          h('div', { className: 'studio-overview-panel-heading' }, h('div', null, h('h2', null, '最近运行'), h('p', null, connection.activityError || '近 24 小时的 Agent 运行记录')), h('span', { className: 'studio-overview-panel-badge' }, '24h')),
          recentTraces.length ? h('div', { className: 'studio-overview-activity-list' }, recentTraces.map((trace, index) => {
            const [statusLabel, tone] = runStatus(trace?.status);
            const traceAgentId = String(trace?.agentId || trace?.AgentId || '');
            const title = trace?.agentName || agentNames.get(traceAgentId) || trace?.name || traceAgentId || operationalId(trace, '未命名运行');
            return h('article', { key: operationalId(trace, String(index)), className: 'studio-overview-activity-row' },
              h('span', { className: 'studio-overview-activity-icon', 'aria-hidden': 'true' }, '↗'),
              h('div', { className: 'studio-overview-row-main' }, h('strong', null, title), h('div', { className: 'studio-overview-row-meta' }, `${formatDate(trace?.startedAt || trace?.startTime || trace?.createdAt)} · ${formatDuration(trace?.durationMs)}`)),
              h('span', { className: 'studio-st', 'data-tone': tone }, statusLabel));
          })) : h('div', { className: 'studio-overview-compact-empty' }, connection.activityError ? '运行记录暂时无法读取。' : '近 24 小时还没有运行记录。')),
        h('section', { className: 'studio-overview-panel' },
          h('div', { className: 'studio-overview-panel-heading' }, h('div', null, h('h2', null, '待执行自动化'), h('p', null, '接下来按计划执行的本地任务')), h('span', { className: 'studio-overview-panel-badge' }, `${upcomingSchedules.length} 项`)),
          upcomingSchedules.length ? h('div', { className: 'studio-overview-activity-list' }, upcomingSchedules.map(task => {
            const taskAgentId = String(task?.target?.agentId || '');
            return h('article', { key: task.taskId, className: 'studio-overview-activity-row' },
              h('span', { className: 'studio-overview-activity-icon', 'aria-hidden': 'true' }, '◷'),
              h('div', { className: 'studio-overview-row-main' }, h('strong', null, task.displayName || task.taskId), h('div', { className: 'studio-overview-row-meta' }, agentNames.get(taskAgentId) || taskAgentId || '未绑定 Agent')),
              h('time', { className: 'studio-overview-schedule-time', dateTime: task.nextRunAt }, formatDate(task.nextRunAt)));
          })) : h('div', { className: 'studio-overview-compact-empty' }, '暂无待执行任务，可以在运行中心创建自动化。'))) : null);
  }
  return OverviewPage;
}
