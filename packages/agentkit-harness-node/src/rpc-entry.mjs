#!/usr/bin/env node
// Minimal versioned JSON-RPC 2.0 over NDJSON entry for the Native Harness.
//
// Independent Node process entry shipped by @kingsoftcloud/agentkit-harness-node.
// It reuses the real NativeKernel sole loop over the SQLite run store and the
// one-request model HTTP port — no kernel duplication, no Python bridge, no
// cloud scheduler. The protocol promises only a serializable boundary; it
// never pretends arbitrary Python functions can be passed.
//
// Methods: initialize, task/submit, task/status, task/subscribe (cursor
// long-poll), task/cancel, task/resume. Protocol version is declared by
// initialize. The client supplies a business `requestId` (a string in
// task/submit params); it is idempotent across process restarts via a durable
// SQLite ledger: a retried requestId does NOT re-run its task (an unknown side
// effect may already have happened) and a requestId reused with different
// parameters is rejected as a conflict. The JSON-RPC `id` only correlates
// request/response and is never used as the business key (a numeric and string
// id would otherwise collide). Cancel is fast and never blocks on a long task;
// subscribe resumes from a cursor after a disconnect. A notification (no `id`)
// is processed but not answered. stdout carries only JSON-RPC; logs go to
// stderr.
//
// Configuration is trusted startup-only (args/env): the workspace root, the
// permission grant, the run-store db, the request-ledger db and the model
// profile are all fixed at launch. The protocol cannot escalate permissions or
// read arbitrary files. Credentials travel only in model request headers and
// never enter the ledger or stdout.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { NativeKernel, configure, initialSnapshot, canonical, terminal, runKey, NativeError, isNativeError }
  from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy }
  from './index.mjs';
import { RpcRequestLedger, digestRequest } from './rpc-ledger.mjs';
import { WORKSPACE_TOOLS, createWorkspaceToolExecutor } from './rpc-tools.mjs';

export const RPC_PROTOCOL_VERSION = 'agentkit.native-rpc/v1';

const ERR = {
  parse_error: { code: -32700, message: 'Parse error' },
  invalid_request: { code: -32600, message: 'Invalid Request' },
  method_not_found: { code: -32601, message: 'Method not found' },
  invalid_params: { code: -32602, message: 'Invalid params' },
  internalError: { code: -32603, message: 'Internal error' },
  request_id_conflict: { code: -32001, message: 'requestId conflict' },
  run_not_found: { code: -32002, message: 'run not found' },
  not_dispatchable: { code: -32003, message: 'run not dispatchable' },
  binding_changed: { code: -32004, message: 'startup binding differs from the stored task' },
  shutting_down: { code: -32005, message: 'server shutting down' },
};

