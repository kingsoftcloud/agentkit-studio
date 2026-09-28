/**
 * Kspmas/OpenAI compatibility transforms used by the Studio provider.
 *
 * This module is deliberately transport agnostic: it does not read a key,
 * start a server, or perform a fetch.  The Host owns credentials and network
 * policy; these functions only normalize Responses and Chat Completions
 * payloads.  Keeping the transform here lets the browser, local provider and
 * cloud worker share one contract without importing the Python SDK.
 */

export class UnsupportedToolsError extends Error {
  constructor(types) {
    super(`不支持转换的工具类型: ${types.join(', ')}`);
    this.name = 'UnsupportedToolsError';
    this.code = 'UNSUPPORTED_TOOL_TYPE';
    this.types = types;
  }
}

const passthrough = [
  'temperature', 'top_p', 'top_logprobs', 'logprobs', 'stop', 'seed',
  'frequency_penalty', 'presence_penalty', 'logit_bias', 'response_format',
  'user', 'metadata', 'n', 'service_tier', 'prompt_cache_key',
];

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const json = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 0);

/** Preserve text and image inputs instead of silently dropping multimodal parts. */
export function contentToChat(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : json(content);
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = part.type;
    if (type === 'input_text' || type === 'text' || type === 'output_text') {
      if (part.text != null) parts.push({ type: 'text', text: String(part.text) });
      continue;
    }
    if (type === 'input_image' || type === 'image_url' || type === 'image') {
      const raw = part.image_url ?? part.image ?? part.url;
      const url = typeof raw === 'string' ? raw : raw?.url;
      if (url) parts.push({ type: 'image_url', image_url: { url, ...((part.detail || raw?.detail) ? { detail: part.detail || raw.detail } : {}) } });
      continue;
    }
    if (part.text != null) parts.push({ type: 'text', text: String(part.text) });
  }
  return parts.length ? parts : '';
}

function chatRole(role) {
  if (role === 'system' || role === 'developer') return 'system';
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'user';
}

function collapseSystem(messages) {
  const system = messages.filter(item => item.role === 'system' && typeof item.content === 'string' && item.content.trim());
  const rest = messages.filter(item => item.role !== 'system' || typeof item.content !== 'string' || !item.content.trim());
  return system.length ? [{ role: 'system', content: system.map(item => item.content).join('\n\n') }, ...rest] : rest;
}

export function inputToMessages(input) {
  if (input == null) return [];
  const items = Array.isArray(input) ? input : [typeof input === 'string' ? { type: 'message', role: 'user', content: input } : input];
  const messages = [];
  const calls = [];
  const flush = () => {
    if (calls.length) messages.push({ role: 'assistant', content: null, tool_calls: calls.splice(0) });
  };
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type;
    if (!type || type === 'message') {
      flush();
      messages.push({ role: chatRole(item.role || 'user'), content: contentToChat(item.content) });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      calls.push({
        id: item.call_id || `call_${calls.length}`,
        type: 'function',
        function: { name: item.name, arguments: type === 'custom_tool_call' ? json({ input: item.input || '' }) : (item.arguments || '') },
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flush();
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: json(item.output) });
    }
  }
  flush();
  return messages;
}

function convertTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type === 'function') {
    const fn = { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } };
    if ('strict' in tool) fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }
  if (tool.type === 'custom' && tool.name) return {
    type: 'function',
    function: { name: tool.name, description: tool.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } },
  };
  return null;
}

export function convertToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice;
  if (choice.type === 'function') return { type: 'function', function: { name: choice.name || choice.function?.name } };
  return choice;
}

function convertResponseFormat(format) {
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_schema') return { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, ...(format.strict === undefined ? {} : { strict: format.strict }) } };
  if (format.type === 'json_object' || format.type === 'text') return { type: format.type };
  return null;
}

