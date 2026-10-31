/** Run automated work through the same public DSH Session/Agent API as native chats. */
import { UNATTENDED_EXECUTION_POLICY, readExecutionMode } from './execution-policy.mjs';
import { readNativeRequestEvents } from './native-request-history.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';
import { RESOURCE_CHECK_EVENT, sanitizeResourceCheck } from './resource-checks.mjs';

export function createNativeAutomationRunner({ getService, admit, observe, selectModel, loadReplay, assertHostCompatible, timeoutMs = 300000, reuseSession = false } = {}) {
  const lanes = new Map();
  const service = name => {
    const value = getService?.(name);
    if (!value) throw Object.assign(new Error(`自动化需要 DSH ${name} 服务`), { code: 'AUTOMATION_SERVICE_UNAVAILABLE' });
    return value;
  };
  const run = async ({ agentId, sessionId, occurrenceId, input, model, requestFingerprint, buildId = '', timeoutSeconds, signal: callerSignal, onFrame, approvalPolicy = UNATTENDED_EXECUTION_POLICY.approvalPolicy, permissionMode }) => service('agents').withoutInitiator(async () => {
    const startedAt = Date.now();
    const controller = service('sessionController');
    const expiry = AbortSignal.timeout(timeoutSeconds ? Math.max(1000, Number(timeoutSeconds) * 1000) : timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, expiry]) : expiry;
    signal.throwIfAborted();
    const existing = reuseSession && await controller.projections({ sessionId }, signal);
    if (existing && loadReplay) {
      const replay = await loadReplay({ controller, sessionId, occurrenceId, input, model, requestFingerprint, signal });
      signal.throwIfAborted();
      if (replay) return nativeRunResult(replay, sessionId, startedAt);
    }
    if (!existing) {
      const admission = await admit(agentId, buildId);
      await controller.create({ sessionId, agentPreset: admission.presetId });
      if (admission.modelSelection) await controller.selectModel({ sessionId, ...admission.modelSelection, saveDefault: false });
    }
    if (model !== undefined && selectModel) {
      const selection = await selectModel(model);
      await controller.selectModel({ sessionId, ...selection, saveDefault: false });
    }
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    const agent = resolved.agent;
    signal.throwIfAborted();
    // The command is a user action and would misattribute its approval notice.
    // Only a validated request mode can narrow the default unattended policy.
    service('permissionPresets').set(agent.session, readExecutionMode(permissionMode) || UNATTENDED_EXECUTION_POLICY.permissionMode);
    // A managed run may ask a person through the Host's approval answerer;
    // every other run stays headless and rejects escalation through the same
    // public approval service. Confinement is unchanged either way.
    service('approval').setPolicy(agent, approvalPolicy ?? UNATTENDED_EXECUTION_POLICY.approvalPolicy, { actor: 'automation' });
    signal.throwIfAborted();
    const unobserve = onFrame ? observe?.(agent, onFrame) : undefined;
    try {
      await controller.prompt({ sessionId, requestId: occurrenceId, ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
        mode: 'queue', content: [{ type: 'text', text: String(input || '') }], clientTimeZone: 'Asia/Shanghai' }, signal);
      await new Promise((resolve, reject) => {
        const onAbort = () => { agent.cancel({ kind: 'user' }); reject(signal.reason || Object.assign(new Error('自动化运行超时'), { code: 'AUTOMATION_TIMEOUT' })); };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        agent.whenIdle().then(() => { signal.removeEventListener('abort', onAbort); resolve(); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
      });
      let events;
      if (reuseSession) {
        try { events = await readNativeRequestEvents(controller, sessionId, occurrenceId, signal); }
        catch (error) {
          // A turn that fails before DSH persists its user message (admission or
          // model routing) leaves no request to page back to. Prefer the failure
          // the turn already recorded over the opaque missing-request code.
          if (error?.code !== 'CHANNEL_REQUEST_NOT_FOUND') throw error;
          const tail = await readNativeTailEvents(controller, sessionId, signal);
          const reason = tail.findLast(item => item.type === 'turn/end')?.data?.reason;
          if (!reason?.kind || reason.kind === 'completed') throw error;
          return nativeRunResult(tail, sessionId, startedAt);
        }
      }
      else {
        const projection = await controller.projections({ sessionId }, signal);
        const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: projection?.asOfSeq ?? -1, maxMessages: 200 }, signal);
        events = (page?.records || []).filter(item => item.type === 'event').map(item => item.event);
      }
      return nativeRunResult(events, sessionId, startedAt);
    } finally { unobserve?.(); }
  });
  const runner = request => {
    const previous = lanes.get(request.sessionId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => { assertHostCompatible?.(); return run(request); });
    lanes.set(request.sessionId, task);
    void task.finally(() => { if (lanes.get(request.sessionId) === task) lanes.delete(request.sessionId); }).catch(() => {});
    return task;
  };
  runner.executionPolicy = UNATTENDED_EXECUTION_POLICY;
  return runner;
}

/** Trailing session events; used when a failed turn recorded no accepted request. */
async function readNativeTailEvents(controller, sessionId, signal) {
  const projection = await controller.projections({ sessionId }, signal);
  const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: projection?.asOfSeq ?? -1, maxMessages: 200 }, signal);
  return (page?.records || []).filter(item => item.type === 'event').map(item => item.event);
}

function nativeRunResult(events, sessionId, startedAt) {
  const end = events.findLast(item => item.type === 'turn/end');
  if (end?.data?.reason?.kind !== 'completed') {
    const reason = end?.data?.reason;
    throw Object.assign(new Error(reason?.error?.message || `自动化运行未完成：${reason?.kind || '没有回合结束记录'}`), { code: reason?.error?.code || 'AUTOMATION_RUN_FAILED' });
  }
  const messages = events.filter(event => event.type === 'assistant/message');
  const output = (messages.at(-1)?.data?.message?.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
  const usages = messages.map(event => event.data?.usage).filter(Boolean);
  const tokenUsage = usages.length ? { inputTokens: usages.reduce((sum, usage) => sum + Number(usage.inputTokens || 0) + Number(usage.cacheReadTokens || 0) + Number(usage.cacheWriteTokens || 0), 0), outputTokens: usages.reduce((sum, usage) => sum + Number(usage.outputTokens || 0), 0) } : {};
  const toolCalls = [...new Map(events.filter(event => event.type === 'tool/call' || event.type === CODEX_TOOL_EVENT).map(event => [event.data.callId, { name: event.data.name, callId: event.data.callId }])).values()];
  const resourceChecks = events.filter(event => event.type === RESOURCE_CHECK_EVENT).map(event => sanitizeResourceCheck(event.data)).filter(Boolean);
  return { sessionId, runId: `dsh:${sessionId}:${end.seq}`, output, tokenUsage, latencyMs: Date.now() - startedAt, toolCalls, resourceChecks };
}
