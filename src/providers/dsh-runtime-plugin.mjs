/**
 * Preset-scoped DSH runner bridge. A selected Studio revision keeps the DSH
 * loop, Session Controller and native composer, while this listener routes
 * the loop's model request into the Studio runtime provider.
 */

export const name = 'agentkit-studio-dsh-runtime';
export const inject = [];
import { streamDshRuntime } from '@kingsoftcloud/agentkit-studio/dsh-runtime';

export function apply(ctx, config = {}) {
  const agentId = String(config.agentId || '').trim();
  if (!agentId) throw new Error('agentkit-studio-dsh-runtime: agentId is required');
  // Keep the DSH request header on the user's selected provider/model. The
  // scoped waterfall owns only this Agent's model transport, which avoids
  // showing an internal `agentkit-studio/local:*` model in the native UI.
  ctx.on('llm/stream', options => streamDshRuntime(options, {
    agentId,
    runtime: config.runtime,
    local: config.local === true,
  }));
}

export default { name, inject, apply };
