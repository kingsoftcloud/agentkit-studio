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
      const sessionId = await navCtx.sessions.create({});
      if (!active()) return;
      if (admission) {
        const selected = await remote?.agentPresets?.select?.(sessionId, admission.presetId);
        if (!active()) return;
        if (selected === undefined || selected === null || (typeof selected === 'object' && selected.ok === false)) throw new Error(selected?.error?.message || 'DSH 拒绝绑定该 Agent');
      }
      const modelSelection = options.modelSelection || admission?.modelSelection;
      if (modelSelection) {
        const result = await remote.session.selectModel({ sessionId, ...modelSelection, saveDefault: false });
        if (!active()) return;
        if (!result?.ok) throw new Error(result?.error?.message || 'Agent 绑定的模型不可用');
      }
      try {
        const permission = await remote.commands?.execute?.(sessionId, '/permission read-only', []);
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
