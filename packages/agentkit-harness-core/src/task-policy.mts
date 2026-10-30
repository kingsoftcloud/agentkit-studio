import type { BrowserInteractionObservation, Message, RunConfiguration, RunSnapshot, ToolDefinition, ToolResult } from './contracts.mjs';
import { outstandingChildCalls } from './child-budget.mjs';
import { workspaceChangeUnobserved } from './workspace-change.mjs';
import { deliveryScopeEnabled, webDelivery } from './deliverables.mjs';

// This table belongs to the host configuration, never to the Kernel or a model.
export function invalidatesBrowserObservation(result: ToolResult, config: RunConfiguration, snapshot?: RunSnapshot): boolean {
  const policy = config.workspaceObservationPolicy;
  if (deliveryScopeEnabled(config)) {
    const artifact = snapshot && webDelivery(snapshot);
    if (!artifact || !policy) return false;
    return workspaceChangeUnobserved(result) || (result.workspaceChangedPaths ?? []).some(path =>
      (artifact.root === '.' || path.startsWith(artifact.root + '/'))
      && policy.pathSuffixes.some(suffix => path.toLowerCase().endsWith(suffix)));
  }
  return !!policy && (workspaceChangeUnobserved(result) || (result.workspaceChangedPaths ?? []).some(path =>
    policy.pathSuffixes.some(suffix => path.toLowerCase().endsWith(suffix))));
}
export function browserObservationAvailable(config: RunConfiguration): boolean {
  return config.tools.some(tool => tool.observationRole === 'browser'
    && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name)));
}
function remainingCalls(snapshot: RunSnapshot, config: RunConfiguration): number {
  return config.limits.maxModelCalls === null ? Infinity
    : config.limits.maxModelCalls - snapshot.usage.modelCalls - snapshot.descendantUsage.modelCalls - outstandingChildCalls(snapshot, 'model');
}
export function webVerificationOnly(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  if (deliveryScopeEnabled(config) && !webDelivery(snapshot)) return false;
  if (!config.workspaceObservationPolicy || config.limits.maxModelCalls === null) return false;
  const reserve = config.limits.verificationReserveModelCalls ?? 0;
  const finalReserve = config.limits.finalizationReserveModelCalls, remaining = remainingCalls(snapshot, config);
  return reserve > 1 && finalReserve > 0 && snapshot.lastWebMutationToolCall != null
    && browserObservationAvailable(config) && remaining > 0 && remaining < reserve
    && (reserve < finalReserve + 4 || remaining <= finalReserve + 1) && remaining > finalReserve;
}
export function webObservationDue(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  if (deliveryScopeEnabled(config) && !webDelivery(snapshot)) return false;
  if (!config.workspaceObservationPolicy || snapshot.lastWebMutationToolCall == null
    || !browserObservationAvailable(config)) return false;
  const remaining = remainingCalls(snapshot, config), finalReserve = config.limits.finalizationReserveModelCalls;
  if (remaining <= finalReserve) return false;
  const attempts = [snapshot.lastBrowserAttemptToolCall, snapshot.lastBrowserObservation?.toolCall,
    snapshot.unresolvedInteractionObservation?.toolCall].filter((value): value is number => Number.isSafeInteger(value));
  const lastAttempt = Math.max(-1, ...attempts);
  if (lastAttempt >= snapshot.lastWebMutationToolCall) return false;
  const interval = config.limits.browserObservationIntervalToolCalls ?? 0;
  const reserve = config.limits.verificationReserveModelCalls ?? 0;
  return interval > 0 && snapshot.usage.toolCalls - Math.max(lastAttempt, 0) >= interval
    || Number.isFinite(remaining) && reserve >= finalReserve + 4 && remaining <= reserve;
}
/** Apply only to already bound host tools; caller retains contract-scope filtering. */
export function browserTaskTools(snapshot: RunSnapshot, config: RunConfiguration, tools: ToolDefinition[]): ToolDefinition[] {
  if (webObservationDue(snapshot, config)) return tools.filter(tool => tool.observationRole === 'browser');
  if (!webVerificationOnly(snapshot, config)) return tools;
  const fresh = snapshot.lastBrowserObservation != null
    && snapshot.lastBrowserObservation.toolCall >= (snapshot.lastWebMutationToolCall ?? 0)
    && !snapshot.unresolvedInteractionObservation;
  return tools.filter(tool => tool.observationRole === 'browser' || fresh && tool.readOnly);
}
/** Ephemeral host instructions are counted with, and added to, the same model view. */
export function browserTaskMessages(snapshot: RunSnapshot, config: RunConfiguration, messages: Message[]): Message[] {
  const limits = config.limits;
  if (limits.maxToolCalls !== null && snapshot.usage.toolCalls + snapshot.descendantUsage.toolCalls + outstandingChildCalls(snapshot, 'tool') >= limits.maxToolCalls
    || remainingCalls(snapshot, config) <= limits.finalizationReserveModelCalls) return messages;
  const content = webObservationDue(snapshot, config)
    ? 'OBSERVATION_DUE: The current web revision needs a browser observation before more workspace work. Only browser observation tools are available on this turn. Inspect the current page; the next turn can use the resulting evidence to repair any observed problem.'
    : webVerificationOnly(snapshot, config)
      ? 'VERIFICATION: The web delivery budget is in its verification window. Workspace-changing tools are unavailable. Inspect the current page with the available browser tool before claiming it works; report any remaining gap truthfully.' : null;
  return content ? [...messages, { role: 'system', kind: 'browser_task_policy', content }] : messages;
}
/** A later screenshot cannot hide an error from the user's original interaction. */
export function advanceInteractionObservation(previous: BrowserInteractionObservation | null, definition: ToolDefinition,
  toolCall: number, result: ToolResult, digest: (value: unknown) => string): BrowserInteractionObservation | null {
  if (definition.observationRole !== 'browser' || !result.content || typeof result.content !== 'object'
    || Array.isArray(result.content)) return previous;
  const content = result.content, entryPath = content.entry_path;
  if (typeof entryPath !== 'string' || !entryPath) return previous;
  let error: string | undefined;
  for (const key of ['page_errors', 'console_errors', 'request_failures']) {
    const group = content[key];
    if (Array.isArray(group)) error = group.find((item): item is string => typeof item === 'string' && item.length > 0);
    if (error) break;
  }
  if (result.status === 'error' && error) return { toolName: definition.name, entryPath, toolCall,
    error: Array.from(error).slice(0, 300).join(''), digest: digest({ entryPath, toolCall, content }) };
  const interactive = Array.isArray(content.actions) && content.actions.some(action => action !== null
    && typeof action === 'object' && !Array.isArray(action) && ['click', 'fill', 'press', 'reload'].includes(String(action.type)));
  return previous && result.status === 'ok' && content.ok === true && content.actions_ok === true && interactive
    && previous.toolName === definition.name && previous.entryPath === entryPath ? null : previous;
}
