import { requestHeaders } from './model-profile-contract.mjs';

const DEFAULT_MAX_TOKENS = 4096;
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const json = value => typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 0);

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'text', text: json(content) }];
  return content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    if (['text', 'input_text', 'output_text'].includes(part.type)) return part.text == null ? [] : [{ type: 'text', text: String(part.text) }];
    if (['image_url', 'input_image', 'image'].includes(part.type)) {
      const raw = part.image_url ?? part.image ?? part.url, url = typeof raw === 'string' ? raw : raw?.url;
      if (!url) return [];
      const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      return [{ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } }];
    }
    return part.text == null ? [] : [{ type: 'text', text: String(part.text) }];
  });
}

const textOf = content => contentParts(content).filter(part => part.type === 'text').map(part => part.text).join('');
const inputValue = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
};

function chatMessage(message) {
  if (message?.role === 'tool' || message?.tool_call_id) return {
    role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || ''), content: textOf(message.content) }],
  };
  const role = message?.role === 'assistant' ? 'assistant' : 'user';
  const content = contentParts(message?.content);
  if (role === 'assistant') {
    for (const call of message.tool_calls || []) {
      const fn = call?.function || {};
      if (fn.name) content.push({ type: 'tool_use', id: String(call.id || `call_${content.length}`), name: String(fn.name), input: inputValue(fn.arguments) });
    }
  }
  return { role, content: content.length ? content : [{ type: 'text', text: '' }] };
}

function mergeMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else merged.push({ role: message.role, content: [...message.content] });
  }
  return merged;
}

export function chatToAnthropicRequest(input = {}, { model, maxOutputTokens, parameters = {}, reasoningWire } = {}) {
  const body = asObject(input), source = Array.isArray(body.messages) ? body.messages : [];
  const system = source.filter(message => ['system', 'developer'].includes(message?.role)).map(message => textOf(message.content)).filter(Boolean);
  const request = {
    model: model || body.model,
    max_tokens: body.max_tokens ?? maxOutputTokens ?? parameters.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: mergeMessages(source.filter(message => !['system', 'developer'].includes(message?.role)).map(chatMessage)),
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(body.stream !== undefined ? { stream: Boolean(body.stream) } : {}),
  };
  for (const key of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']) {
    if (body[key] !== undefined) request[key] = body[key];
    else if (parameters[key] !== undefined) request[key] = parameters[key];
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap(tool => tool?.type === 'function' && tool.function?.name
    ? [{ name: String(tool.function.name), description: String(tool.function.description || ''), input_schema: tool.function.parameters || { type: 'object', properties: {} } }] : []);
  if (tools.length) request.tools = tools;
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    request.tool_choice = typeof choice === 'string' ? (choice === 'required' ? { type: 'any' } : { type: choice === 'none' ? 'auto' : choice })
      : choice?.type === 'function' ? { type: 'tool', name: choice.function?.name || choice.name } : choice;
  }
  if (reasoningWire || parameters.thinking) request.thinking = parameters.thinking || { type: 'enabled', budget_tokens: Number(reasoningWire) || 1024 };
  return request;
}

export function anthropicResponseToChat(response = {}) {
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('');
  const thinking = content.filter(part => part?.type === 'thinking').map(part => String(part.thinking || '')).join('');
  const toolCalls = content.filter(part => part?.type === 'tool_use').map((part, index) => ({ id: String(part.id || `call_${index}`), type: 'function', function: { name: String(part.name || ''), arguments: JSON.stringify(part.input || {}) } }));
  const stop = response.stop_reason;
  return { id: response.id || `chatcmpl_${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: response.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || (toolCalls.length ? null : ''), ...(thinking ? { reasoning_content: thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: stop === 'tool_use' ? 'tool_calls' : stop === 'max_tokens' ? 'length' : 'stop' }],
    usage: { prompt_tokens: response.usage?.input_tokens || 0, completion_tokens: response.usage?.output_tokens || 0, total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0) } };
}

export function anthropicRequestHeaders(profile = {}) {
  const configured = requestHeaders(profile.headers), headers = { ...configured, 'Content-Type': 'application/json', 'anthropic-version': configured['anthropic-version'] || '2023-06-01' };
  const names = Object.keys(configured).map(name => name.toLowerCase());
  if (profile.apiKey && !names.includes('x-api-key') && !names.includes('authorization')) headers['x-api-key'] = profile.apiKey;
  return headers;
}

export function createAnthropicStreamTransformer() {
  const blocks = new Map(); let usage = {}; let finishReason;
  return {
    handle(event = {}) {
      const type = String(event.type || '');
      if (type === 'message_start') { usage = { prompt_tokens: event.message?.usage?.input_tokens || 0, completion_tokens: 0, total_tokens: event.message?.usage?.input_tokens || 0 }; return null; }
      if (type === 'content_block_start') {
        const block = event.content_block || {}, index = Number(event.index || 0); blocks.set(index, { id: block.id || `call_${index}` });
        return block.type === 'tool_use' ? { choices: [{ index: 0, delta: { tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name || '', arguments: '' } }] }, finish_reason: null }] } : null;
      }
      if (type === 'content_block_delta') {
        const index = Number(event.index || 0), block = blocks.get(index) || {}, delta = event.delta || {};
        if (delta.type === 'text_delta') return { choices: [{ index: 0, delta: { content: String(delta.text || '') }, finish_reason: null }] };
        if (delta.type === 'thinking_delta') return { choices: [{ index: 0, delta: { reasoning_content: String(delta.thinking || '') }, finish_reason: null }] };
        if (delta.type === 'input_json_delta') return { choices: [{ index: 0, delta: { tool_calls: [{ index, id: block.id, type: 'function', function: { arguments: String(delta.partial_json || '') } }] }, finish_reason: null }] };
      }
      if (type === 'message_delta') { finishReason = event.delta?.stop_reason === 'tool_use' ? 'tool_calls' : event.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop'; usage = { ...usage, completion_tokens: event.usage?.output_tokens || 0 }; usage.total_tokens = usage.prompt_tokens + usage.completion_tokens; return { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage }; }
      if (type === 'message_stop') return { choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }], usage };
      return null;
    },
  };
}
