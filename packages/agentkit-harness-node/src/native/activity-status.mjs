import { createHash } from 'node:crypto';

/** Content and lifecycle facts from committed task state; no control authority. */
export function nativeActivityStatus(record, { driving = false } = {}) {
  if (!record) return null;
  const { snapshot } = record;
  const todos = snapshot.todos?.items ?? [], occurrences = new Map();
  const items = todos.slice(0, 512).map(todo => {
    const digest = createHash('sha256').update(todo.content).digest('hex');
    const occurrence = occurrences.get(digest) ?? 0; occurrences.set(digest, occurrence + 1);
    return { id: `todo:${digest}:${occurrence}`, content: todo.content, status: todo.status };
  });
  const observations = new Map();
  for (const event of record.events ?? []) if (event.kind === 'background.commands_observed')
    for (const command of event.payload.commands ?? []) observations.set(command.taskId, command);
  const terminals = (snapshot.backgroundCommands ?? []).slice(-128).map(({ ref }) => {
    const observed = observations.get(ref.taskId);
    const intent = record.intents.find(row => row.operationKey === ref.operationKey);
    const calls = intent?.payload.calls ?? [];
    const call = calls.length === 1 ? calls[0] : null;
    return { id: ref.taskId, runId: snapshot.runId,
      title: call?.arguments.command?.slice(0, 512) || ref.taskId,
      state: observed?.status ?? 'unknown', canCancel: false };
  });
  return { contract: 'agentkit.native-activity-status/v1', runId: snapshot.runId, snapshotRevision: snapshot.revision,
    isRunning: driving, plan: todos.length ? { items,
      completedCount: todos.filter(todo => todo.status === 'completed').length, totalCount: todos.length,
      omittedItems: Math.max(0, todos.length - items.length) } : null,
    terminals, omittedTerminals: Math.max(0, (snapshot.backgroundCommands ?? []).length - terminals.length) };
}
