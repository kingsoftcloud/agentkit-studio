import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDshIdleOwnershipHost } from '@kingsoftcloud/agentkit-harness-node/native/dsh-background-ownership';
import { NATIVE_ENGINE_EVENT } from '../../providers/native-engine-runtime.mjs';
import { engineServiceEndpoint, engineServiceFetch } from '../../providers/engine-service-client.mjs';

export const MANAGED_SESSION_DELIVERY = 'agentkit.managed-session-delivery/v1';
export const MANAGED_SESSION_DELIVERY_LIMIT = 16 * 1024 ** 2;
const managedPath = '/_agentkit/native-kernel/v1/';
const frameResponseLimit = 1024 ** 2 + 1024;
const stopSettlementGraceMs = 2000;
const RECEIPT = 'agentkit/managed-session-delivery';
const STOP = 'agentkit/managed-session-stop-requested';
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const phases = new Set(['completed', 'failed', 'canceled', 'interrupted']);

function waitFor(work, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([work, stopped]).finally(() => signal.removeEventListener('abort', abort));
}

function deliveryKey(event) {
  const { type, data } = event;
  if (!data) return null;
  if (type === 'step/start' || type === 'step/end') return type + ':' + data.turn + ':' + data.step;
  if (type === 'user/message') return type + ':' + data.id;
  if (type === 'assistant/message') return type + ':' + data.message?.id;
  if (type === NATIVE_ENGINE_EVENT) return type + ':' + data.runId + ':' + data.event?.seq;
  if (type === RECEIPT || type === STOP) return type + ':' + data.runId;
  return null;
}

function deliveryFrames(session, turn, runId) {
  const events = session.snapshotEvents();
  const boundary = events.findLastIndex(event => event.type === 'turn/owner' && event.data.turn === turn);
  invariant(boundary >= 0, 'MANAGED_SESSION_DELIVERY_INCOMPLETE');
  const owned = events.slice(boundary + 1);
  const existing = new Map(owned.flatMap(event => {
    const key = deliveryKey(event);
    return key ? [[key, canonical(event.data)]] : [];
  }));
  return {
    cursor: owned.findLast(event => event.type === NATIVE_ENGINE_EVENT && event.data.runId === runId)?.data.event.seq ?? 0,
    stopRequested: existing.has(STOP + ':' + runId),
    append(type, data, options) {
      const key = deliveryKey({ type, data }), encoded = canonical(data);
      if (existing.has(key)) {
        invariant(existing.get(key) === encoded, 'MANAGED_SESSION_DELIVERY_CHANGED');
        return;
      }
      session.append(type, data, options);
      existing.set(key, encoded);
    },
  };
}

function parseClaim(request) {
  const { sessionId, runId, configDigest, input, source } = request;
  invariant(request.deliveryContract === MANAGED_SESSION_DELIVERY && sha256.test(configDigest)
    && typeof input === 'string' && input.trim()
    && source?.provider === 'agentkit-harness' && typeof source.model === 'string' && source.model.trim(),
  'MANAGED_SESSION_DELIVERY_INVALID');
  return canonical({ contract: MANAGED_SESSION_DELIVERY, sessionId, runId, configDigest,
    inputDigest: sha(input), source: { provider: source.provider, model: source.model } });
}

function frameCursor(view, events, after, maximum) {
  invariant((view === null || sha256.test(view)) && Array.isArray(events) && events.length <= maximum,
    'MANAGED_SESSION_DELIVERY_INVALID');
  let last = after;
  for (const event of events) {
    invariant(event && Number.isSafeInteger(event.seq) && event.seq > last && typeof event.kind === 'string',
      'MANAGED_SESSION_DELIVERY_INVALID');
    last = event.seq;
  }
  return last;
}

function parseFinal(request) {
  const { phase, finalText, view, events } = request;
  invariant(phases.has(phase) && typeof finalText === 'string' && (phase === 'completed' || finalText === ''),
    'MANAGED_SESSION_DELIVERY_INVALID');
  frameCursor(view, events, 0, 2000);
  return { phase, finalText, view, events };
}

