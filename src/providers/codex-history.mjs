/** Translate only DSH's admitted model surface; raw log events are not context. */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(part => part?.type === 'text' || part?.kind === 'text')
    .map(part => String(part.text || part.value || '')).join('');
}

export function codexConversationPrompt({ input, messages = [] }) {
  const history = messages.filter(message => ['user', 'assistant', 'developer', 'tool'].includes(message?.role))
    .map(message => ({ role: message.role, source: message.source, text: textOf(message) })).filter(message => message.text);
  const last = history.at(-1);
  if (last?.role === 'user' && (!last.source || last.source.kind === 'user') && last.text.trim() === input.trim()) history.pop();
  if (!history.length) return input;
  return [
    'Continue this conversation. Treat the latest User message as the task.',
    'Conversation context:',
    ...history.map(message => `${message.role === 'assistant' ? 'Assistant' : message.role === 'user' && (!message.source || message.source.kind === 'user') ? 'User' : 'Recorded context'}: ${message.text}`),
    `User: ${input}`,
  ].join('\n');
}
