/**
 * Independent TypeScript/Node Harness provider for AgentKit Studio.
 *
 * It owns a small, explicit runtime boundary and has no KsADK or Python
 * import.  The model is injected by the caller (a provider adapter, a local
 * proxy, or the cloud client), so this module can be tested without a fake
 * network service.  Resource execution is intentionally not implicit: the
 * first slice is text-only, while MCP/Skill/knowledge/memory adapters will be
 * added behind the same session and event contracts.
 */
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'closed']);
const nowIso = clock => new Date(clock()).toISOString();
const asText = input => typeof input === 'string' ? input : Array.isArray(input?.parts)
  ? input.parts.filter(part => part?.kind === 'text').map(part => String(part.text || '')).join('')
  : String(input?.text || '');

export class HarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
  }
}

export class MemorySessionStore {
  #sessions = new Map();
  async save(session) { this.#sessions.set(session.sessionId, structuredClone(session)); return structuredClone(session); }
  async get(sessionId) { const value = this.#sessions.get(sessionId); return value ? structuredClone(value) : null; }
  async list() { return [...this.#sessions.values()].map(value => structuredClone(value)); }
  async delete(sessionId) { this.#sessions.delete(sessionId); }
}

function cloneEvent(event, replay = 'live') {
  return { ...structuredClone(event), snapshotReplay: replay };
}

export class AgentKitHarness {
  constructor({ model, store = new MemorySessionStore(), clock = Date.now, executionLocus = 'endpoint-local' } = {}) {
    if (!model || typeof model.stream !== 'function') throw new TypeError('model.stream is required');
    this.model = model;
    this.store = store;
    this.clock = clock;
    this.executionLocus = executionLocus;
    this.runs = new Map();
  }

  async createSession({ sessionId = `ses_${randomUUID()}`, agentId = null, metadata = {} } = {}) {
    if (!sessionId || typeof sessionId !== 'string') throw new HarnessError('invalid_argument', 'sessionId must be a string');
    if (await this.store.get(sessionId)) throw new HarnessError('already_exists', 'Session already exists', { sessionId });
    return this.store.save({ sessionId, agentId, metadata: structuredClone(metadata), status: 'open', sequence: 0, createdAt: nowIso(this.clock), updatedAt: nowIso(this.clock), messages: [], runs: [], idempotency: {} });
  }

  async getSession(sessionId) {
    const session = await this.store.get(sessionId);
    if (!session) throw new HarnessError('not_found', 'Session not found', { sessionId });
    return session;
  }

  async listSessions({ limit = 20, cursor = '' } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const all = (await this.store.list()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const start = Math.max(0, Number(cursor) || 0);
    const items = all.slice(start, start + safeLimit);
    return { items, nextCursor: start + items.length < all.length ? String(start + items.length) : null };
  }

  async closeSession(sessionId, reason = 'user') {
    const session = await this.getSession(sessionId);
    if (session.status !== 'closed') { session.status = 'closed'; session.closeReason = reason; session.updatedAt = nowIso(this.clock); await this.store.save(session); }
  }

  #event(session, runId, idempotencyKey, kind, data = {}, errorInfo = null, replay = 'live') {
    session.sequence += 1;
    const sequence = session.sequence;
    return {
      sessionId: session.sessionId,
      runId,
      eventId: `evt_${session.sessionId}_${sequence}`,
      sequence,
      watermark: `wm_${session.sessionId}_${sequence}`,
      idempotencyKey,
      snapshotReplay: replay,
      interactionId: null,
      errorInfo,
      executionLocus: this.executionLocus,
      timestamp: nowIso(this.clock),
      kind: { type: kind, data },
    };
  }

  async *prompt({ sessionId, input, idempotencyKey = `prompt_${randomUUID()}`, signal } = {}) {
    const session = await this.getSession(sessionId);
    if (session.status === 'closed') throw new HarnessError('session_closed', 'Session is closed', { sessionId });
    if (!String(idempotencyKey).trim()) throw new HarnessError('invalid_argument', 'idempotencyKey is required');
    const cached = session.idempotency[idempotencyKey];
    if (cached) { for (const event of cached) yield cloneEvent(event, 'replay'); return; }
    const text = asText(input).trim();
    if (!text) throw new HarnessError('invalid_argument', 'Prompt text is required');
    const runId = `run_${randomUUID()}`;
    const events = [];
    const emit = async (kind, data = {}, errorInfo = null) => {
      const event = this.#event(session, runId, idempotencyKey, kind, data, errorInfo);
      events.push(event);
      await this.store.save(session);
      return event;
    };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.runs.set(runId, controller);
    session.runs.push({ runId, status: 'running', idempotencyKey });
    session.messages.push({ role: 'user', content: text, runId });
    try {
      yield await emit('run.started', { status: 'running' });
      yield await emit('user.message', { role: 'user', content: text });
      let assistant = '';
      for await (const chunk of this.model.stream({ sessionId, runId, agentId: session.agentId, messages: session.messages, signal: controller.signal })) {
        if (controller.signal.aborted) throw new HarnessError('canceled', 'Run canceled', { runId });
        const delta = typeof chunk === 'string' ? chunk : String(chunk?.text ?? chunk?.delta ?? '');
        if (!delta) continue;
        assistant += delta;
        yield await emit('assistant.delta', { text: delta });
      }
      session.messages.push({ role: 'assistant', content: assistant, runId });
      session.runs.at(-1).status = 'completed';
      yield await emit('assistant.completed', { text: assistant });
      yield await emit('run.completed', { status: 'completed' });
    } catch (error) {
      const canceled = error?.code === 'canceled' || controller.signal.aborted;
      const typed = canceled ? new HarnessError('canceled', 'Run canceled', { runId }) : error;
      session.runs.at(-1).status = canceled ? 'canceled' : 'failed';
      const info = { code: typed?.code || 'internal', message: typed?.message || String(typed) };
      yield await emit(canceled ? 'run.canceled' : 'run.failed', { status: session.runs.at(-1).status }, info);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.runs.delete(runId);
      session.updatedAt = nowIso(this.clock);
      session.idempotency[idempotencyKey] = events;
      await this.store.save(session);
    }
  }

  async cancelRun({ sessionId, runId } = {}) {
    const session = await this.getSession(sessionId);
    const controller = this.runs.get(runId);
    if (!controller) throw new HarnessError('not_found', 'Run is not active', { runId });
    controller.abort();
    const run = session.runs.find(item => item.runId === runId);
    if (run) run.status = 'canceled';
    await this.store.save(session);
  }

  /** Pause/resume is explicit cancel + resend until a durable thread exists. */
  async *resumeRun({ sessionId, input, idempotencyKey, signal } = {}) {
    yield* this.prompt({ sessionId, input, idempotencyKey, signal });
  }
}

