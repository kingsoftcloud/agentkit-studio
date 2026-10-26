import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonical, copy, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest } from '../../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../../../packages/agentkit-harness/src/native/memory-store.mjs';
import { nativeMemoryRequestDigest } from '../../../packages/agentkit-harness/src/native/memory-tools.mjs';
import { prepareMemoryExtractionRun, executeMemoryExtractionRun } from '../../../packages/agentkit-harness/src/native/memory-extraction-run.mjs';
import { nativeMemoryExtractionToolDefinitions, createNativeMemoryExtractionTools } from '../../../packages/agentkit-harness/src/native/memory-extraction-tools.mjs';
import { studioNativeMemoryPolicy, studioNativeMemoryExtractionPolicy, studioNativeModelMemoryEnabled } from '../../providers/native-memory.mjs';
import { captureStudioNativeMemoryExtraction, assertStudioNativeMemoryExtractionCurrent } from '../../providers/native-memory-extraction-source.mjs';
import { readNativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
import { StudioNativeMemoryExtractionStore } from './native-memory-extraction-store.mjs';

export const STUDIO_NATIVE_MEMORY_EXTRACTION = 'agentkit.studio-native-memory-extraction/v1';
const hash = value => memoryDigest(canonical(value));
const digest = value => hash(value).slice(7);
const policyDigest = policy => hash({ contract: STUDIO_NATIVE_MEMORY_EXTRACTION, policy });
const safeCode = error => /^[a-zA-Z0-9_:-]{1,128}$/.test(error?.code) ? error.code : 'native_memory_extraction_failed';

/** Host-owned dispatch and durable cursor publication. Each job uses the shared
 * NativeKernel and its own principal-bound Memory connection; no parent turn's
 * tool port or credential is retained after that turn releases its resources. */
export function createStudioNativeMemoryExtraction({ store, storeDir, resolveRecord, resolveModel,
  principal, signal, onError = () => {}, jobs = new StudioNativeMemoryExtractionStore(join(storeDir, 'native-harness', 'memory-extraction.sqlite')) }) {
  invariant(store && typeof resolveRecord === 'function' && typeof resolveModel === 'function',
    'studio_native_memory_extraction_host_unbound');
  const trustedPrincipal = principal === undefined ? null : copy(principal);
  invariant(trustedPrincipal === null || trustedPrincipal && Object.keys(trustedPrincipal).length === 3
    && ['tenantId', 'workspaceId', 'userId'].every(key => typeof trustedPrincipal[key] === 'string'
      && trustedPrincipal[key].trim()), 'studio_native_memory_extraction_principal_invalid');
  const withinPrincipal = scope => trustedPrincipal === null || scope
    && ['tenantId', 'workspaceId', 'userId'].every(key => scope[key] === trustedPrincipal[key]);
  const lifetime = new AbortController(), owner = `memory-host-${randomUUID()}`, leaseMs = 90_000;
  const stopped = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let closed = false, pumping, recovering, requested = false, timer, closing;
  const memory = (scope, policy, options = {}) => new SqliteNativeMemoryProvider(join(storeDir, 'native-harness', 'memory-v1',
    memoryDigest(scope.tenantId).slice(7), 'memory.sqlite'), { principal: scope, scopes: policy.scopes, ...options });
  const receiptReader = provider => ({ operationKey, call, definition }) => provider.reconcile({ operationKey,
    requestDigest: nativeMemoryRequestDigest({ call, definition, lockedDigest: definition.executionPolicyDigest }) }).receipt;
  const publicJob = job => ({ jobId: job.jobId, parentRunId: job.source.parent.runId,
    status: job.status, usage: copy(job.usage), errorCode: job.errorCode,
    createdAt: job.createdAt, updatedAt: job.updatedAt });

  function schedule({ scope, sessionId, runId, record, buildId = null }) {
    invariant(!closed && !stopped.aborted, 'studio_native_memory_extraction_closed');
    invariant(withinPrincipal(scope), 'studio_native_memory_extraction_scope_unbound');
    if (!studioNativeModelMemoryEnabled(record.spec)) return { status: 'disabled' };
    const policy = studioNativeMemoryPolicy(record.spec), extraction = studioNativeMemoryExtractionPolicy(record.spec);
    const provider = memory(scope, policy);
    try {
      const full = captureStudioNativeMemoryExtraction({ store, scope, sessionId, runId, record, buildId,
        directWriteReceipt: receiptReader(provider) });
      const expectedCursor = jobs.getCursor({ scope, sessionId });
      if (expectedCursor === full.boundaryId) return { status: 'already_consumed' };
      const existing = jobs.list({ scope, sessionId }).find(job => job.expectedCursor === expectedCursor
        && job.source.sourceDigest === full.sourceDigest && job.policyDigest === policyDigest(policy));
      if (existing) { kick(); return publicJob(existing); }
      const position = expectedCursor === null ? -1 : full.messages.findIndex(message => message.id === expectedCursor);
      invariant(expectedCursor === null || position >= 0, 'studio_native_memory_extraction_cursor_not_in_history');
      const messages = full.messages.slice(position + 1), ids = new Set(messages.map(message => message.id));
      const direct = messages.some(message => message.directMemoryWrite);
      const sources = direct ? [] : full.sources.filter(source => ids.has(source.sourceEventId) && !provider.hasConsumedSource(source));
      const permitted = new Set(sources.map(source => source.sourceEventId));
      // Consumed/manual sources remain context, never a fresh citation grant.
      const window = { parent: full.parent, boundaryId: full.boundaryId,
        messages: messages.map(message => permitted.has(message.id) ? message : { ...message, modelOnly: true }), sources };
      window.sourceDigest = hash({ parent: full.parent, expectedCursor, ...window });
      const chars = sources.reduce((total, source) => total + [...source.content.replace(/\s/gu, '')].length, 0);
      // Do not advance a short window: later turns accumulate enough material.
      if (sources.length && chars < extraction.minUserCharacters) return { status: 'deferred', reason: 'short_window', characters: chars };
      const parent = store.load(scope, runId).snapshot;
      const manifest = { records: provider.list({ limit: 1000 }).map(item => ({ memoryId: item.memoryId,
        memoryType: item.memoryType, scope: item.scope, summary: item.summary, version: item.version, writePolicy: item.writePolicy })) };
      const lockedPolicy = policyDigest(policy);
      const prepared = prepareMemoryExtractionRun({ parent: { scope, sessionId, runId, buildId: parent.buildId,
        taskChainId: parent.taskChainId }, source: window, digest, profile: store.load(scope, runId).configuration.profile,
        tools: nativeMemoryExtractionToolDefinitions({ policy, policyDigest: lockedPolicy }), manifest, policyDigest: lockedPolicy });
      const job = jobs.enqueue({ jobId: prepared.identity.runId, scope, sessionId, expectedCursor,
        boundaryId: full.boundaryId, sourceDigest: window.sourceDigest, policyDigest: lockedPolicy,
        source: { ...full, extractionWindow: window }, prepared, manifest });
      kick();
      return publicJob(job);
    } finally { provider.close(); }
  }

  async function dispatch(job) {
    const controller = new AbortController(), jobSignal = AbortSignal.any([stopped, controller.signal]);
    let provider, heartbeat;
    const { extractionWindow: window, ...full } = job.source;
    function assertSourceCurrent(record) {
      jobSignal.throwIfAborted();
      const live = jobs.get(job.jobId);
      invariant(live?.status === 'running' && live.lease?.owner === owner
        && live.lease.fence === job.lease.fence && live.lease.expiresAt > Date.now(), 'native_memory_job_lease_lost');
      assertStudioNativeMemoryExtractionCurrent(full, { store, record, buildId: full.parent.buildId,
        directWriteReceipt: receiptReader(provider) });
    }
    let status = 'error', usage = null, errorCode = null;
    try {
      heartbeat = setInterval(() => {
        try { jobs.renew(job.jobId, { lease: job.lease, now: Date.now(), leaseMs }); }
        catch (error) { controller.abort(error); }
      }, 10_000);
      heartbeat.unref?.();
      const record = await resolveRecord(copy(full.parent));
      jobSignal.throwIfAborted();
      const policy = studioNativeMemoryPolicy(record.spec);
      invariant(studioNativeModelMemoryEnabled(record.spec) && policyDigest(policy) === job.policyDigest,
        'studio_native_memory_extraction_policy_changed');
      const check = () => assertSourceCurrent(record);
      // Recheck inside the owner's actual transaction as well: acquiring the
      // SQLite write lock can wait while another process advances the parent.
      provider = memory(job.scope, policy, { beforeCommit: check });
      check();
      if (!window.sources.length) status = 'no-op';
      else {
        const binding = await resolveModel({ record, parent: copy(full.parent), prepared: copy(job.prepared), signal: jobSignal });
        check();
        const tools = createNativeMemoryExtractionTools({ run: job.prepared, store, provider, policy,
          source: window, assertSourceCurrent: check, planner: binding.planner });
        const result = await executeMemoryExtractionRun({ run: job.prepared, store, owner: `${owner}-${job.lease.fence}`, digest,
          ports: { model: binding.model, tools }, signal: jobSignal, assertSourceCurrent: check, countRequest: binding.countRequest });
        status = result.status;
        usage = copy(result.snapshot.usage);
        if (status === 'error') errorCode = result.snapshot.outcome === 'budget_exhausted'
          ? 'native_memory_extraction_budget_exhausted' : 'native_memory_extraction_run_incomplete';
      }
      if (status === 'success' || status === 'no-op') check();
    } catch (error) {
      status = jobSignal.aborted ? 'aborted' : 'error'; errorCode = safeCode(error);
      // If a kernel was created, expose its independently persisted usage even
      // when an authority check or provider binding subsequently failed.
      try { usage = copy(store.load(job.scope, job.jobId).snapshot.usage); }
      catch (missing) { if (missing.code !== 'run_not_found') onError(missing); }
    } finally {
      clearInterval(heartbeat); provider?.close();
    }
    try { jobs.finish(job.jobId, { lease: job.lease, now: Date.now(), status, usage, errorCode }); }
    catch (error) { onError(error); } // An expired/lost owner never publishes a cursor.
  }

  async function pump() {
    for (;;) {
      if (closed || stopped.aborted) return;
      let claimed;
      const pending = jobs.list({ statuses: ['queued', 'running'] }).filter(job => withinPrincipal(job.scope));
      for (const job of pending) {
        claimed = jobs.claim(job.jobId, { owner, now: Date.now(), leaseMs });
        if (claimed) break;
      }
      if (!claimed) {
        if (pending.length) {
          timer = setTimeout(kick, 1000); timer.unref?.();
        }
        return;
      }
      await dispatch(claimed);
    }
  }
  function kick() {
    if (closed || stopped.aborted) return;
    if (pumping) { requested = true; return; }
    requested = false;
    clearTimeout(timer);
    pumping = Promise.resolve().then(pump).catch(onError).finally(() => {
      pumping = undefined;
      if (requested) kick();
    });
  }
  function recover() {
    if (closed || stopped.aborted) return Promise.resolve();
    if (recovering) return recovering;
    // The completed parent ledger is the durable trigger. A crash between its
    // terminal commit and schedule() must not lose extraction. Discovery is
    // restricted to the Host's trusted principal and current session heads;
    // neither a mutable Agent default nor an auxiliary Run grants admission.
    recovering = Promise.resolve().then(async () => {
      if (!trustedPrincipal || typeof store.listScopes !== 'function') return;
      for (const scope of store.listScopes(trustedPrincipal)) for (const snapshot of store.list(scope)) {
        if (closed || stopped.aborted) return;
        if (snapshot.phase !== 'completed' || store.sessionHead(scope, snapshot.sessionId)?.runId !== snapshot.runId) continue;
        try {
          const loaded = store.load(scope, snapshot.runId);
          if (!loaded.configuration.hostRecoveryBinding || loaded.configuration.childOwnerBinding) continue;
          const capsule = readNativeRecoveryBinding(loaded, { agentId: scope.agentId,
            sessionId: snapshot.sessionId, runId: snapshot.runId });
          const record = await resolveRecord({ scope, sessionId: snapshot.sessionId, runId: snapshot.runId,
            buildId: capsule.buildId, revision: capsule.agentRevision });
          if (closed || stopped.aborted) return;
          schedule({ scope, sessionId: snapshot.sessionId, runId: snapshot.runId, record, buildId: capsule.buildId });
        } catch (error) { if (!closed && !stopped.aborted) onError(error); }
      }
    }).catch(onError).finally(() => { recovering = undefined; kick(); });
    kick();
    return recovering;
  }
  return {
    schedule,
    recover,
    async drain() { while (recovering || pumping) await (recovering ?? pumping); },
    status({ scope, sessionId }) {
      invariant(withinPrincipal(scope), 'studio_native_memory_extraction_scope_unbound');
      return { contract: STUDIO_NATIVE_MEMORY_EXTRACTION, agentId: scope.agentId, sessionId,
        cursor: jobs.getCursor({ scope, sessionId }),
        jobs: jobs.list({ scope, sessionId }).slice(-100).map(publicJob) };
    },
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(timer); lifetime.abort(new Error('Memory extraction Host closed'));
      return closing = Promise.allSettled([recovering, pumping]).finally(() => jobs.close());
    },
  };
}
