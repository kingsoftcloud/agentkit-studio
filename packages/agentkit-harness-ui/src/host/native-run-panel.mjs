import { createContextStatus, contextStatusStyles } from '@kingsoftcloud/agentkit-harness-ui/context-status';
import { createNativeChildrenState } from './state/native-children.mjs';
import { createNativeRecoveryState } from './state/native-recovery.mjs';
import { createNativeA2aPanel } from './native-a2a.mjs';
import { nativeRunPresentation } from './state/native-outcome.mjs';
import { createNativeSessionStop } from './state/native-session-stop.mjs';

const phases = { created: '已准备', preparing: '准备中', requesting_model: '推理中', requesting_context: '整理上下文',
  requesting_input: '读取输入', executing_tools: '执行工具', awaiting_interaction: '等待审批', paused: '已暂停',
  awaiting_reconciliation: '等待核对结果', reconciling_tool: '正在核对结果',
  completed: '已完成', failed: '已失败', interrupted: '需要恢复核对', canceled: '已取消', finalizing: '收尾中' };
const memoryError = code => ({ native_memory_extraction_budget_exhausted: '已达到提炼预算上限',
  studio_native_memory_extraction_not_current_head: '会话已有新进展，本次提炼已停止',
  studio_native_memory_extraction_policy_changed: '记忆配置已变化，本次提炼已停止',
  studio_native_memory_model_binding_changed: '原模型配置已变化，请检查配置' })[code] ?? '请检查模型与记忆配置';

