import type { ObjectValue, RunConfiguration, RunSnapshot, TodoItem, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { toolInputRejection } from './tool-input.mjs';

export const TODO_POLICY = 'session-todos/v1';
export const TODO_READ = 'TodoRead';
export const TODO_WRITE = 'TodoWrite';

/** Modified Apache-2.0 code; attribution and license: THIRD_PARTY_NOTICES.md.
 * Pure staging controls. TodoWrite's only mutation happens in the receipt commit. */
export function todoToolDefinitions(deferred = false): ToolDefinition[] {
  const base = { permissions: [], timeoutMs: 1000, contextRole: 'task_planning' as const,
    observationRole: 'none' as const, progressObservation: false, contextRetention: 'normal' as const };
  return [{ ...base, name: TODO_READ, description: 'Read the authoritative task list for this session.',
    readOnly: true, concurrentSafe: true,
    ...(deferred ? { discovery: { deferred: true as const, searchHint: 'read session task checklist' } } : {}),
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { ...base, name: TODO_WRITE,
    description: 'Replace the complete session task list to track multi-step work and show progress. Each item requires content, status (pending/in_progress/completed), and priority (high/medium/low). Prefer one in_progress item unless tasks run in parallel. Mark completed work promptly. Skip task tracking for trivial work.',
    readOnly: false, concurrentSafe: false,
    ...(deferred ? { discovery: { deferred: true as const, aliases: ['todo_write'], searchHint: 'manage session task checklist progress' } } : {}),
    parameters: { type: 'object', additionalProperties: false, required: ['todos'], properties: {
      todos: { type: 'array', items: { type: 'object', required: ['content', 'status', 'priority'], properties: {
        content: { type: 'string', minLength: 1 }, status: { enum: ['pending', 'in_progress', 'completed'] },
        priority: { enum: ['high', 'medium', 'low'] } } } } } } }];
}

export function isTodoCall(config: RunConfiguration, call: Pick<ToolCall, 'name'>): boolean {
  return config.todoPolicy === TODO_POLICY && [TODO_READ, TODO_WRITE].includes(call.name);
}

export function validateTodoConfiguration(config: RunConfiguration): void {
  invariant(config.todoPolicy === undefined || config.todoPolicy === TODO_POLICY, 'invalid_todo_policy');
  if (!config.todoPolicy) return;
  for (const definition of todoToolDefinitions(config.toolDiscoveryPolicy !== undefined))
    invariant(config.tools.some(tool => canonical(tool) === canonical(definition)), 'todo_tool_binding_invalid');
}

export function todoItems(value: unknown): TodoItem[] {
  invariant(Array.isArray(value) && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.content === 'string' && item.content.length > 0 && ['pending', 'in_progress', 'completed'].includes(item.status)
    && ['high', 'medium', 'low'].includes(item.priority)), 'invalid_todo_items');
  // Strip extra keys, preserve content, and allow parallel active items.
  return value.map(({ content, status, priority }) => ({ content, status, priority }));
}

export function executeTodo(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall): ToolResult {
  invariant(isTodoCall(config, call) && snapshot.todos, 'todo_state_unavailable');
  const definition = config.tools.find(tool => tool.name === call.name)!;
  const rejection = toolInputRejection(definition, call);
  if (rejection) return { status: 'error', content: rejection };
  if (call.name === TODO_READ) return { status: 'ok', content: { todos: copy(snapshot.todos.items) } };
  const todos = todoItems(call.arguments.todos);
  return { status: 'ok', content: { oldTodos: copy(snapshot.todos.items), todos,
    summary: { total: todos.length, pending: todos.filter(todo => todo.status === 'pending').length,
      inProgress: todos.filter(todo => todo.status === 'in_progress').length, completed: todos.filter(todo => todo.status === 'completed').length } } };
}

export function reduceTodo(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult): RunSnapshot['todos'] | undefined {
  if (!isTodoCall(config, call) || call.name !== TODO_WRITE || result.status !== 'ok') return undefined;
  invariant(snapshot.todos && result.content && typeof result.content === 'object' && !Array.isArray(result.content), 'invalid_todo_receipt');
  const items = todoItems(result.content.todos);
  invariant(canonical(items) === canonical(todoItems(call.arguments.todos))
    && canonical(result.content.oldTodos) === canonical(snapshot.todos.items), 'invalid_todo_receipt');
  return { ...copy(snapshot.todos), items, revision: snapshot.todos.revision + 1,
    lastWriteAssistantTurn: snapshot.todos.assistantTurns };
}

/** Reference cadence: ten assistant requests since both write and previous reminder. */
export function todoReminder(snapshot: RunSnapshot, config: RunConfiguration): Partial<RunSnapshot> | null {
  const state = snapshot.todos;
  if (!state || config.todoPolicy !== TODO_POLICY || state.assistantTurns - state.lastWriteAssistantTurn < 10
    || state.assistantTurns - state.lastReminderAssistantTurn < 10
    || snapshot.messages.at(-1)?.kind === 'continuation_observation') return null;
  return { todos: { ...copy(state), lastReminderAssistantTurn: state.assistantTurns }, preparedContext: null,
    context: { ...snapshot.context, preparedCursor: null }, messages: [...snapshot.messages, {
      role: 'user', kind: 'todo_reminder', content: canonical({ authority: 'session_task_state', todos: state.items,
        reminder: 'TodoWrite has not been used recently. Consider updating stale task progress when useful; ignore this reminder for trivial work.' }) }] };
}

export function todoUpdateFact(snapshot: RunSnapshot, messageCursor: number): ObjectValue {
  invariant(snapshot.todos, 'todo_state_unavailable');
  return { todos: copy(snapshot.todos.items) as unknown as ObjectValue['todos'], revision: snapshot.todos.revision, messageCursor };
}
