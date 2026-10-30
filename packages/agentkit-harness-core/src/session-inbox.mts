import type { Message, RunSnapshot } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';

export const SESSION_INJECTION_POLICY = 'next-turn-inbox/v1';
export interface SessionInjectionInput {
  injectionId: string;
  text: string;
  source: { kind: string; ref: string };
}
export interface SessionInjection extends SessionInjectionInput { sequence: number; consumedBy: string | null }
export interface SessionInjectionReceipt {
  injectionId: string; sequence: number; status: 'accepted' | 'duplicate'; consumedBy: string | null;
}
export interface SessionInboxState { nextSequence: number; entries: SessionInjection[] }
export const emptySessionInbox = (): SessionInboxState => ({ nextSequence: 1, entries: [] });
const bytes = (value: string) => new TextEncoder().encode(value).length;
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 256 && !value.includes('\0');

/** Plain external data only. No caller-selected message role or execution authority. */
export function validateSessionInjection(value: SessionInjectionInput): SessionInjectionInput {
  invariant(value && Object.keys(value).sort().join(',') === 'injectionId,source,text'
    && identifier(value.injectionId) && typeof value.text === 'string' && !!value.text.trim()
    && bytes(value.text) <= 16384 && !value.text.includes('\0') && value.source
    && Object.keys(value.source).sort().join(',') === 'kind,ref'
    && identifier(value.source.kind) && identifier(value.source.ref), 'invalid_session_injection');
  return copy(value);
}
export function appendSessionInjection(state: SessionInboxState, value: SessionInjectionInput): {
  state: SessionInboxState; receipt: SessionInjectionReceipt;
} {
  const input = validateSessionInjection(value), before = state.entries.find(row => row.injectionId === input.injectionId);
  if (before) {
    invariant(canonical({ injectionId: before.injectionId, text: before.text, source: before.source }) === canonical(input),
      'session_injection_conflict');
    return { state, receipt: { injectionId: before.injectionId, sequence: before.sequence, status: 'duplicate', consumedBy: before.consumedBy } };
  }
  const pending = state.entries.filter(row => row.consumedBy === null);
  invariant(pending.length < 1000 && pending.reduce((sum, row) => sum + bytes(canonical(row)), bytes(canonical(input))) <= 2 * 1024 * 1024,
    'session_inbox_full');
  invariant(Number.isSafeInteger(state.nextSequence) && state.nextSequence > 0 && state.nextSequence < Number.MAX_SAFE_INTEGER,
    'session_inbox_sequence_exhausted');
  const row = { ...input, sequence: state.nextSequence, consumedBy: null };
  return { state: { nextSequence: row.sequence + 1, entries: [...state.entries, row] },
    receipt: { injectionId: row.injectionId, sequence: row.sequence, status: 'accepted', consumedBy: null } };
}

/** Called under the same backend write transaction as the new Run creation. */
export function stageSessionInjections(snapshot: RunSnapshot, entries: SessionInjection[]): void {
  if (!entries.length) return;
  const messages: Message[] = entries.map(row => ({ role: 'user', kind: 'session_injection',
    content: canonical({ type: 'external_session_data', injectionId: row.injectionId,
      sequence: row.sequence, source: row.source, text: row.text }) }));
  // Older history precedes the new data; the current explicit input remains last.
  const current = snapshot.messages.findIndex(message => message.role !== 'system' && !message.history);
  snapshot.messages.splice(current < 0 ? snapshot.messages.length : current, 0, ...messages);
  snapshot.sessionInjections = entries.map(row => ({ injectionId: row.injectionId, sequence: row.sequence }));
}
