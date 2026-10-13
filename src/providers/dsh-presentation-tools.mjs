/** Codex compatibility only: DSH still validates files and owns delivery events/UI. */
export function createDshPresentationTools(ctx) {
  const available = agent => (ctx.tools.schemas?.(agent) || []).find(tool => tool.name === 'present');
  return {
    listPresentationTools(agent) { const tool = available(agent); return tool ? [tool] : []; },
    async callPresentationTool(name, args, { agent, callId, signal } = {}) {
      if (name !== 'present' || !available(agent)) throw Object.assign(new Error('DSH present 工具在此会话中不可用'), { code: 'TOOL_NOT_FOUND' });
      // PTC owns root dispatch. Its official SDK calls present as a nested
      // operation, preserving both policy checks and the tools/result hook.
      const ptc = ctx.tools.modeFor?.(agent) === 'ptc';
      const result = await ctx.tools.execute({
        name: ptc ? 'run_code' : 'present',
        arguments: ptc ? { code: `return await tools.present(${JSON.stringify(args)});`, description: 'Present final deliverables' } : args,
        agent, callId, signal: signal || new AbortController().signal,
      });
      if (result?.isError) throw Object.assign(new Error('DSH 交付文件校验或执行失败'), { code: result.error?.code || 'DSH_PRESENT_FAILED' });
      return result;
    },
  };
}

/** Namespace the official tool so it cannot collide with native Codex tools. */
export function codexPresentationBindings(adapter, agent) {
  return (adapter?.listPresentationTools?.(agent) || []).map(tool => ({
    ...tool, name: 'dsh_present', _source: 'dsh-presentation', _dshName: tool.name,
  }));
}