const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const errorResponse = (id, e, data) => ({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message, ...(data ? { data } : {}) } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

const runIdFor = requestId => 'rpc:' + createHash('sha256').update(requestId).digest('hex');

function nativeErrorToRpc(e) {
  if (isNativeError(e)) {
    if (e.code === 'run_not_found') return ERR.run_not_found;
    if (e.code === 'worker_already_driving') return ERR.not_dispatchable;
  }
  return ERR.internalError;
}

function compactResponse(snapshot) {
  return {
    phase: snapshot.phase, outcome: snapshot.outcome ?? null, reason: snapshot.reason ?? null,
    finalText: snapshot.finalText || '', usage: snapshot.usage, eventSeq: snapshot.eventSeq,
  };
}

function resolveProfileFromEnv() {
  const protocol = process.env.NATIVE_MODEL_PROTOCOL;
  const baseUrl = process.env.NATIVE_MODEL_BASE_URL;
  const apiKey = process.env.NATIVE_MODEL_API_KEY;
  const model = process.env.NATIVE_MODEL_NAME;
  if (!protocol || !baseUrl || !apiKey || !model)
    throw new Error('NATIVE_MODEL_PROTOCOL/BASE_URL/API_KEY/NAME are required');
  return { protocol, baseUrl, apiKey, model, parameters: {} };
}

export function buildStartup(args) {
  const workspaceDir = resolvePath(args.workspace);
  const workspaceReal = realpathSync(workspaceDir);
  // No filesystem access is granted by default. Grants are trusted startup
  // configuration; protocol messages cannot add tools or permissions.
  const granted = new Set((args.permissions ?? '')
    .split(',').map(s => s.trim()).filter(Boolean));
  if ([...granted].some(p => !['workspace:read', 'workspace:write'].includes(p)))
    throw new Error('unknown workspace permission');
  const binding = resolveProfileFromEnv(); // validate model env at startup
  // Single source of truth for timeouts: --request-timeout-ms overrides the
  // profile default and MUST be strictly less than --effect-timeout-ms. The
  // profile's requestTimeoutMs is set from the same value so they cannot drift.
  const effectTimeoutMs = Number(args['effect-timeout-ms'] ?? 60000);
  const requestTimeoutMs = Number(args['request-timeout-ms'] ?? process.env.NATIVE_MODEL_REQUEST_TIMEOUT_MS ?? 45000);
  if (!(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0))
    throw new Error('request-timeout-ms must be a positive finite number');
  if (!(Number.isFinite(effectTimeoutMs) && effectTimeoutMs > 0))
    throw new Error('effect-timeout-ms must be a positive finite number');
  if (requestTimeoutMs >= effectTimeoutMs)
    throw new Error('request-timeout-ms must be strictly less than effect-timeout-ms');
  const profile = {
    profileId: process.env.NATIVE_MODEL_PROFILE_ID || 'native-rpc',
    profileVersion: '1',
    providerFamily: binding.protocol,
    compatibilityDigest: process.env.NATIVE_MODEL_COMPAT || 'native-rpc/v1',
    maxOutputTokens: Number(process.env.NATIVE_MODEL_MAX_TOKENS || 1024),
    requestTimeoutMs,
    maxRetries: 0, maxProviderRetries: 0, streaming: false,
  };
  const limits = {
    maxModelCalls: Number(args['max-model-calls'] || 8), maxToolCalls: 20, maxParallelTools: 2,
    effectTimeoutMs, leaseMs: Number(args['lease-ms'] || 8000), finalizationReserveModelCalls: 1,
    maxWallMs: null, maxRecoveryRetries: 0,
  };
  const startup = {
    workspaceDir, workspaceReal, granted, profile, limits,
    tools: WORKSPACE_TOOLS.filter(tool => tool.permissions.every(p => granted.has(p))),
    modelBinding: Object.freeze({ ...binding, parameters: Object.freeze({ ...binding.parameters }) }),
    modelRecoveryPolicy: nativeModelRecoveryPolicy({ protocol: binding.protocol, parameters: {} }),
    execLogPath: args['exec-log'] || null,
    owner: args.owner || 'native-rpc',
    scope: {
      tenantId: args['scope-tenant'] || 'native',
      workspaceId: args['scope-workspace'] || 'native',
      userId: args['scope-user'] || 'native',
      agentId: args['scope-agent'] || 'native-rpc',
    },
  };
  startup.hostBindingDigest = digest({ version: RPC_PROTOCOL_VERSION, workspaceReal,
    scope: startup.scope, grants: [...granted].sort(), tools: startup.tools,
    profile, limits, binding: { ...binding, apiKey: digest(binding.apiKey) } });
  // Validate the entire configuration before accepting any requestId.
  buildRunConfig(startup, 'startup-validation', { objective: 'validate startup' });
  return startup;
}

function buildRunConfig(startup, runId, params) {
  const objective = String(params?.objective || '').trim();
  if (!objective) throw new Error('objective required');
  const identity = { scope: startup.scope, runId, sessionId: runId, turnId: 'turn-1',
    buildId: 'rpc-v1', parentRunId: null, taskChainId: runId };
  const config = configure({
    profile: startup.profile,
    contract: { objective, acceptance: [{ id: 'complete', required: true, verifierRef: 'native-rpc',
      verifierVersion: '1', verificationMethod: 'deterministic', description: 'Run reached a final answer.' }] },
    tools: startup.tools,
    limits: startup.limits,
    hostBindingDigest: startup.hostBindingDigest,
    modelRecoveryPolicy: startup.modelRecoveryPolicy,
  });
  const snapshot = initialSnapshot(identity, config, digest(config));
  return { config, snapshot };
}

/**
 * In-process server. Tests construct it directly; main() wires it to stdio.
 * One kernel + one model port + one tool executor are bound to the startup
 * config; each task/submit builds its own per-task RunConfiguration.
 *
 * A custom trusted executor may be supplied by Node hosts. It never comes from
 * the wire protocol; process tests use this seam for crash injection.
 */
export function createNativeRpcServer({ startup, store, ledger, owner = startup.owner, toolExecutor: toolExecutorOverride }) {
  const scope = startup.scope;
  const toolExecutor = toolExecutorOverride || createWorkspaceToolExecutor({
    workspaceDir: startup.workspaceDir, workspaceReal: startup.workspaceReal,
    granted: startup.granted, execLogPath: startup.execLogPath,
  });
  const modelPort = createNativeModelPort({ resolveProfile: () => startup.modelBinding });
  const kernel = new NativeKernel({ store, owner, digest,
    ports: { model: modelPort, tools: { execute: toolExecutor } } });
  const drivers = new Map(); // runKey -> { controller, done: Promise }
  let stopping = false;
  const ledgerId = requestId => digest({ scope, requestId });
  function loadBound(runId) {
    const record = store.load(scope, runId);
    if (record.configuration.hostBindingDigest !== startup.hostBindingDigest) {
      const error = new Error('binding_changed'); error.rpcError = ERR.binding_changed; throw error;
    }
    return record;
  }

  // Drive a run to idle in the background. Idempotent: a second call while a
  // driver is active is a no-op. On a terminal snapshot the requestId mapped to
  // this run (looked up by runKey in the durable ledger) is completed — a retry
  // of that requestId then returns the stored response instead of re-running.
  function drive(runId) {
    if (stopping) return false;
    loadBound(runId);
    const key = runKey(scope, runId);
    if (drivers.has(key)) return true;
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });
    drivers.set(key, { controller, done });
    (async () => {
      try {
        const snap = await kernel.runUntilIdle(scope, runId, { signal: controller.signal });
        if (terminal(snap.phase)) {
          try { const row = ledger.lookupByRunKey(key); if (row) ledger.complete(row.requestId, compactResponse(snap), key); }
          catch (e) { process.stderr.write(`complete failed for ${runId}: ${e.message}\n`); }
        }
      } catch (e) {
        process.stderr.write(`drive failed for ${runId}: ${e.message}\n`);
      } finally { resolveDone(); drivers.delete(key); }
    })();
    return true;
  }

  async function handleSubmit(req) {
    const id = req.id;
    const params = req.params || {};
    // Validate params BEFORE touching the ledger so an invalid request never
    // leaves a pending row that would block a later retry.
    if (Object.keys(params).some(key => !['requestId', 'objective'].includes(key)))
      return errorResponse(id, ERR.invalid_params, { message: 'unknown submit parameter' });
    if (typeof params.requestId !== 'string' || !params.requestId.trim() || params.requestId.length > 256)
      return errorResponse(id, ERR.invalid_params, { message: 'requestId (string) required' });
    if (typeof params.objective !== 'string' || !params.objective.trim() || params.objective.length > 262144)
      return errorResponse(id, ERR.invalid_params, { message: 'objective (string) required' });
    const requestId = params.requestId;
    const runId = runIdFor(requestId);
    const key = runKey(scope, runId);
    const d = digestRequest('task/submit', { requestId, objective: params.objective });
    const built = buildRunConfig(startup, runId, params);
    let rec;
    try { rec = ledger.recordPending(ledgerId(requestId), 'task/submit', d, key); }
    catch (e) {
      if (e.code === 'request_id_conflict') return errorResponse(id, ERR.request_id_conflict, { existingMethod: e.existingMethod });
      throw e;
    }
    if (rec.state === 'completed') {
      loadBound(runId);
      return success(id, { runId, status: 'completed', result: rec.response });
    }
    if (rec.state === 'pending') {
      let exists = false;
      try { loadBound(runId); exists = true; } catch (e) { if (e.code !== 'run_not_found') throw e; }
      if (exists) { drive(runId); return success(id, { runId, status: 'pending' }); }
      // The previous attempt crashed after recording pending but before creating
      // the run (no side effects happened). Fall through to create it now.
    }
    try { kernel.start(built.snapshot, built.config); }
    catch (e) { return errorResponse(id, nativeErrorToRpc(e), { code: e.code }); }
    drive(runId);
    return success(id, { runId, status: 'accepted' });
  }

  async function handleStatus(req) {
    const runId = req.params?.runId;
    if (typeof runId !== 'string' || !runId.trim())
      return errorResponse(req.id, ERR.invalid_params, { message: 'runId (string) required' });
    let record;
    try { record = store.load(scope, runId); } catch (e) { return errorResponse(req.id, nativeErrorToRpc(e), { code: e.code }); }
    const s = record.snapshot;
    return success(req.id, { runId, phase: s.phase, outcome: s.outcome ?? null, reason: s.reason ?? null,
      finalText: s.finalText || '', usage: s.usage, eventSeq: s.eventSeq,
      terminal: terminal(s.phase), driving: drivers.has(runKey(scope, runId)) });
  }

  async function handleSubscribe(req) {
    const runId = req.params?.runId;
    const cursor = req.params?.cursor;
    const waitMs = req.params?.waitMs;
    if (typeof runId !== 'string' || !runId.trim())
      return errorResponse(req.id, ERR.invalid_params, { message: 'runId (string) required' });
    const c = cursor === undefined ? 0 : cursor;
    if (!Number.isSafeInteger(c) || c < 0)
      return errorResponse(req.id, ERR.invalid_params, { message: 'cursor must be a non-negative integer' });
    const w = waitMs === undefined ? 25000 : waitMs;
    if (!Number.isSafeInteger(w) || w < 0 || w > 60000)
      return errorResponse(req.id, ERR.invalid_params, { message: 'waitMs must be a finite number in [0,60000]' });
    try { store.load(scope, runId); } catch (e) { return errorResponse(req.id, nativeErrorToRpc(e), { code: e.code }); }
    const deadline = Date.now() + w;
    let cur = c;
    while (true) {
      if (stopping) return errorResponse(req.id, ERR.shutting_down);
      let events;
      try { events = store.events(scope, runId, cur); } catch (e) { return errorResponse(req.id, nativeErrorToRpc(e), { code: e.code }); }
      if (events.length) cur = events[events.length - 1].seq;
      let snap;
      try { snap = store.load(scope, runId).snapshot; } catch (e) { return errorResponse(req.id, nativeErrorToRpc(e), { code: e.code }); }
      const done = terminal(snap.phase);
      if (events.length || done) return success(req.id, { runId, events, cursor: cur, terminal: done });
      if (Date.now() >= deadline) return success(req.id, { runId, events: [], cursor: cur, terminal: false });
      await sleep(100);
    }
  }

  async function handleCancel(req) {
    const runId = req.params?.runId;
    const commandId = req.params?.commandId;
    if (typeof runId !== 'string' || !runId.trim() || typeof commandId !== 'string' || !commandId.trim())
      return errorResponse(req.id, ERR.invalid_params, { message: 'runId and commandId (strings) required' });
    let result;
    try { loadBound(runId); result = kernel.submit(scope, runId, { commandId, kind: 'cancel', payload: {} });
      if (result.status !== 'rejected') drive(runId); }
    catch (e) { return errorResponse(req.id, e.rpcError || nativeErrorToRpc(e), { code: e.code }); }
    return success(req.id, { runId, commandId, status: result.status, reason: result.reason });
  }

  async function handleResume(req) {
    const runId = req.params?.runId;
    if (typeof runId !== 'string' || !runId.trim())
      return errorResponse(req.id, ERR.invalid_params, { message: 'runId (string) required' });
    let record;
    try { record = loadBound(runId); } catch (e) { return errorResponse(req.id, e.rpcError || nativeErrorToRpc(e), { code: e.code }); }
    if (terminal(record.snapshot.phase)) return success(req.id, { runId, status: 'closed', driving: false, result: compactResponse(record.snapshot) });
    drive(runId);
    return success(req.id, { runId, status: 'driving', driving: true });
  }

  async function handleInitialize(req) {
    return success(req.id, {
      protocolVersion: RPC_PROTOCOL_VERSION,
      server: { owner, scope: startup.scope, workspace: startup.workspaceDir,
        permissions: [...startup.granted], tools: startup.tools.map(t => t.name) },
      limits: startup.limits,
      capabilities: { methods: ['initialize', 'task/submit', 'task/status', 'task/subscribe', 'task/cancel', 'task/resume'] },
    });
  }

  async function handle(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return errorResponse(null, ERR.invalid_request);
    if (Object.hasOwn(req, 'id') && req.id !== null && typeof req.id !== 'string' && !Number.isSafeInteger(req.id))
      return errorResponse(null, ERR.invalid_request);
    if (req.jsonrpc !== '2.0') return errorResponse(req.id ?? null, ERR.invalid_request);
    if (typeof req.method !== 'string') return errorResponse(req.id ?? null, ERR.invalid_request);
    if (req.params !== undefined && (req.params === null || typeof req.params !== 'object' || Array.isArray(req.params)))
      return Object.hasOwn(req, 'id') ? errorResponse(req.id, ERR.invalid_params) : null;
    // JSON-RPC notification: no `id` member. Process but do not respond.
    if (!Object.hasOwn(req, 'id')) {
      try { await dispatch(req); } catch (e) { process.stderr.write(`notification error: ${e?.stack || e}\n`); }
      return null;
    }
    return dispatch(req);
  }

  async function dispatch(req) {
    const id = req.id;
    try {
      if (stopping) return errorResponse(id, ERR.shutting_down);
      switch (req.method) {
        case 'initialize': return await handleInitialize(req);
        case 'task/submit': return await handleSubmit(req);
        case 'task/status': return await handleStatus(req);
        case 'task/subscribe': return await handleSubscribe(req);
        case 'task/cancel': return await handleCancel(req);
        case 'task/resume': return await handleResume(req);
        default: return errorResponse(id, ERR.method_not_found);
      }
    } catch (e) {
      const rpcErr = e.rpcError || nativeErrorToRpc(e);
      return errorResponse(id, rpcErr, e.rpcError ? { message: e.message } : { code: e.code });
    }
  }

  async function dispose() {
    stopping = true;
    const pending = [];
    for (const [, d] of drivers) { try { d.controller.abort(); } catch {} pending.push(d.done); }
    if (pending.length) await Promise.allSettled(pending);
    try { store.close(); } catch {}
    try { ledger.close(); } catch {}
  }

  return { handle, dispose, kernel, store, ledger, drive };
}

