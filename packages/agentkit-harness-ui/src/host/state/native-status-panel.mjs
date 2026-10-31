/** Host facts adapted to the independent status presentation. No execution capability. */
export function nativeStatusPanelModel(status, children = [], commandObservations = []) {
  const activity = status?.activity;
  const admitted = activity?.contract === 'agentkit.native-activity-status/v1' && activity.runId === status?.runId;
  const sourceGit = status?.workspaceStatus?.state === 'available' ? status.workspaceStatus.git : null;
  const git = sourceGit && ['added', 'removed', 'dirtyFileCount'].every(key => Number.isSafeInteger(sourceGit[key]) && sourceGit[key] >= 0)
    && (sourceGit.branchName === null || typeof sourceGit.branchName === 'string') && sourceGit.added + sourceGit.removed > 0
    ? { ...sourceGit } : null;
  const plan = admitted && activity.plan && Array.isArray(activity.plan.items) ? activity.plan : null;
  const facts = commandObservations.filter(fact => fact?.contract === 'agentkit.command-output-status/v1'
    && fact.agentId === status?.agentId && fact.sessionId === status?.sessionId && fact.runId === status?.runId
    && ['starting', 'running', 'completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown', 'unavailable'].includes(fact.status));
  const terminals = admitted && Array.isArray(activity.terminals) ? activity.terminals.map(terminal => {
    const observed = facts.find(fact => fact.taskId === terminal.id);
    return observed ? { ...terminal, state: observed.status,
      ...(typeof observed.command === 'string' && observed.command ? { title: observed.command.slice(0, 512) } : {}) } : terminal;
  }) : [];
  const agents = children.filter(task => task && ['childRunId', 'sessionId', 'parentRunId', 'role', 'phase'].every(key => typeof task[key] === 'string' && task[key])).map(task => ({ runId: task.childRunId, sessionId: task.sessionId, parentRunId: task.parentRunId,
    role: task.role, title: task.goalPreview, phase: task.phase,
    isRunning: task.canCancel === true, canCancel: false }));
  return { git, plan, terminals, agents, isRunning: admitted && (activity.isRunning === true
    || terminals.some(terminal => ['starting', 'running'].includes(terminal.state))) };
}