function createSessionReader({ endpoint, token, caFile }) {
  const root = engineServiceEndpoint(endpoint, token);
  const fetchImpl = engineServiceFetch(endpoint, caFile);
  async function read(action, query, signal, limit) {
    const response = await fetchImpl(root + managedPath + action, { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: MANAGED_SESSION_DELIVERY, ...query }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error('Managed Session progress unavailable');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      invariant(size <= limit, 'MANAGED_SESSION_FRAME_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
    const page = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    invariant(page?.contract === MANAGED_SESSION_DELIVERY, 'MANAGED_SESSION_FRAME_RESPONSE_INVALID');
    return page;
  }
  return {
    async frames({ sessionId, runId, ref, configDigest }, after, signal) {
      const page = await read('session-frames', { sessionId, runId, ref, configDigest, after }, signal, frameResponseLimit);
      invariant(page.cursor === frameCursor(page.view, page.events, after, 128), 'MANAGED_SESSION_FRAME_RESPONSE_INVALID');
      return page;
    },
    async cancel({ sessionId, runId, ref, configDigest }, signal) {
      const result = await read('session-cancel', { sessionId, runId, ref, configDigest }, signal, frameResponseLimit);
      invariant(['accepted', 'terminal'].includes(result.status), 'MANAGED_SESSION_CANCEL_RESPONSE_INVALID');
    },
    async restore({ sessionId, runId, configDigest }, signal) {
      const result = await read('session-restore', { sessionId, runId, configDigest }, signal, MANAGED_SESSION_DELIVERY_LIMIT);
      invariant(typeof result.ref === 'string' && result.ref.length > 0 && result.ref.length <= 8192,
        'MANAGED_SESSION_RESTORE_RESPONSE_INVALID');
      return { deliveryContract: MANAGED_SESSION_DELIVERY, sessionId, runId, configDigest,
        ref: result.ref, input: result.input, source: result.source, follow: true, hostCancel: result.hostCancel === true };
    },
  };
}

/** The Studio Session is the acknowledgement ledger. The Harness owns the
 * Run, terminal payload and retry. The SDK owns the exclusive product turn. */
export function createStudioManagedSessionDelivery({ ctx, remote }) {
  const lifetime = new AbortController(), active = new Map();
  const reader = remote ? createSessionReader(remote) : null;
  const sessions = ctx.get('sessions');
  invariant(typeof sessions?.flush === 'function', 'MANAGED_SESSION_DELIVERY_UNAVAILABLE');
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Managed Session delivery retired'));
    await Promise.allSettled([...active.values()].map(slot => slot.work));
  }, 'agentkit-studio: managed Harness Session delivery');

  function reattach(agent) {
    void restore(agent).catch(error => {
      if (!lifetime.signal.aborted)
        console.warn('[studio] Managed Session restore stopped:', error.code || 'MANAGED_SESSION_RESTORE_UNAVAILABLE');
    });
  }
  if (reader) ctx.on('agent/created', ({ agent }) => {
    // The SDK is still announcing the restored Agent. Reattach out of band
    // so it can finish publishing the Agent before the driver asks for idle.
    reattach(agent);
  });

  async function restore(agent) {
    const owner = agent.externalTurns?.pending();
    if (owner?.engine !== MANAGED_SESSION_DELIVERY || active.has(agent.session.id)) return;
    const binding = parseNativeJson(owner.binding);
    invariant(binding?.contract === MANAGED_SESSION_DELIVERY && binding.sessionId === agent.session.id
      && typeof binding.runId === 'string' && sha256.test(binding.configDigest), 'MANAGED_SESSION_DELIVERY_INVALID');
    const signal = lifetime.signal;
    const agents = ctx.get('agents');
    const stillOwned = () => (typeof agents?.get !== 'function' || agents.get(agent.session.id) === agent)
      && agent.externalTurns.pending()?.binding === owner.binding;
    let wait = 250;
    while (stillOwned()) {
      let request;
      try { request = await reader.restore(binding, signal); }
      catch {
        if (active.has(agent.session.id) || !stillOwned()) return;
        await delay(wait, undefined, { signal });
        wait = Math.min(wait * 2, 2000);
        continue;
      }
      if (!stillOwned()) return;
      invariant(parseClaim(request) === owner.binding, 'MANAGED_SESSION_DELIVERY_CHANGED');
      await accept(agent, request, signal);
      return;
    }
  }

  function receipt(session, binding, runId) {
    const events = session.snapshotEvents();
    const owner = events.find(event => event.type === 'turn/owner' && event.data.engine === MANAGED_SESSION_DELIVERY
      && JSON.parse(event.data.binding).runId === runId);
    if (owner) invariant(owner.data.binding === binding, 'MANAGED_SESSION_DELIVERY_CHANGED');
    if (!owner || !events.some(event => event.type === 'turn/end' && event.data.turn === owner.data.turn)) return null;
    const delivered = events.find(event => event.type === RECEIPT && event.data.runId === runId && event.data.turn === owner.data.turn);
    invariant(delivered && sha256.test(delivered.data.digest), 'MANAGED_SESSION_DELIVERY_INCOMPLETE');
    return delivered.data.digest;
  }

  async function flush(session, signal = lifetime.signal) {
    invariant(await waitFor(sessions.flush(session), AbortSignal.any([signal, AbortSignal.timeout(10000)])) === true,
      'MANAGED_SESSION_DELIVERY_NOT_DURABLE');
  }

  async function follow(agent, request, frames, signal) {
    let cursor = frames.cursor, retryMs = 250;
    while (!signal.aborted) {
      let page;
      try { page = await reader.frames(request, cursor, signal); }
      catch {
        await delay(retryMs, undefined, { signal });
        retryMs = Math.min(retryMs * 2, 2000);
        continue;
      }
      signal.throwIfAborted();
      retryMs = 250;
      if (page.events.length === 0) {
        await delay(250, undefined, { signal });
        continue;
      }
      for (const event of page.events)
        frames.append(NATIVE_ENGINE_EVENT, { runId: request.runId, view: page.view, event }, { ignorable: true });
      try { await flush(agent.session, signal); }
      catch {
        await delay(500, undefined, { signal });
        continue;
      }
      cursor = page.cursor;
    }
  }

  async function deliverStop(request, signal) {
    let wait = 250;
    while (!signal.aborted) {
      try { await reader.cancel(request, signal); return; }
      catch {
        await delay(wait, undefined, { signal });
        wait = Math.min(wait * 2, 2000);
      }
    }
  }

  function start(agent, request, binding) {
    const { sessionId, runId, input } = request;
    const ready = Promise.withResolvers(), finished = Promise.withResolvers();
    const slot = { binding, ready, finished, digest: null };
    const canStop = reader && request.hostCancel === true;
    let reopen = false;
    active.set(sessionId, slot);
    slot.work = (async () => {
      await waitFor(agent.whenIdle(), lifetime.signal);
      const host = nativeDshIdleOwnershipHost(agent);
      const pending = host.pending();
      invariant(!pending || pending.engine === MANAGED_SESSION_DELIVERY && pending.binding === binding,
        'MANAGED_SESSION_DELIVERY_OWNER_CHANGED');
      const drive = async ({ turn, signal }) => {
        const owner = new AbortController(), stop = Promise.withResolvers();
        const ownerSignal = AbortSignal.any([lifetime.signal, owner.signal]);
        const frames = deliveryFrames(agent.session, turn, runId), { append } = frames;
        const id = role => 'managed-' + sha([sessionId, runId, role]);
        let settleTimer;
        const canceled = () => {
          if (canStop && signal.reason?.kind === 'user') {
            stop.resolve();
            // Allow a connected Engine to settle this SDK turn normally.
            // A disconnected Engine must not prevent the SDK from retiring.
            settleTimer = setTimeout(() => owner.abort(signal.reason), stopSettlementGraceMs);
          } else owner.abort(signal.reason);
        };
        signal.addEventListener('abort', canceled, { once: true });
        if (signal.aborted) canceled();
        try {
          ownerSignal.throwIfAborted();
          append('step/start', { turn, step: 1 });
          append('user/message', { id: id('user'), role: 'user', content: [{ type: 'text', text: input }],
            source: { kind: 'user', rpcId: runId } }, { surfaceOp: 'append' });
          await flush(agent.session, ownerSignal);
          ready.resolve();
          const follower = new AbortController();
          const followSignal = AbortSignal.any([ownerSignal, follower.signal]);
          const following = reader && request.follow === true ? follow(agent, request, frames, followSignal).catch(error => {
            if (!followSignal.aborted)
              console.warn('[studio] Managed Session live progress retired:', error.code || 'MANAGED_SESSION_PROGRESS_UNAVAILABLE');
          }) : null;
          const stopping = canStop ? (async () => {
            if (!frames.stopRequested) await waitFor(stop.promise, followSignal);
            if (slot.digest !== null) return;
            append(STOP, { turn, runId }, { ignorable: true });
            await flush(agent.session, followSignal);
            await deliverStop(request, followSignal);
          })().catch(error => {
            if (!followSignal.aborted)
              console.warn('[studio] Managed Session stop delivery interrupted:', error.code || 'MANAGED_SESSION_CANCEL_UNAVAILABLE');
          }) : null;
          let final;
          try { final = await waitFor(finished.promise, ownerSignal); }
          finally { follower.abort(); await Promise.allSettled([following, stopping]); }
          ownerSignal.throwIfAborted();
          for (const event of final.events)
            append(NATIVE_ENGINE_EVENT, { runId, view: final.view, event }, { ignorable: true });
          if (final.finalText) append('assistant/message', { turn, step: 1, stream: [], message: {
            id: id('assistant'), role: 'assistant', content: [{ type: 'text', text: final.finalText }],
            source: { kind: 'model', provider: request.source.provider, model: request.source.model },
          } }, { surfaceOp: 'append' });
          append('step/end', { turn, step: 1 });
          append(RECEIPT, { turn, runId, digest: slot.digest }, { ignorable: true });
          await flush(agent.session, ownerSignal);
          return { reason: final.phase === 'completed' ? { kind: 'completed' }
            : final.phase === 'canceled' ? { kind: 'aborted', reason: { kind: 'user' } }
              : { kind: 'error', error: { code: 'MANAGED_HARNESS_RUN_INCOMPLETE', message: 'Harness execution did not complete' } } };
        } catch (error) {
          if (canStop && signal.aborted && signal.reason?.kind === 'user' && !lifetime.signal.aborted) {
            // Let the SDK retire its aborted driver. The next driver resumes
            // the same turn and sends this durable user intent to Harness.
            reopen = true;
            if (slot.digest === null) {
              append(STOP, { turn, runId }, { ignorable: true });
              await flush(agent.session);
            }
          }
          throw error;
        } finally {
          clearTimeout(settleTimer);
          signal.removeEventListener('abort', canceled);
        }
      };
      if (pending) await host.resume(MANAGED_SESSION_DELIVERY, drive);
      else await host.start(({ turn }) => ({ turn, contract: 'dsh.external-turn/v1',
        engine: MANAGED_SESSION_DELIVERY, binding }), drive);
      invariant(receipt(agent.session, binding, runId) === slot.digest, 'MANAGED_SESSION_DELIVERY_INCOMPLETE');
      await flush(agent.session);
    })().catch(error => {
      ready.reject(error);
      throw error;
    }).finally(() => {
      if (active.get(sessionId) === slot) active.delete(sessionId);
      if (reopen && !lifetime.signal.aborted) reattach(agent);
    });
    void slot.work.catch(() => {});
    void ready.promise.catch(() => {});
    return slot;
  }

  async function accept(agent, request, signal, final) {
    const binding = parseClaim(request);
    const runId = request.runId, sessionId = request.sessionId;
    const digest = final ? sha(final) : null;
    const scoped = AbortSignal.any([signal, lifetime.signal]);
    scoped.throwIfAborted();
    const committed = receipt(agent.session, binding, runId);
    if (committed) {
      invariant(digest === null || committed === digest, 'MANAGED_SESSION_DELIVERY_CHANGED');
      await flush(agent.session, scoped);
      return { received: true };
    }
    const slot = active.get(sessionId) ?? start(agent, request, binding);
    invariant(slot.binding === binding, 'MANAGED_SESSION_DELIVERY_OWNER_CHANGED');
    await waitFor(slot.ready.promise, scoped);
    if (final) {
      invariant(slot.digest === null || slot.digest === digest, 'MANAGED_SESSION_DELIVERY_CHANGED');
      slot.digest = digest;
      slot.finished.resolve(final);
      await waitFor(slot.work, scoped);
    }
    return { received: true };
  }

  return Object.freeze({
    claim: (agent, request, signal) => accept(agent, request, signal),
    finish: (agent, request, signal) => accept(agent, request, signal, parseFinal(request)),
  });
}