// ---- Process entry -----------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({
    options: {
      db: { type: 'string' }, ledger: { type: 'string' }, workspace: { type: 'string' },
      permissions: { type: 'string' },
      owner: { type: 'string', default: 'native-rpc' },
      'scope-tenant': { type: 'string' }, 'scope-workspace': { type: 'string' },
      'scope-user': { type: 'string' }, 'scope-agent': { type: 'string' },
      'lease-ms': { type: 'string' }, 'max-model-calls': { type: 'string' },
      'effect-timeout-ms': { type: 'string' }, 'request-timeout-ms': { type: 'string' },
      'exec-log': { type: 'string' },
    }, args: argv,
  });
  if (!args.db || !args.ledger || !args.workspace) {
    process.stderr.write('Usage: agentkit-native-rpc --db <run.sqlite> --ledger <request.sqlite> --workspace <dir> [options]\n');
    return process.exit(2);
  }
  let startup;
  try { startup = buildStartup(args); }
  catch (e) { process.stderr.write(`startup error: ${e.message}\n`); return process.exit(2); }
  const store = new SqliteRunStore(resolvePath(args.db));
  const ledger = new RpcRequestLedger(resolvePath(args.ledger));
  const server = createNativeRpcServer({ startup, store, ledger, owner: startup.owner });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await server.dispose(); } catch (e) { process.stderr.write(`dispose error: ${e.message}\n`); }
    await Promise.allSettled(handlers);
    await writeChain;
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Dispatch concurrently: a long task/subscribe long-poll must NOT block a
  // later task/cancel or task/status. Responses are matched by JSON-RPC id, so
  // they may complete out of order; writes are serialized to keep each NDJSON
  // line atomic on stdout.
  let writeChain = Promise.resolve();
  const handlers = new Set();
  const writeLine = (obj) => {
    writeChain = writeChain.then(() => new Promise((resolve, reject) =>
      process.stdout.write(JSON.stringify(obj) + '\n', error => error ? reject(error) : resolve()))).catch(() => {});
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) { writeLine(errorResponse(null, ERR.invalid_request)); continue; }
    let req;
    try { req = JSON.parse(line); }
    catch { writeLine(errorResponse(null, ERR.parse_error)); continue; }
    if (handlers.size >= 64) { writeLine(errorResponse(req?.id ?? null, ERR.not_dispatchable)); continue; }
    const handled = server.handle(req).then(res => { if (res) writeLine(res); },
      e => {
        process.stderr.write(`handler error: ${e?.stack || e}\n`);
        writeLine(errorResponse(req?.id ?? null, ERR.internalError));
      });
    handlers.add(handled);
    handled.finally(() => handlers.delete(handled));
  }
  await shutdown();
}

const isMain = (() => {
  try {
    const argvPath = realpathSync(process.argv[1]);
    const thisPath = realpathSync(fileURLToPath(import.meta.url));
    return argvPath === thisPath;
  } catch { return false; }
})();
if (isMain) main().catch(() => { process.stderr.write('Native RPC startup failed\n'); process.exitCode = 2; });