export function createNativeChildPanel({ ui: { React: { createElement: h, useEffect, useState, Fragment }, ResourceDialog, buttonStyle },
  hostRemote, resolveAgentFromPreset, createForeignRuntimePanel = () => () => null,
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  if (typeof resolveAgentFromPreset !== 'function') throw TypeError('The host preset-to-Agent resolver is required');
  const ContextStatus = createContextStatus({ createElement: h });
  const A2aTask = createNativeA2aPanel({ React: { createElement: h, useEffect, useState }, hostRemote, buttonStyle });
  const DshA2aPanel = createForeignRuntimePanel({ ui: { React: { createElement: h, useEffect, useState, Fragment }, ResourceDialog, buttonStyle }, hostRemote });
  function TaskPanel({ agentId, sessionId, transportRunning, requestSessionStop }) {
    const [controller, setController] = useState(null), [state, setState] = useState({ page: null, detail: null }), [open, setOpen] = useState(false);
    const [drafts, setDrafts] = useState({});
    const [backgroundStopped, setBackgroundStopped] = useState(false);
    const [recovery, setRecovery] = useState(null), [recoveryState, setRecoveryState] = useState({ status: null });
    const [stop, setStop] = useState(null), [stopState, setStopState] = useState({ visible: false });
    useEffect(() => {
      if (typeof requestSessionStop !== 'function') { setStop(null); setStopState({ visible: false }); return; }
      const next = createNativeSessionStop({ sessionId, requestStop: requestSessionStop });
      setStop(next); setStopState(next.getSnapshot()); const unsubscribe = next.subscribe(setStopState);
      return () => { unsubscribe(); next.dispose(); };
    }, [sessionId, requestSessionStop]);
    useEffect(() => { stop?.observe(recoveryState.status, transportRunning); }, [stop, recoveryState.status, transportRunning]);
    useEffect(() => {
      const next = createNativeRecoveryState({ hostRemote, agentId, sessionId });
      setRecovery(next); setRecoveryState(next.getSnapshot()); const stop = next.subscribe(setRecoveryState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    useEffect(() => {
      const next = createNativeChildrenState({ hostRemote, agentId, sessionId });
      setController(next); setState(next.getSnapshot()); const stop = next.subscribe(setState);
      return () => { stop(); next.dispose(); };
    }, [agentId, sessionId]);
    useEffect(() => {
      if (!controller) return;
      if (open) void controller.refresh();
      void recovery?.refresh();
      const timer = setInterval(() => { if (open && (controller.getSnapshot().page?.offset ?? 0) === 0) void controller.refresh(); void recovery?.refresh(); }, 2500);
      return () => clearInterval(timer);
    }, [open, controller, recovery]);
    const page = state.page, detail = state.detail;
    useEffect(() => setBackgroundStopped(false), [recoveryState.status?.runId]);
    const accounting = recoveryState.status?.accounting;
    const cloudMemory = recoveryState.status?.cloudMemory;
    const memoryJobs = recoveryState.status?.memoryExtraction?.jobs ?? [];
    const executionGrant = recoveryState.status?.managed?.executionGrant;
    const presentation = nativeRunPresentation(recoveryState.status);
    const ordinaryEnd = recoveryState.status?.phase === 'completed'
      && recoveryState.status?.outcome === 'unverified' && recoveryState.status?.verificationRequired === false;
    return h(Fragment, null,
      presentation && !ordinaryEnd ? h('span', { role: 'status', title: presentation.detail, 'aria-label': 'Native 任务状态', style: { fontSize: '12px', marginRight: '8px' } }, presentation.label) : null,
      stopState.visible ? h('button', { type: 'button', style: buttonStyle(), disabled: !stopState.canStop,
        onClick: () => void stop?.request() }, ['requesting', 'requested'].includes(stopState.phase) ? '正在停止…' : '停止当前任务') : null,
      stopState.visible && stopState.error ? h('span', { role: 'alert' }, stopState.error) : null,
      h('button', { type: 'button', style: buttonStyle(), onClick: () => setOpen(true) }, '运行与子任务'),
      open ? h(ResourceDialog, { title: '本会话的运行与子任务', detail: '查看运行用量、恢复状态及各轮子任务。子任务结果仍需父任务验收。', wide: true, onClose: () => setOpen(false) },
        h('button', { type: 'button', style: buttonStyle(), disabled: !controller || state.loading, onClick: () => { void controller?.refresh(); void recovery?.refresh(); } }, state.loading ? '读取中…' : '刷新'),
        recoveryState.error ? h('p', { role: 'alert' }, recoveryState.error) : null,
        recoveryState.status?.error ? h('p', { role: 'alert' }, recoveryState.status.error.message) : null,
        presentation ? h('section', { 'aria-label': '任务结果状态' }, h('strong', null, presentation.label), h('p', null, presentation.detail)) : null,
        recoveryState.status?.capabilities ? h('details', null, h('summary', null, '本轮实际可用工具'),
          h('p', { style: { overflowWrap: 'anywhere' } }, recoveryState.status.capabilities.toolNames.join('、') || '未绑定工具'),
          h('p', null, '工具仅可在获准范围内执行。需要其他能力时，请编辑 Agent 的「绑定能力」并新建会话。')) : null,
        h('style', null, contextStatusStyles),
        h(ContextStatus, { value: recoveryState.status?.contextStatus, runId: recoveryState.status?.runId, labels: {
          context: '上下文', automatic: '自动压缩', disabled: '已关闭', trigger: '触发阈值', reserved: '预留输出',
          lastRequest: '最近一次请求的上下文估算', unknown: '尚未计量', compacting: '正在压缩上下文',
          interrupted: '上下文压缩已中断', blocked: '上下文预算不足', completed: '已完成压缩',
        } }),
        accounting ? h('section', { 'aria-label': 'Native 运行用量' },
          h('p', null, `运行用量${accounting.incomplete ? '（统计不完整，显示已知用量）' : accounting.final ? '' : '（截至目前）'}：模型 ${accounting.total.modelCalls} 次 · 工具 ${accounting.total.toolCalls} 次 · 输入 ${accounting.total.inputTokens} / 输出 ${accounting.total.outputTokens} tokens。`),
          h('p', { style: { fontSize: '12px' } }, '包含本运行、工具内模型调用及已结算的子任务用量。')) : null,
        memoryJobs.length ? h('section', { 'aria-label': '自动记忆提炼' },
          h('p', null, '自动记忆提炼的额外用量单独列出。成功表示提炼流程结束，是否写入以记忆工具回执为准。'),
          ...memoryJobs.slice(-5).reverse().map(job => h('p', { key: job.jobId,
            role: job.status === 'error' ? 'alert' : 'status' },
            `记忆提炼：${({ queued: '排队中', running: '运行中', success: '已完成', 'no-op': '无需提炼',
              error: '未完成', aborted: '已停止', superseded: '已合并到新窗口' })[job.status]}`,
            job.usage ? ` · 模型 ${job.usage.modelCalls} 次 · 输入 ${job.usage.inputTokens} / 输出 ${job.usage.outputTokens} tokens` : '',
            job.errorCode ? ` · ${memoryError(job.errorCode)}` : ''))) : null,
        cloudMemory ? h('section', { 'aria-label': '云记忆提交' },
          h('p', { role: cloudMemory.state === 'accepted' ? 'status' : 'alert' },
            cloudMemory.state === 'accepted' ? '云记忆服务已受理；记忆抽取和索引尚未确认。'
              : cloudMemory.state === 'unavailable' ? '云记忆提交记录暂时无法读取，请刷新核对。'
                : cloudMemory.state === 'unconfirmed' ? '云记忆原提交尚无确认回执，可能仍在处理或已中断。'
                  : '云记忆原提交结果未知。'),
          cloudMemory.state !== 'unavailable' ? h(Fragment, null,
            cloudMemory.state !== 'accepted' ? h('p', null, '请携带原提交标识到云记忆服务核对。刷新只读取本地记录，不会重新提交。') : null,
            h('details', { style: { overflowWrap: 'anywhere' } }, h('summary', null, '云记忆原提交标识'),
              h('p', null, `记忆库：${cloudMemory.resourceId}`), h('p', null, `原请求：${cloudMemory.requestId}`),
              cloudMemory.receiptRequestId ? h('p', null, `服务回执：${cloudMemory.receiptRequestId}`) : null,
              ...cloudMemory.messageIds.map(id => h('p', { key: id }, `原消息：${id}`)),
              h('p', null, `运行：${cloudMemory.runId}`), h('p', null, `本地提交记录：${cloudMemory.operationId}`))) : null) : null,
        executionGrant && (executionGrant.blockedReason || recoveryState.status.managed.commandState === 'discarded')
          ? h('section', { 'aria-label': '任务执行授权' }, h('p', null,
            recoveryState.status.managed.commandState === 'discarded' ? '排队任务已因执行授权撤销而关闭。'
              : ['execution_grant_suspended', 'execution_grant_admission_paused'].includes(executionGrant.blockedReason)
                ? '任务正在排队，等待执行授权恢复。' : '任务正在排队，执行授权需要重新确认。')) : null,
        recoveryState.status && recoveryState.status.state !== 'closed' && !executionGrant?.blockedReason ? h('section', { 'aria-label': '原运行恢复' },
          h('p', null, recoveryState.status.managed && recoveryState.status.phase === 'paused'
            ? '原托管运行已暂停，请通过原控制端恢复。'
            : recoveryState.status.managed && recoveryState.status.phase === 'awaiting_interaction'
              ? '原托管运行正在等待审批，请通过原控制端答复。'
            : recoveryState.status.managed && recoveryState.status.state === 'reconciliation_required'
              ? '原托管运行有待核对的执行结果，请通过原控制端处理；不会自动重跑。'
            : recoveryState.status.managed?.executionState === 'queued'
              ? '原托管命令已接收，正在等待接回会话；尚未确认开始执行。'
            : recoveryState.status.state === 'recovering' ? '原运行已接管，正在继续。'
            : recoveryState.status.receiptWait ? '原远端调用仍在等待。可接回原运行继续等待，或主动核对远端结果；不会重发原调用。'
              : recoveryState.status.state === 'reconciliation_required' ? '有执行结果未知的操作，需要核对；不会自动重跑。'
              : recoveryState.status.state === 'failed' ? '恢复未完成，请核对原配置后重试。' : '检测到尚未结束的原运行，可继续原任务。'),
          recoveryState.status.canResume && !recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
            onClick: () => void recovery.resume() }, recoveryState.status.receiptWait ? '接回原运行并继续等待' : '恢复原运行') : null,
          recoveryState.status.canReconcile && !recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
            onClick: () => void recovery.reconcile() }, '核对结果并继续原运行') : null,
          recoveryState.status.canReviewBackground && !recoveryState.pending ? h('section', { 'aria-label': '结束后台结果等待' },
            h('p', null, '确认原进程已停止后，可以关闭本轮并继续新任务。原命令结果仍为未知，不会重跑，也不会撤销已经发生的修改。'),
            !recoveryState.status.backgroundInterruptionReview ? h('label', null,
              h('input', { type: 'checkbox', checked: backgroundStopped,
                onChange: event => setBackgroundStopped(event.target.checked) }), '我已核对原进程停止') : null,
            h('button', { type: 'button', style: buttonStyle(),
              disabled: recoveryState.sending || !backgroundStopped && !recoveryState.status.backgroundInterruptionReview,
              onClick: () => void recovery.reviewBackground() }, '结束等待并保留未知结果')) : null,
          recoveryState.status.canRetireResources && !recoveryState.pending ? h('section', { 'aria-label': '隔离旧浏览器资源' },
            h('p', null, '可隔离旧浏览器并结束本轮，之后获取新的页面观察。原动作结果仍为未知，不会重放。'),
            h('button', {type:'button',style:buttonStyle(),disabled:recoveryState.sending,
              onClick:()=>void recovery.retireResources()}, '隔离旧浏览器并继续新一轮')) : null,
          recoveryState.status.canRepairWorkspace && !recoveryState.pending ? h('details', null,
            h('summary', null, '无法取得文件操作结果？'),
            h('p', null, '可撤销这次未确认操作的文件修改，再继续原运行。已被外部修改的文件会阻止撤销；请优先核对原结果。'),
            h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
              onClick: () => void recovery.repairWorkspace() }, '撤销未确认文件修改并继续')) : null) : null,
        recoveryState.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: recoveryState.sending,
          onClick: () => void recovery.retry() }, recoveryState.sending ? '正在确认…' : '确认原运行恢复请求') : null,
        ...(recoveryState.status?.a2aTasks ?? []).map(task => h(A2aTask, { key: `${task.runId}:${task.operationKey}:${task.callId}`,
          task: { ...task, agentId, sessionId } })),
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.pending ? h('button', { type: 'button', style: buttonStyle(), disabled: state.sending, onClick: () => void controller.retryControl() }, state.sending ? '正在确认…' : '重试原子任务请求') : null,
        page && !page.tasks.length ? h('p', null, '本会话还没有子任务。') : null,
        ...(page?.tasks ?? []).map(task => h('article', { key: task.childRunId, style: { borderTop: '1px solid var(--border, #ddd)', padding: '14px 0', overflowWrap: 'anywhere' }, 'aria-label': `子任务：${task.role}` },
          h('strong', null, task.role), ' · ', phases[task.phase] || '运行中', ' · ', task.delivery === 'foreground' ? '前台等待' : '后台',
          task.parentRunId !== page.runId ? h('span', null, ' · 历史轮次') : null,
          task.continuationOf ? h('span', null, ' · 续接任务') : null,
          task.lastControl ? h('p', { role: task.lastControl.status === 'rejected' ? 'alert' : 'status' },
            task.lastControl.status === 'pending' ? '操作已接收，等待投递。' : task.lastControl.status === 'delivered' ? '操作已投递至原子任务。'
              : `操作未投递：${task.lastControl.reason === 'stale_child_goal_revision' ? '子任务目标已变化，请刷新后核对指导。' : task.lastControl.reason}`) : null,
          h('p', { style: { whiteSpace: 'pre-wrap' } }, task.goalPreview, task.goalComplete ? '' : '…'),
          h('p', { style: { fontSize: '12px' } }, `子任务用量${task.usageComplete ? '' : '（可能未完整）'}：模型 ${task.usage.modelCalls} 次 · 工具 ${task.usage.toolCalls} 次 · 输入 ${task.usage.inputTokens} / 输出 ${task.usage.outputTokens} tokens；${task.usageIncludedInParent ? '已计入父任务' : '结算后计入父任务'}。`),
          ...(task.a2aTasks ?? []).map(remote => h(A2aTask, { key: `${remote.childRunId}:${remote.operationKey}:${remote.callId}`,
            task: { ...remote, agentId, sessionId } })),
          h('button', { type: 'button', disabled: state.reading, style: buttonStyle(), onClick: () => void controller.read(task) }, task.resultAvailable ? '查看结果' : '查看状态'),
          task.canPromote ? h('button', { type: 'button', disabled: Boolean(state.pending), style: buttonStyle(), onClick: () => void controller.promote(task) }, '转为后台') : null,
          task.canCancel ? h('button', { type: 'button', disabled: Boolean(state.pending), style: buttonStyle(), onClick: () => void controller.cancel(task) }, '停止子任务') : null,
          task.canSendInput ? h('div', null,
            h('textarea', { 'aria-label': `给 ${task.role} 补充指导`, maxLength: 32768, rows: 2, value: drafts[task.childRunId] ?? '',
              disabled: Boolean(state.pending), onChange: event => setDrafts({ ...drafts, [task.childRunId]: event.target.value }) }),
            h('button', { type: 'button', disabled: Boolean(state.pending) || !drafts[task.childRunId]?.trim(), style: buttonStyle(),
              onClick: () => void controller.sendInput(task, drafts[task.childRunId]) }, '发送指导')) : null,
          h('details', null, h('summary', null, '任务标识'), h('p', null, task.childRunId), h('p', null, `会话：${task.sessionId}`), h('p', null, `父任务：${task.parentRunId}`)))),
        page && !page.complete ? h('button', { type: 'button', disabled: state.loading, style: buttonStyle(), onClick: () => void controller.next() }, '加载更多子任务') : null,
        detail ? h('section', { 'aria-label': '子任务结果', style: { marginTop: '16px' } }, h('h4', null, detail.task.role),
          detail.task.resultAvailable ? h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, detail.text)
            : h('p', null, detail.task.phase === 'interrupted' ? '结果未知，需要恢复核对。不会自动重跑副作用。' : '尚无安全封存且已结算的结果。'),
          !detail.complete ? h('button', { type: 'button', disabled: state.reading, style: buttonStyle(), onClick: () => void controller.read(detail.task, true) }, '继续读取结果') : null) : null) : null);
  }
  return function NativeChildPanel({ sessionId, useSessions, requestSessionStop }) {
    const session = useSessions(state => state?.byId?.[sessionId]), presetId = session?.projectionValues?.agentPreset;
    const [agent, setAgent] = useState(null);
    useEffect(() => {
      let active = true; setAgent(null);
      (async () => {
        const first = await hostRemote.agents({ source: 'local', pageSize: 100 }), items = [...(first.items ?? [])];
        for (let page = 2; active && items.length < Number(first.total || 0); page++) {
          const next = await hostRemote.agents({ source: 'local', pageSize: 100, page });
          if (!next.items?.length) break; items.push(...next.items);
        }
        const id = resolveAgentFromPreset(presetId, items), found = items.find(item => item.metadata?.id === id);
        if (active && found?.metadata?.local === true && ['dsh-native', 'harness', 'codex'].includes(found.spec?.runtime?.type))
          setAgent({ id: found.metadata.id, runtime: found.spec.runtime.type, sessionId, presetId });
      })().catch(() => {});
      return () => { active = false; };
    }, [sessionId, presetId]);
    return agent?.sessionId === sessionId && agent?.presetId === presetId
      ? h(Fragment, null, agent.runtime === 'harness'
        ? h(TaskPanel, { key: `${agent.id}:${sessionId}`, agentId: agent.id, sessionId,
          transportRunning: session?.running === true, requestSessionStop }) : null,
        h(DshA2aPanel, { key: `a2a:${agent.id}:${sessionId}`, agentId: agent.id, sessionId })) : null;
  };
}
