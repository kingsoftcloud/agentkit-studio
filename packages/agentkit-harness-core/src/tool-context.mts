import type { Message, ToolContextMessage } from './contracts.mjs';
import { copy, invariant } from './values.mjs';

/** Ports can add observations, never system roles, execution permissions or call identities. */
export function toolContext(input: ToolContextMessage): ToolContextMessage {
  const value = copy(input);
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['content', 'media', 'presentation'].includes(key))
    && typeof value.content === 'string'
    && (value.media === undefined || Array.isArray(value.media)), 'invalid_tool_context');
  if (value.presentation !== undefined) {
    const view = value.presentation;
    invariant(view && typeof view === 'object' && !Array.isArray(view)
      && Object.keys(view).every(key => ['format', 'content', 'source'].includes(key))
      && typeof view.format === 'string' && view.format.trim() && Array.isArray(view.content)
      && (view.source === undefined || view.source !== null && typeof view.source === 'object' && !Array.isArray(view.source)),
    'invalid_tool_presentation');
  }
  return value;
}

export function deferredToolContexts(input: ToolContextMessage[] | undefined): Message[] {
  if (input === undefined) return [];
  invariant(Array.isArray(input), 'invalid_tool_context');
  return input.map(value => ({ ...toolContext(value), role: 'user', kind: 'tool_context' }));
}
