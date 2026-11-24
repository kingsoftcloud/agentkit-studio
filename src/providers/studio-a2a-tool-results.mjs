import { invariant } from '../contracts/native-values.mjs';
import { a2aTerminal } from './native-a2a-protocol.mjs';

const AGENT_FIELDS = ['agent_id', 'name', 'description', 'version_id', 'card_sha256', 'source', 'url'];
const MAX_FIELD_BYTES = 4096;
const MAX_LIST_BYTES = 256 * 1024;
const MAX_HINT_BYTES = 64 * 1024;

function boundedField(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length <= MAX_FIELD_BYTES) return bytes.toString('utf8');
  let end = MAX_FIELD_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}

function displayAgent(agent) {
  return Object.fromEntries(AGENT_FIELDS.filter(key => agent[key] != null)
    .map(key => [key, boundedField(key === 'url' ? displayUrl(agent[key]) : agent[key])]));
}

function boundedItems(items, envelope, maxBytes) {
  const result = [];
  let used = Buffer.byteLength(JSON.stringify(envelope));
  for (const item of items) {
    used += Buffer.byteLength(JSON.stringify(item)) + Number(result.length > 0);
    if (used > maxBytes) break;
    result.push(item);
  }
  return result;
}

export function a2aAgentList(agents, spaceId) {
  const envelope = { ok: true, space_id: spaceId, agents: [] };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_LIST_BYTES) return { ok: false,
    error_type: 'a2a_discovery_result_too_large', error_message: 'Configured discovery metadata exceeds the output byte limit' };
  return { ...envelope, agents: boundedItems(agents.map(displayAgent), envelope, MAX_LIST_BYTES) };
}

const normalizeRef = value => String(value || '').trim().toLowerCase().replace(/^a2a-agent-/u, '');

export function a2aAgentCard(agents, reference) {
  const target = normalizeRef(reference);
  const found = target && agents.find(agent => normalizeRef(agent.agent_id) === target || normalizeRef(agent.name) === target);
  if (found) return { ok: true, agent: displayAgent(found) };
  const hints = agents.map(agent => agent.agent_id);
  if (target) {
    const candidates = [...hints, ...agents.map(agent => agent.name).filter(Boolean)];
    const suggestion = candidates.map(normalizeRef).find(name => name.includes(target) || target.includes(name));
    if (suggestion) hints.push(suggestion);
  }
  const envelope = { ok: false, error_message: 'Agent not found', available_agents: [] };
  return { ...envelope, available_agents: boundedItems(new Set(hints.filter(Boolean).map(boundedField)), envelope, MAX_HINT_BYTES) };
}

/** Prefer the last referenced artifact, then the last referenced message. */
export function a2aTerminalResult({ state, task_id, output_refs = [], snapshots = {}, item_kinds = {} }, agent) {
  invariant(a2aTerminal.has(state), 'a2a_terminal_receipt_required');
  const selected = { artifact: new Map(), message: new Map() };
  if (state === 'completed') for (const ref of output_refs) {
    const key = `${ref.scope_id}:${ref.item_id}`;
    if (!Object.hasOwn(item_kinds, key) || !Object.hasOwn(snapshots, key)) continue;
    const kind = item_kinds[key], parts = snapshots[key];
    if (!parts || !Object.hasOwn(selected, kind)) continue;
    const items = selected[kind];
    if (!items.has(key)) items.set(key, []);
    const values = ref.part_id == null ? Object.values(parts) : Object.hasOwn(parts, ref.part_id) ? [parts[ref.part_id]] : [];
    items.get(key).push(...values.filter(value => typeof value === 'string' && value));
  }
  const replies = selected.artifact.size ? selected.artifact : selected.message;
  const ok = state === 'completed';
  return { status: ok ? 'ok' : 'error', content: { ok, agent, task_id, state, reply: [...replies.values()].at(-1)?.join('') ?? '' } };
}
