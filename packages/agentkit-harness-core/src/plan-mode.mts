import type { ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { toolInputRejection } from './tool-input.mjs';
import { isTodoCall } from './todos.mjs';
import { isCoordinatorResponse } from './coordinator-response.mjs';

export const PLAN_MODE_POLICY = 'session-plan/v1';
export const CHILD_PLAN_MODE_POLICY = 'inherited-child-plan/v1';
export const CHILD_PLAN_POLICY = 'inherit-plan/v1';
export const ENTER_PLAN_MODE = 'EnterPlanMode';
export const EXIT_PLAN_MODE = 'ExitPlanMode';

export function planModeToolDefinitions(deferred = false): ToolDefinition[] {
  const base = { readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1000,
    contextRole: 'task_planning' as const, observationRole: 'none' as const,
    progressObservation: false, contextRetention: 'normal' as const };
  return [{ ...base, name: ENTER_PLAN_MODE,
    description: 'Enter planning mode to explore the codebase and design a multi-step implementation before coding. Workspace mutations are forbidden until the user approves leaving plan mode. Use read/search tools and session Todo controls to track the plan.',
    ...(deferred ? { discovery: { deferred: true as const, searchHint: 'enter planning mode design an approach before coding' } } : {}),
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { ...base, name: EXIT_PLAN_MODE,
    description: 'Present the complete implementation plan for user review and request approval to leave plan mode. Use only while planning. Approval applies to this exact plan; normal tool permissions still apply afterward. A rejected plan must be revised before presenting it again.',
    ...(deferred ? { discovery: { deferred: true as const, aliases: ['exit_plan_mode'], searchHint: 'approve plan leave planning start implementation' } } : {}),
    parameters: { type: 'object', required: ['plan'], properties: {
      plan: { type: 'string', minLength: 1, maxLength: 20000, pattern: '\\S' },
      allowedPrompts: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['tool', 'prompt'], properties: { tool: { enum: ['Bash'] }, prompt: { type: 'string' } } } } } } }];
}

export function isPlanModeCall(config: RunConfiguration, call: Pick<ToolCall, 'name'>): boolean {
  return config.planModePolicy === PLAN_MODE_POLICY && [ENTER_PLAN_MODE, EXIT_PLAN_MODE].includes(call.name);
}

export function validatePlanModeConfiguration(config: RunConfiguration): void {
  invariant(config.planModePolicy === undefined || [PLAN_MODE_POLICY, CHILD_PLAN_MODE_POLICY].includes(config.planModePolicy), 'invalid_plan_mode_policy');
  invariant(config.childPlanPolicy === undefined || config.childPlanPolicy === CHILD_PLAN_POLICY
    && config.planModePolicy === PLAN_MODE_POLICY && config.childLifecyclePolicy === 'owned-background/v2', 'invalid_child_plan_policy');
  invariant(config.planModePolicy ? typeof config.planModeInitialActive === 'boolean'
    : config.planModeInitialActive === undefined, 'invalid_plan_mode_initial_state');
  if (config.planModePolicy === CHILD_PLAN_MODE_POLICY) {
    invariant(config.childOwnerBinding && config.childOwnerBinding.planMode === config.planModeInitialActive
      && !config.tools.some(tool => [ENTER_PLAN_MODE, EXIT_PLAN_MODE].includes(tool.name)), 'invalid_child_plan_binding');
    return;
  }
  invariant(config.childOwnerBinding?.planMode === undefined, 'invalid_child_plan_binding');
  if (!config.planModePolicy) return;
  for (const definition of planModeToolDefinitions(!!config.toolDiscoveryPolicy))
    invariant(config.tools.some(tool => canonical(tool) === canonical(definition)), 'plan_mode_tool_binding_invalid');
}

export function planModeDenial(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, definition: ToolDefinition): ToolResult | null {
  if (!activePlanMode(snapshot, config) || isPlanModeCall(config, call) || isPlanChildCall(config, call, definition)
    || isTodoCall(config, call) || isCoordinatorResponse(config, call) || definition.readOnly || definition.planModeCommandPolicy === 'zcode-posix-readonly/v1'
    || definition.planModeAccess?.contract === 'zcode-mcp-plan/v1' && !definition.planModeAccess.destructive) return null;
  return planModeWriteDenial(config);
}

export function activePlanMode(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  return !!snapshot.planMode?.active && [PLAN_MODE_POLICY, CHILD_PLAN_MODE_POLICY].includes(config.planModePolicy!);
}

export function isPlanChildCall(config: RunConfiguration, call: ToolCall, definition: ToolDefinition): boolean {
  return config.childPlanPolicy === CHILD_PLAN_POLICY && (['start/v1', 'delegate/v1'].includes(definition.childBudgetPolicy ?? '')
    || definition.childBudgetPolicy === 'settle/v1' && call.arguments.action === 'wait');
}

export function planModeWriteDenial(config?: RunConfiguration): ToolResult {
  return { status: 'error', content: { code: 'plan_mode_write_denied', executed: false,
    message: config?.planModePolicy === CHILD_PLAN_MODE_POLICY
      ? 'This child inherited Plan mode. Read-only exploration, non-destructive MCP tools and session planning controls are allowed. Report implementation proposals to the coordinator; only a new admitted child Run can change this mode.'
      : 'Planning mode allows read-only exploration, non-destructive MCP tools and session planning controls. Present the plan with ExitPlanMode and obtain user approval before implementation.' } };
}