/** Responses request -> Kspmas Chat Completions request. */
export function responsesToChat(request) {
  const body = structuredClone(asObject(request));
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: contentToChat(body.instructions) });
  messages.push(...inputToMessages(body.input));
  const out = { model: body.model, messages: collapseSystem(messages) };
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  for (const key of passthrough) if (body[key] !== undefined) out[key] = body[key];
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (body.text?.format) {
    const format = convertResponseFormat(body.text.format);
    if (format) out.response_format = format;
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(convertTool);
  const unsupported = (Array.isArray(body.tools) ? body.tools : []).filter((tool, index) => !tools[index]).map(tool => tool?.type || tool?.name || 'unknown');
  if (unsupported.length) throw new UnsupportedToolsError(unsupported);
  if (tools.length) {
    out.tools = tools;
    if (body.tool_choice !== undefined) out.tool_choice = convertToolChoice(body.tool_choice);
    if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.stream !== undefined) out.stream = body.stream;
  return out;
}

function responseContent(content) {
  if (typeof content === 'string') return [{ type: 'output_text', text: content, annotations: [] }];
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    if (part?.type === 'text' || part?.type === 'output_text') return [{ type: 'output_text', text: String(part.text || ''), annotations: part.annotations || [] }];
    if (part?.type === 'image_url' || part?.type === 'image') return [{ type: 'output_image', image_url: part.image_url || part.image || part.url }];
    return [];
  });
}

function usageToResponse(usage = {}) {
  const completion = usage.completion_tokens_details || {};
  const prompt = usage.prompt_tokens_details || {};
  return {
    input_tokens: usage.prompt_tokens || 0,
    input_tokens_details: { cached_tokens: prompt.cached_tokens || 0 },
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    output_tokens_details: { reasoning_tokens: completion.reasoning_tokens || 0 },
  };
}

/** Chat Completions response -> Responses response. */
export function chatToResponses(chat, { id = chat?.id || `resp_${Date.now()}`, toolNameMap = {} } = {}) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (message.reasoning_content) output.push({ id: `rs_${id}`, type: 'reasoning', summary: [{ type: 'summary_text', text: message.reasoning_content }] });
  const content = responseContent(message.content);
  if (content.length) output.push({ id: `${id}_msg`, type: 'message', status: 'completed', role: 'assistant', content });
  for (const [index, call] of (message.tool_calls || []).entries()) {
    const fn = call.function || {};
    const name = toolNameMap[fn.name] || fn.name;
    output.push({ id: `fc_${call.id || index}`, type: 'function_call', status: 'completed', call_id: call.id || `call_${index}`, name, arguments: fn.arguments || '' });
  }
  const incomplete = choice.finish_reason === 'length' ? 'max_output_tokens' : choice.finish_reason === 'content_filter' ? 'content_filter' : null;
  const result = { id, object: 'response', created_at: chat?.created || Math.floor(Date.now() / 1000), status: incomplete ? 'incomplete' : 'completed', model: chat?.model, output, usage: usageToResponse(chat?.usage) };
  if (incomplete) result.incomplete_details = { reason: incomplete };
  return result;
}

/**
 * Convert one Chat Completions SSE data object to Responses SSE events.
 * The state is intentionally small and keyed by tool-call index, so parallel
 * tool calls cannot truncate each other when Kspmas interleaves their chunks.
 */
