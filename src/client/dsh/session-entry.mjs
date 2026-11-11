function modelSelectionBoundaryError(error) {
  const code = String(error?.code || error?.error?.code || '').trim();
  const field = String(error?.details?.field || error?.error?.details?.field || '').trim();
  const message = String(error?.message || error?.error?.message || '');
  return (code === 'gateway/input-invalid' && (!field || field === 'request'))
    || /session\/selectModel:\s*wire field ["']request["'] failed boundary validation/i.test(message);
}

/**
 * Select a Session model without leaking the global default when the current
 * DSH profile supports `saveDefault: false`. Older installed profiles expose
 * the same endpoint but reject that optional field at the Typert boundary;
 * retry once with the legacy request shape so Agent binding remains usable.
 */
export async function selectSessionModel(remote, request = {}) {
  const select = payload => remote.session.selectModel(payload);
  try {
    const result = await select(request);
    if (request?.saveDefault !== false || result?.ok !== false || !modelSelectionBoundaryError(result)) return result;
    const legacy = { ...request };
    delete legacy.saveDefault;
    return select(legacy);
  } catch (error) {
    if (request?.saveDefault !== false || !modelSelectionBoundaryError(error)) throw error;
    const legacy = { ...request };
    delete legacy.saveDefault;
    return select(legacy);
  }
}

/** Admit a revision/build through the durable DSH APIs before native navigation. */
export function createNativeSessionBinding({ navCtx, remote, layout, hostRemote, writeConversationAgent, actions, isActive = () => true, console = globalThis.console }) {
  let disposed = false;
  const active = () => !disposed && isActive();
  const bindAgent = async (agentOrOptions, requestedBuildId = '') => {
    if (!active()) return;
    const options = agentOrOptions && typeof agentOrOptions === 'object' ? agentOrOptions : { agentId: agentOrOptions, buildId: requestedBuildId };
    const value = String(options.agentId || '').trim();
    const buildId = String(options.buildId || '').trim();
    if (!value && options.workspaceFree !== true) return;
    try {
      const admission = value ? await hostRemote.ensureDshPreset(value, buildId) : null;
      if (!active()) return;
      // Mount the admitted persona once, as part of creating the session.
      const sessionOptions = admission ? { agentPreset: admission.presetId } : {};
      if (admission?.workspaceRoot) sessionOptions.cwd = admission.workspaceRoot;
      const sessionId = await navCtx.sessions.create(sessionOptions);
      if (!active()) return;
      const modelSelection = admission?.workspaceRoot
        ? admission.modelSelection : options.modelSelection || admission?.modelSelection;
      if (modelSelection) {
        const result = await selectSessionModel(remote, { sessionId, ...modelSelection, saveDefault: false });
        if (!active()) return;
        if (!result?.ok) throw new Error(result?.error?.message || 'Agent 绑定的模型不可用');
      }
      try {
        const permission = await remote.commands?.execute?.(sessionId, '/permission workspace-write', []);
        if (permission?.ok === false) console.warn('[agentkit-studio] Agent permission default was not applied:', permission.error?.message || permission.error);
      } catch (error) { console.warn('[agentkit-studio] Agent permission default unavailable:', error?.message || error); }
      if (!active()) return;
      writeConversationAgent(value, sessionId);
      navCtx.uiWorkspace.openSession(sessionId);
      layout.selectPanel(null);
    } catch (error) {
      if (!active()) return;
      if (options.throwOnError) throw error;
      console.error('[agentkit-studio] native Agent binding failed:', error);
      void actions.confirm({ title: 'Agent 绑定失败', detail: error?.message || 'Agent 绑定失败', confirmLabel: '知道了' });
    }
  };
  return { bindAgent, dispose: () => { disposed = true; } };
}
