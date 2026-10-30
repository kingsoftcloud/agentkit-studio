import type { Message, RunConfiguration, ToolContextMessage, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

/** Normalize only the model observation. Never rewrite the program receipt or infer content from UI metadata. */
export function projectToolResultContext(result: ToolResult, config: RunConfiguration): ToolContextMessage {
  if (result.context !== undefined) return toolContext(result.context);
  return { content: config.modelSurface && typeof result.content === 'string' ? result.content : canonical(result.content) };
}

/** Program receipts, model observations and display metadata have separate budgets. */
export function modelObservationBytes(result: ToolResult, config: RunConfiguration): number {
  const media = result.context?.media ?? [], additional = result.additionalContexts ?? [];
  const encoded = (value: unknown) => new TextEncoder().encode(canonical(value)).length;
  const split = config.modelSurface?.contract === 'bound-model-surface/v1';
  if (split && [...media, ...additional.flatMap(item => item.media ?? [])].reduce<number>((sum, item) => sum + encoded(item), 0)
    > config.limits.maxInlineImageBytes)
    return Number.MAX_SAFE_INTEGER;
  return encoded({ content: projectToolResultContext(result, config).content, media: split ? [] : media,
    additionalContexts: split ? additional.map(({ content }) => ({ content })) : additional });
}

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