export function planReviewInteractionId(call: ToolCall): string { return `native-plan-review:${call.callId}`; }

/** No UI or workspace effects: approval is requested only after this result is durable. */
export function executePlanMode(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, interaction: ObjectValue | null): ToolResult {
  invariant(isPlanModeCall(config, call) && snapshot.planMode, 'plan_mode_state_unavailable');
  const rejection = toolInputRejection(config.tools.find(tool => tool.name === call.name)!, call);
  if (rejection) return { status: 'error', content: rejection };
  // Zod's reference max() measures JS UTF-16 length; JSON Schema maxLength
  // counts Unicode code points. Enforce the actual source contract as well.
  if (call.name === EXIT_PLAN_MODE && (String(call.arguments.plan).length > 20000 || !String(call.arguments.plan).trim()))
    return { status: 'error', content: { code: 'invalid_arguments', executed: false, message: 'Plan must be nonblank and at most 20000 UTF-16 code units.' } };
  const previous = snapshot.planMode.active;
  if (call.name === ENTER_PLAN_MODE) return { status: 'ok', content: { mode: 'plan', previousMode: previous ? 'plan' : 'build',
    planEnabled: true, previousPlanEnabled: previous, message: 'Entered plan mode. Explore the codebase and design the implementation before requesting approval.' } };
  if (!previous) return { status: 'error', content: { code: 'plan_mode_not_active', executed: false } };
  const interactionId = planReviewInteractionId(call);
  if (!interaction || interaction.interactionId !== interactionId || interaction.callId !== call.callId)
    return { status: 'approval_required', interactionId, content: { plan: call.arguments.plan!,
      message: 'Review the complete plan before leaving planning mode.' } };
  if (interaction.decision !== 'allow') return { status: 'error', content: { code: 'plan_review_rejected', executed: false,
    feedback: typeof interaction.feedback === 'string' ? interaction.feedback : '', message: 'Keep planning; revise the plan using the user feedback.' } };
  return { status: 'ok', content: { approved: true, plan: call.arguments.plan!,
    ...(call.arguments.allowedPrompts === undefined ? {} : { allowedPrompts: copy(call.arguments.allowedPrompts) }),
    mode: 'build', previousMode: 'plan', planEnabled: false, previousPlanEnabled: true } };
}

export function reducePlanMode(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall, result: ToolResult): RunSnapshot['planMode'] | undefined {
  if (!isPlanModeCall(config, call) || result.status !== 'ok') return undefined;
  invariant(snapshot.planMode && result.content && typeof result.content === 'object' && !Array.isArray(result.content), 'invalid_plan_mode_receipt');
  const active = call.name === ENTER_PLAN_MODE;
  invariant(result.content.planEnabled === active, 'invalid_plan_mode_receipt');
  if (active === snapshot.planMode.active) return undefined;
  if (!active) invariant(result.content.approved === true && result.content.plan === call.arguments.plan, 'invalid_plan_mode_receipt');
  return { ...copy(snapshot.planMode), active, revision: snapshot.planMode.revision + 1,
    ...(!active ? { approvedPlan: { plan: String(call.arguments.plan),
      ...(call.arguments.allowedPrompts === undefined ? {} : { allowedPrompts: copy(call.arguments.allowedPrompts) }) } } : {}) };
}

export function planModeFact(snapshot: RunSnapshot, messageCursor: number): ObjectValue {
  invariant(snapshot.planMode, 'plan_mode_state_unavailable');
  return { active: snapshot.planMode.active, revision: snapshot.planMode.revision, messageCursor };
}

export function planModeGuidance(snapshot: RunSnapshot, config?: RunConfiguration): string {
  // Children deliberately have no independent Plan transition/review tools.
  // Keep the restriction useful without instructing them to call an absent tool.
  if (config?.planModePolicy === CHILD_PLAN_MODE_POLICY) return snapshot.planMode?.active
    ? 'This child inherited active Plan mode from its coordinator. Explore and report findings with read/search tools, session Todo controls and RespondToCoordinator. Workspace writes and destructive tools are forbidden. You cannot enter or exit Plan mode or request independent plan approval. Report a proposed implementation to the coordinator and continue the assigned exploration; only a new admitted child Run can change this inherited mode.'
    : 'This child inherited inactive Plan mode. Continue its assigned task under the admitted tools, permissions and budget. Plan transition tools are unavailable in child sessions.';
  return snapshot.planMode?.active
    ? 'Plan mode is active. Explore with read/search tools, clarify requirements, and prepare a concrete implementation plan. Do not modify the workspace or start mutating commands/children. Local commands with the admitted read-only command policy are checked against their syntax, options and runtime directory before execution. Session Todo updates and MCP tools admitted as non-destructive by the frozen tool catalog are allowed, subject to normal tool permissions. '
      + (config?.childPlanPolicy === CHILD_PLAN_POLICY ? 'An admitted Native child owner may launch children with inherited Plan restrictions or wait for owned results; sending instructions and stopping tasks remain subject to the normal Plan restrictions. ' : '')
      + 'Use ExitPlanMode to present the full plan for user approval before implementation.'
    : 'Plan mode is inactive. Continue the user task subject to the existing tool permissions and execution budget. An approved plan is progress context, not a blanket permission grant.';
}
