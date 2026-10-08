/** Bidirectional tool names/types for the Codex Responses -> Chat boundary. */
import { createHash } from 'node:crypto';

const fail = message => Object.assign(new Error(message), { code: 'CODEX_TOOL_CONVERSION_FAILED' });
const identity = tool => [tool.type, tool.namespace || '', tool.name || ''];
const alias = tool => `studio_${createHash('sha256').update(JSON.stringify(identity(tool))).digest('hex').slice(0, 32)}`;

export function prepareCodexProxyRequest(input) {
  const request = structuredClone(input), specs = new Map(), tools = [];
  const register = tool => { const name = alias(tool); specs.set(name, tool); return name; };
  const add = (tool, namespace) => {
    if (tool.type === 'namespace') {
      for (const child of tool.tools || tool.children || []) add(child, tool.name);
    } else if (tool.type === 'function' || tool.type === 'custom') {
      const spec = { ...tool, ...(namespace ? { namespace } : {}) };
      const name = register(spec);
      const description = `Tool: ${[spec.namespace, spec.name].filter(Boolean).join('.')}\n${tool.description || ''}`;
      tools.push(tool.type === 'custom' ? { type: 'function', name,
        description: `${description}\nPass the original tool input verbatim in the input string. ${tool.format ? JSON.stringify(tool.format) : ''}`,
        parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
      } : { ...tool, name, description });
    } else if (tool.type === 'tool_search') {
      const name = register({ type: 'tool_search', name: 'tool_search' });
      tools.push({ type: 'function', name, description: 'Find available tools and load their definitions.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } });
    } else tools.push(tool); // The shared converter explicitly rejects unsupported server tools.
  };
  for (const tool of request.tools || []) add(tool);
  request.tools = tools;
  if (Array.isArray(request.input)) request.input = request.input.map(item => {
    if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item.type)) {
      const spec = { type: item.type === 'custom_tool_call' ? 'custom' : item.type === 'tool_search_call' ? 'tool_search' : 'function', name: item.type === 'tool_search_call' ? 'tool_search' : item.name, namespace: item.namespace };
      return { ...item, type: 'function_call', name: register(spec), arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) };
    }
    if (item.type === 'tool_search_output') return { ...item, type: 'function_call_output', output: JSON.stringify(item.tools || item.output || []) };
    return item;
  });
  if (request.tool_choice?.name) {
    const type = request.tool_choice.type === 'custom' ? 'custom' : 'function';
    request.tool_choice = { type: 'function', name: alias({ ...request.tool_choice, type }) };
  }
  return {
    request,
    has: name => specs.has(name),
    isCustom: name => specs.get(name)?.type === 'custom',
    restore(item, partial = false) {
      if (item.type !== 'function_call') return item;
      const spec = specs.get(item.name);
      if (!spec) throw fail('模型返回了未声明的工具，无法还原 Codex 工具调用。');
      if (spec.type === 'custom') {
        let input = '';
        if (!partial) {
          try { input = JSON.parse(item.arguments).input; } catch { throw fail('模型返回的自定义工具参数不是有效 JSON。'); }
          if (typeof input !== 'string') throw fail('模型返回的自定义工具 input 必须是字符串。');
        }
        const { arguments: _args, ...rest } = item;
        return { ...rest, type: 'custom_tool_call', name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), input };
      }
      if (spec.type === 'tool_search') {
        const { name: _name, ...rest } = item;
        return { ...rest, type: 'tool_search_call', execution: 'client', arguments: partial ? {} : JSON.parse(item.arguments || '{}') };
      }
      return { ...item, name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}) };
    },
  };
}
