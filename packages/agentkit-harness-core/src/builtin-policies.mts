import * as todo from './todos.mjs';
import * as planning from './plan-mode.mjs';
import * as review from './delivery-review.mjs';
import * as providerContext from './anthropic-context.mjs';
import type { ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolResult } from './contracts.mjs';

/** Closed strategy slots. Modules cannot add execution primitives through these slots. */
export const builtinStrategies = Object.freeze({
  todo: Object.freeze({ ...todo }), planning: Object.freeze({ ...planning }),
  review: Object.freeze({ ...review }), providerContext: Object.freeze({ ...providerContext }),
});
export type BuiltinStrategies = typeof builtinStrategies;
export interface InternalToolPolicy {
  matches(config: RunConfiguration, call: ToolCall): boolean;
  execute(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, interaction: ObjectValue | null): ToolResult;
  reduce(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult):
    Pick<Partial<RunSnapshot>, 'todos' | 'planMode'>;
}
/** Only the immutable built-in registrations carry this capability. */
export const builtinCapability: unique symbol = Symbol('native.builtin-strategy');
export const builtinPolicyModules = Object.freeze([
  Object.freeze({ id: 'native.todos', version: '1', implementation: 'session-todos/v1',
    [builtinCapability]: Object.freeze({ slot: 'todo' as const, strategy: builtinStrategies.todo,
      tool: Object.freeze({ matches: todo.isTodoCall, execute: todo.executeTodo,
        reduce(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult) {
          const todos = todo.reduceTodo(snapshot, config, call, result); return todos ? { todos } : {};
        } }) as InternalToolPolicy }) }),
  Object.freeze({ id: 'native.planning', version: '1', implementation: 'session-plan/v1',
    [builtinCapability]: Object.freeze({ slot: 'planning' as const, strategy: builtinStrategies.planning,
      tool: Object.freeze({ matches: planning.isPlanModeCall, execute: planning.executePlanMode,
        reduce(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult) {
          const planMode = planning.reducePlanMode(snapshot, config, call, result); return planMode ? { planMode } : {};
        } }) as InternalToolPolicy }) }),
  Object.freeze({ id: 'native.delivery-review', version: '1', implementation: 'delivery-review/v1',
    [builtinCapability]: Object.freeze({ slot: 'review' as const, strategy: builtinStrategies.review }) }),
  Object.freeze({ id: 'native.provider-context', version: '1', implementation: 'provider-context/v1',
    [builtinCapability]: Object.freeze({ slot: 'providerContext' as const, strategy: builtinStrategies.providerContext }) }),
]);
export const BUILTIN_POLICY_BINDINGS = Object.freeze(builtinPolicyModules.map(({ id, version, implementation }) =>
  Object.freeze({ id, version, implementation })));

/** Disabled slots expose neutral predicates; they cannot trigger policy work. */
export const inactiveStrategies: BuiltinStrategies = Object.freeze({
  todo: Object.freeze({ ...builtinStrategies.todo, isTodoCall: () => false,
    reduceTodo: () => undefined, todoReminder: () => null }),
  planning: Object.freeze({ ...builtinStrategies.planning, isPlanModeCall: () => false,
    activePlanMode: () => false, isPlanChildCall: () => false, planModeDenial: () => null,
    reducePlanMode: () => undefined, planModeGuidance: () => '' }),
  review: Object.freeze({ ...builtinStrategies.review, reviewPending: () => false,
    scheduleDeliveryReview: () => null, deliveryReviewReaders: () => [], deliveryReviewTools: () => [] }),
  providerContext: builtinStrategies.providerContext,
});
