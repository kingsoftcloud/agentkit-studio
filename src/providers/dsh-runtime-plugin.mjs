/**
 * Preset-scoped DSH runner bridge. A selected Studio revision keeps the DSH
 * loop, Session Controller and native composer, while this listener routes
 * the loop's model request into the Studio runtime provider.
 */

export const name = 'agentkit-studio-dsh-runtime';
export const inject = ['tools'];
import { streamDshRuntime } from '@kingsoftcloud/agentkit-studio/dsh-runtime';

function toolNames(values) {
  return (Array.isArray(values) ? values : []).map(value => {
    if (typeof value === 'string') return value;
    return value?.resourceId || value?.id || value?.name || '';
  }).filter(Boolean).map(String);
}

function createToolAdapter(ctx, bindings) {
  const allowed = new Set(toolNames(bindings));
  if (!allowed.size) return undefined;
  const schemas = () => (ctx.tools.schemas?.() || []).filter(schema => allowed.has(String(schema.name)));
  const resolve = name => {
    const candidate = String(name || '');
    const schema = schemas().find(item => item.name === candidate);
    if (!schema) throw Object.assign(new Error(`DSH Tool 未注册或不在当前 Agent 绑定范围内：${candidate}`), { code: 'TOOL_NOT_FOUND' });
    return schema;
  };
  return {
    listTools() {
      const available = new Set(schemas().map(schema => schema.name));
      const missing = [...allowed].filter(name => !available.has(name));
      if (missing.length) throw Object.assign(new Error(`DSH Tool 未注册或不在当前 Agent 绑定范围内：${missing.join(', ')}`), { code: 'TOOL_NOT_FOUND', details: { names: missing } });
      return schemas().map(schema => ({ name: schema.name, description: schema.description, parameters: schema.parameters, resourceId: schema.name }));
    },
    async callTool(name, args = {}, { callId, signal } = {}) {
      const schema = resolve(name);
      const result = await ctx.tools.execute({
        callId: String(callId || `studio-tool-${Date.now().toString(36)}`),
        name: schema.name,
        arguments: args,
        signal: signal || new AbortController().signal,
      });
      if (result?.isError) {
        const error = new Error(`DSH Tool ${schema.name} 执行失败`);
        error.code = result.error?.code || 'DSH_TOOL_FAILED';
        error.details = { name: schema.name };
        throw error;
      }
      return result?.content ?? result?.value ?? result;
    },
  };
}

export function apply(ctx, config = {}) {
  const agentId = String(config.agentId || '').trim();
  if (!agentId) throw new Error('agentkit-studio-dsh-runtime: agentId is required');
  const toolAdapter = createToolAdapter(ctx, config.toolBindings);
  // Keep the DSH request header on the user's selected provider/model. The
  // scoped waterfall owns only this Agent's model transport, which avoids
  // showing an internal `agentkit-studio/local:*` model in the native UI.
  ctx.on('llm/stream', options => streamDshRuntime(options, {
    agentId,
    runtime: config.runtime,
    local: config.local === true,
    buildId: config.buildId || '',
    toolAdapter,
  }));
}

export default { name, inject, apply };
