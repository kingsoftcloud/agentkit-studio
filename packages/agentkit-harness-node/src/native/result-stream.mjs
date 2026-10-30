import { FINAL_SUBMISSION_TOOL, RESULT_DELIVERY_POLICY } from '@kingsoftcloud/agentkit-harness-core';

/** Decode only a top-level answer string. Nested artifact strings never become prose.
 * This is a linear, non-authoritative display projection; the complete call is
 * independently parsed and validated before it can become a committed result. */
export function answerStringDecoder() {
  let depth = 0, role = null, key = '', keyExpected = false, selected = null;
  let escaped = false, unicode = null, invalid = false;
  return delta => {
    let output = '';
    const character = value => { if (role === 'answer') output += value;else if (role === 'key') key += value; };
    for (const ch of delta) {
      if (invalid) break;
      if (role !== null) {
        if (unicode !== null) {
          if (!/^[0-9a-f]$/i.test(ch)) { invalid = true;break; }
          unicode += ch;
          if (unicode.length === 4) { character(String.fromCharCode(parseInt(unicode, 16)));unicode = null; }
        } else if (escaped) {
          escaped = false;
          if (ch === 'u') unicode = '';
          else {
            const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (!Object.hasOwn(escapes, ch)) { invalid = true;break; }
            character(escapes[ch]);
          }
        } else if (ch === '\\') escaped = true;
        else if (ch === '"') { if (role === 'key') { selected = key;keyExpected = false; }role = null; }
        else if (ch.charCodeAt(0) < 32) { invalid = true;break; }
        else character(ch);
      } else if (ch === '"') {
        role = depth === 1 && keyExpected ? 'key' : depth === 1 && selected === 'answer' ? 'answer' : 'other';key = '';
      } else if (ch === '{' || ch === '[') { depth++;if (depth === 1) keyExpected = true; }
      else if (ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 1) { keyExpected = true;selected = null; }
    }
    return output;
  };
}

/** Suppress the internal envelope while preserving its text answer as live prose. */
export function finalResultDisplay(configuration) {
  if (configuration?.deliveryScopePolicy !== RESULT_DELIVERY_POLICY) return record => [record];
  const tools = new Map(), known = new Set(configuration.tools.map(tool => tool.name));
  return record => {
    const { event } = record;
    if (event.kind !== 'tool_delta') return [record];
    const index = event.metadata.index;
    let state = tools.get(index);
    if (!state) { state = { name: '', pending: [], decode: answerStringDecoder() };tools.set(index, state); }
    if (event.metadata.name) state.name = event.metadata.name;
    state.pending.push(record);
    if (!state.name) return [];
    if (state.name === FINAL_SUBMISSION_TOOL) {
      return state.pending.splice(0).flatMap(item => {
        const text = state.decode(item.event.text);
        return text ? [{ time: item.time, event: { kind: 'text', text } }] : [];
      });
    }
    // A partial or unknown name is not yet a displayable bound tool.
    return known.has(state.name) ? state.pending.splice(0) : [];
  };
}
