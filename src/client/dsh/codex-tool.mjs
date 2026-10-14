export const codexToolDefinition = {
  kind: 'agentkit-codex-tool', target: 'chat',
  match(event) {
    if (event.type !== 'agentkit/codex-tool' || !event.data?.callId) return null;
    return { id: event.data.callId, role: 'start' };
  },
  start(_context, match) { return { first: match, latest: match }; },
  update(context, match) { return { first: context.state.first, latest: match }; },
  buildViewNode(context) {
    if (!context.state) return null;
    const { first, latest } = context.state;
    const data = latest.event.data;
    const location = context.start?.location || first.location;
    const closed = location.kind === 'step' && location.step.status === 'closed'
      ? location.step.end : (location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed' ? location.turn.end : null;
    const interrupted = data.phase === 'started' && closed;
    const current = context.current.get('chat');
    if (current?.data?.source === latest.event && current?.location === location && current?.data?.interrupted === Boolean(interrupted)) return current;
    const root = data.phase === 'started' && !interrupted ? {
      phase: 'start', callId: data.callId, name: data.name, argsRaw: data.arguments,
      turn: location.kind === 'step' || location.kind === 'turn' ? location.turn.turn : 0,
      step: location.kind === 'step' ? location.step.step : 0, time: first.event.time, subCalls: [],
    } : {
      kind: 'tool-result', seq: latest.event.seq, time: latest.event.time,
      callId: data.callId, call: { name: data.name, argsRaw: data.arguments }, callTime: first.event.time,
      content: data.content || [], isError: data.phase === 'failed' || Boolean(interrupted),
      ...(interrupted ? { error: { name: 'Interrupted', code: 'CODEX_TOOL_OUTCOME_UNKNOWN', reason: '未收到工具完成结果' } } : data.error ? { error: data.error } : {}),
      subCalls: [],
    };
    return {
      key: context.key, id: context.id, kind: 'tool-call', target: 'chat',
      anchorSeq: first.event.seq, location, visibility: 'visible',
      data: { root, source: latest.event, interrupted: Boolean(interrupted) },
    };
  },
};
