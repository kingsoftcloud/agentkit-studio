/** Real DSH call identities, without Native Runs or fabricated leases.
 * Atomic fsynced records hold the intent/result; SQLite kernel locks serialize
 * competing processes. A lost owner leaves an uncertain intent, never a retry.
 */
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { atomicPrivate, lockUntil, openPrivate, privateDirectory, syncDirectory } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';

export const DSH_NODE_COMMAND_LEDGER = 'agentkit.dsh-node-command-ledger/v1';
export const commandDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}`;
function realExisting(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(realExisting(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
}
const inside = (path, root) => path === root || path.startsWith(root + sep);
export function commandStateRoot(stateDir, workspaceRoot, agentId) {
  const workspace = realpathSync(workspaceRoot), state = realExisting(stateDir);
  invariant(!inside(state, workspace) && !inside(workspace, state), 'dsh_node_command_state_overlap');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const root = join(realpathSync(stateDir), 'commands', commandDigest({ agentId, workspace }));
  privateDirectory(root, true);
  const pinned = identity(lstatSync(root));
  return { root, workspace, guard() {
    invariant(realpathSync(workspaceRoot) === workspace && realpathSync(stateDir) === state,
      'dsh_node_command_root_changed');
    privateDirectory(root);
    invariant(identity(lstatSync(root)) === pinned, 'dsh_node_command_root_changed');
  } };
}

export class DshNodeCommandLedger {
  constructor({ root, agentId, sessionId, assertRoot }) {
    this.owner = Object.freeze({ agentId, sessionId });
    this.root = join(root, commandDigest(this.owner));
    assertRoot(); privateDirectory(this.root, true);
    const pinned = identity(lstatSync(this.root));
    this.guard = () => {
      assertRoot(); privateDirectory(this.root);
      invariant(identity(lstatSync(this.root)) === pinned, 'dsh_node_command_session_root_changed');
    };
  }
  entry(callId, create = false) {
    this.guard(); const path = join(this.root, commandDigest(callId));
    if (create && !existsSync(path)) {
      try { mkdirSync(path, { mode: 0o700 }); syncDirectory(this.root); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    privateDirectory(path); return path;
  }
  read(entry) {
    this.guard(); privateDirectory(entry);
    const path = join(entry, 'record.json');
    if (!existsSync(path)) return null;
    const fd = openPrivate(path, constants.O_RDONLY);
    let record;
    try { record = parseNativeJson(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
    invariant(record?.contract === DSH_NODE_COMMAND_LEDGER && canonical(record.owner) === canonical(this.owner)
      && ['executing', 'finished'].includes(record.phase)
      && record.request?.sessionId === this.owner.sessionId && record.request?.agentId === this.owner.agentId
      && entry === this.entry(record.request.call.callId), 'dsh_node_command_record_invalid');
    return record;
  }
  async execute({ request, binding, taskId, assertCurrent, dispatch }) {
    invariant(request?.signal instanceof AbortSignal && typeof assertCurrent === 'function'
      && typeof dispatch === 'function', 'dsh_node_command_admission_invalid');
    const originalSignal = request.signal, { signal: _, ...json } = request;
    const sealed = canonical({ request: json, binding });
    const guard = () => {
      this.guard(); originalSignal.throwIfAborted();
      const current = assertCurrent();
      if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
      invariant(current === true, 'dsh_node_command_authority_lost');
      const { signal, ...live } = request;
      invariant(signal === originalSignal && canonical({ request: live, binding }) === sealed,
        'dsh_node_command_request_drifted');
      originalSignal.throwIfAborted();
    };
    const matches = previous => invariant(canonical({ request: previous.request, binding: previous.binding }) === sealed,
      'dsh_node_command_call_identity_conflict');
    const unknown = (previous, code = 'dsh_node_command_outcome_unknown') => ({ status: 'uncertain', content: {
      ok: false, error_type: code, evidence_incomplete: true, task_id: previous.taskId ?? null,
      instruction: 'Reconcile this original task; do not automatically relaunch it.' } });
    guard(); const entry = this.entry(request.call.callId, true);
    let release;
    try { release = await lockUntil(join(entry, 'owner.sqlite'), performance.now() + 10000); }
    catch (error) {
      if (error.code !== 'background_command_lock_timeout') throw error;
      guard(); const previous = this.read(entry);
      invariant(previous, 'dsh_node_command_owner_busy'); matches(previous);
      return previous.phase === 'finished' ? copy(previous.result) : unknown(previous, 'dsh_node_command_in_progress');
    }
    try {
      guard();
      const previous = this.read(entry);
      if (previous) {
        matches(previous);
        if (previous.phase === 'finished') return copy(previous.result);
        return unknown(previous);
      }
      const intent = { contract: DSH_NODE_COMMAND_LEDGER, owner: this.owner,
        phase: 'executing', request: copy(json), binding: copy(binding), taskId: taskId ?? null, createdAt: Date.now() };
      guard(); atomicPrivate(join(entry, 'record.json'), canonical(intent));
      // This durable intent precedes every command/cancel dispatch. If the
      // process dies before result commit, a later caller must reconcile.
      let result;
      try { guard(); result = await dispatch(); }
      catch {
        result = { status: 'uncertain', content: { ok: false, error_type: 'dsh_node_command_outcome_unknown',
          evidence_incomplete: true, task_id: taskId ?? null } };
      }
      this.guard();
      atomicPrivate(join(entry, 'record.json'), canonical({ ...intent, phase: 'finished', result, completedAt: Date.now() }));
      return result;
    } finally { release(); }
  }
  resolveOwned(request, taskId, binding) {
    this.guard();
    invariant(typeof taskId === 'string' && /^[a-f0-9]{64}$/.test(taskId), 'dsh_node_command_task_invalid');
    // The index is only a locator. The original full launch record below
    // supplies authority; an index entry alone never grants access.
    const index = join(this.root, 'tasks', taskId);
    privateDirectory(dirname(index));
    const fd = openPrivate(index, constants.O_RDONLY);
    let callId;
    try { callId = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    const record = this.read(this.entry(callId));
    invariant(record?.phase === 'finished' && record.request.call.name === 'run_command'
      && record.result?.status === 'ok' && record.taskId === taskId
      && record.result.content?.task_id === taskId && canonical(record.binding) === canonical(binding),
    'dsh_node_command_task_unowned');
    return { backend: 'local_process', ref: { taskId, operationKey: record.request.operationKey } };
  }
  publishTask(request, result) {
    if (request.call.name !== 'run_command' || result.status !== 'ok' || !result.content?.task_id) return;
    this.guard(); const taskId = result.content.task_id;
    invariant(/^[a-f0-9]{64}$/.test(taskId), 'dsh_node_command_task_invalid');
    const record = this.read(this.entry(request.call.callId));
    invariant(record?.phase === 'finished' && record.taskId === taskId
      && canonical(record.result) === canonical(result), 'dsh_node_command_task_unowned');
    const directory = join(this.root, 'tasks'); privateDirectory(directory, true);
    // Re-publishing the same immutable call repairs a crash after result commit.
    const path = join(directory, taskId);
    if (existsSync(path)) {
      const fd = openPrivate(path, constants.O_RDONLY);
      try { invariant(readFileSync(fd, 'utf8') === request.call.callId, 'dsh_node_command_task_conflict'); }
      finally { closeSync(fd); }
    } else atomicPrivate(path, request.call.callId);
  }
}