export function createResponsesStreamTransformer({ id, model } = {}) {
  const responseId = id || `resp_${Date.now()}`;
  const state = { text: '', reasoning: '', tools: new Map(), items: [], started: false, finished: false, model: model || '', finishReason: null, usage: undefined };
  let sequence = 0;
  const created = Math.floor(Date.now() / 1000);
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`;
  const response = status => ({ id: responseId, object: 'response', created_at: created, status, model: state.model, output: [], usage: null });
  const start = () => {
    if (state.started) return '';
    state.started = true;
    return event('response.created', { response: response('in_progress') }) + event('response.in_progress', { response: response('in_progress') });
  };
  const open = item => {
    const entry = { item, index: state.items.length };
    state.items.push(entry);
    return entry;
  };
  let reasoning, message;
  const handle = chunk => {
    if (state.finished) return '';
    if (chunk?.error) throw Object.assign(new Error('模型流返回错误'), { code: 'UPSTREAM_STREAM_ERROR' });
    let wire = start();
    if (chunk.usage) state.usage = chunk.usage;
    const choice = chunk?.choices?.[0] || {};
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.reasoning_content || delta.reasoning) {
      if (!reasoning) {
        reasoning = open({ id: `rs_${responseId}`, type: 'reasoning', summary: [], status: 'in_progress' });
        wire += event('response.output_item.added', { output_index: reasoning.index, item: reasoning.item });
        wire += event('response.reasoning_summary_part.added', { item_id: reasoning.item.id, output_index: reasoning.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      const text = String(delta.reasoning_content || delta.reasoning);
      state.reasoning += text;
      wire += event('response.reasoning_summary_text.delta', { item_id: reasoning.item.id, output_index: reasoning.index, summary_index: 0, delta: text });
    }
    if (delta.content) {
      const content = typeof delta.content === 'string' ? delta.content : contentToChat(delta.content);
      const text = typeof content === 'string' ? content : content.map(part => part.text || '').join('');
      if (!message) {
        message = open({ id: `${responseId}_msg`, type: 'message', status: 'in_progress', role: 'assistant', content: [] });
        wire += event('response.output_item.added', { output_index: message.index, item: message.item });
        wire += event('response.content_part.added', { item_id: message.item.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      state.text += text;
      wire += event('response.output_text.delta', { item_id: message.item.id, output_index: message.index, content_index: 0, delta: text });
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index || 0;
      let current = state.tools.get(index);
      if (!current) {
        current = open({ id: `fc_${responseId}_${index}`, call_id: call.id || `call_${index}`, name: call.function?.name || '', type: 'function_call', status: 'in_progress', arguments: '' });
        state.tools.set(index, current);
        wire += event('response.output_item.added', { output_index: current.index, item: current.item });
      }
      if (call.id) current.item.call_id = call.id;
      if (call.function?.name) current.item.name = call.function.name;
      current.item.arguments += call.function?.arguments || '';
      wire += event('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: call.function?.arguments || '' });
    }
    return wire;
  };
  const finish = ({ finishReason = state.finishReason || 'stop', usage = state.usage } = {}) => {
    if (state.finished) return '';
    let wire = start();
    state.finished = true;
    if (reasoning) {
      const part = { type: 'summary_text', text: state.reasoning };
      const fields = { item_id: reasoning.item.id, output_index: reasoning.index, summary_index: 0 };
      reasoning.item.summary = [part];
      wire += event('response.reasoning_summary_text.done', { ...fields, text: state.reasoning });
      wire += event('response.reasoning_summary_part.done', { ...fields, part });
    }
    if (message) {
      const part = { type: 'output_text', text: state.text, annotations: [] };
      const fields = { item_id: message.item.id, output_index: message.index, content_index: 0 };
      message.item.content = [part];
      wire += event('response.output_text.done', { ...fields, text: state.text });
      wire += event('response.content_part.done', { ...fields, part });
    }
    for (const entry of state.tools.values()) wire += event('response.function_call_arguments.done', { item_id: entry.item.id, output_index: entry.index, arguments: entry.item.arguments });
    for (const entry of state.items) {
      entry.item.status = 'completed';
      wire += event('response.output_item.done', { output_index: entry.index, item: entry.item });
    }
    const incomplete = finishReason === 'length' || finishReason === 'content_filter';
    const result = { ...response(incomplete ? 'incomplete' : 'completed'), output: state.items.map(entry => entry.item), usage: usageToResponse(usage) };
    if (incomplete) result.incomplete_details = { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' };
    return wire + event(incomplete ? 'response.incomplete' : 'response.completed', { response: result });
  };
  return { start, handle, finish, state };
}
