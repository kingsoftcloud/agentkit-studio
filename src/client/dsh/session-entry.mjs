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
  let disposed = false, choosingWorkspace = false;
  const active = () => !disposed && isActive();
  const bindAgent = async (agentOrOptions, requestedBuildId = '') => {
    if (!active()) return;
    const options = agentOrOptions && typeof agentOrOptions === 'object' ? agentOrOptions : { agentId: agentOrOptions, buildId: requestedBuildId };
    const value = String(options.agentId || '').trim();
    const buildId = String(options.buildId || '').trim();
    if (!value && options.workspaceFree !== true) return;
    try {
      const current = options.workspaceFree === true ? undefined
        : Object.values(navCtx.sessions.list?.getSnapshot().byId ?? {}).find(session => session.retainedBy?.mainView > 0);
      let cwd = options.cwd ?? current?.cwd;
      let workspaceId = options.workspaceId ?? (options.cwd === undefined && current
        ? navCtx.workspaces?.list.getSnapshot().items.find(workspace => workspace.sessionIds.includes(current.id))?.workspaceId : undefined);
      const admit = () => value ? hostRemote.ensureDshPreset(value, buildId, undefined, cwd) : null;
      let admission;
      try { admission = await admit(); }
      catch (error) {
        if (error?.code !== 'NATIVE_ENGINE_WORKSPACE_UNAVAILABLE' || options.throwOnError || options.cwd !== undefined
          || options.workspaceId !== undefined || typeof hostRemote.starHarnessStatus !== 'function') throw error;
        if (!active() || choosingWorkspace) return;
        choosingWorkspace = true;
        try {
          const status = await hostRemote.starHarnessStatus();
          if (!active()) return;
          const titles = new Map((status.workspaceChoices ?? []).map(({ path, title }) => [path, title]));
          const choices = (status.workspaces ?? []).filter(item => item.external ? item.running : status.enabled && !item.missing).map(item => {
            const title = titles.get(item.workspace);
            return { value: item.workspace, label: title ? title + ' · ' + item.workspace : item.workspace };
          });
          if (!choices.length) {
            const configure = await actions.confirm({ title: '选择 StarOrigin Harness 工作区',
              detail: '请在 Studio 中添加或选择工作区，并在插件页启用 StarOrigin Harness。', confirmLabel: '打开插件页' });
            if (configure && active()) layout.selectPanel('plugins');
            return;
          }
          const selected = await actions.confirm({ title: '选择 StarOrigin Harness 工作区',
            detail: '新会话将在所选工作区运行。', choiceLabel: 'StarOrigin Harness 工作区',
            choicePlaceholder: '选择工作区', choices, confirmLabel: '开始对话' });
          if (!active() || !choices.some(choice => choice.value === selected)) return;
          cwd = selected;
          workspaceId = navCtx.workspaces?.list.getSnapshot().items.find(workspace => workspace.path === cwd)?.workspaceId;
          admission = await admit();
        } finally { choosingWorkspace = false; }
      }
      if (!active()) return;
      // Mount the admitted persona once, as part of creating the session.
      const sessionOptions = admission ? { agentPreset: admission.presetId } : {};
      if (workspaceId) sessionOptions.workspaceId = workspaceId;
      else if (cwd ?? admission?.workspaceRoot) sessionOptions.cwd = cwd ?? admission.workspaceRoot;
      const sessionId = await navCtx.sessions.create(sessionOptions);
      if (!active()) return;
      const modelSelection = admission?.serviceOwnedModel
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
