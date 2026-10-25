/**
 * Per-session persisted execution state for the Native Node workspace tools.
 *
 * Two pieces of state are owned by this port and must survive an instance or
 * process restart, keyed by sessionId:
 *   - read-state: the last observed file revision per relative path, used to
 *     gate edits/overwrites (read-after-modify and stale-read rejection).
 *   - pending approvals: outstanding approval_required interactions, used to
 *     validate the interactionId/callId binding on an approval reply.
 *
 * Credentials are never stored. Pending approvals keep only an arguments
 * digest, never the tool arguments themselves. The store is single-session:
 * one port instance owns one sessionId; cross-session isolation comes from a
 * separate per-session directory under stateDir.
 *
 * sessionId is an untrusted caller-supplied identifier. It is never joined
 * into the filesystem path verbatim, because a value like "../x" or "a/b"
 * would escape stateDir or collide with another session's directory. The
 * on-disk directory is keyed by a sha256 hex digest of the normalized id, which
 * contains no path separators; the original id is stored inside the
 * JSON files for audit/inspection only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const READ_STATE_VERSION = 'native-workspace-read-state/v1';
const PENDING_VERSION = 'native-workspace-pending-approvals/v1';
const PENDING_TTL_MS = 10 * 60 * 1000;
const HEX = /^[0-9a-f]{64}$/;

/** A recorded observed revision of a workspace file. mtimeNs is a BigInt. */
export function makeReadState(fields) {
  return {
    path: fields.path,
    mtimeNs: BigInt(fields.mtimeNs),
    sizeBytes: Number(fields.sizeBytes),
    startLine: Number(fields.startLine),
    endLine: Number(fields.endLine),
    totalLines: Number(fields.totalLines),
    partial: Boolean(fields.partial),
    canonicalPath: fields.canonicalPath,
    contentSha256: fields.contentSha256,
  };
}

/** Serialize a read state for JSON storage (BigInt mtimeNs -> string). */
export function serializeReadState(state) {
  return {
    path: state.path,
    mtimeNs: state.mtimeNs.toString(),
    sizeBytes: state.sizeBytes,
    startLine: state.startLine,
    endLine: state.endLine,
    totalLines: state.totalLines,
    partial: state.partial,
    canonicalPath: state.canonicalPath,
    contentSha256: state.contentSha256,
  };
}

/** Deserialize a JSON-stored read state back to a BigInt-mtimeNs object. */
export function deserializeReadState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.path !== 'string' || !raw.path || isAbsolute(raw.path) || raw.path.includes('\0')
    || raw.path.split('/').includes('..') || typeof raw.canonicalPath !== 'string' || !isAbsolute(raw.canonicalPath)
    || typeof raw.contentSha256 !== 'string' || !HEX.test(raw.contentSha256)
    || typeof raw.mtimeNs !== 'string' || !/^-?\d+$/.test(raw.mtimeNs)
    || typeof raw.partial !== 'boolean') return null;
  if (!['sizeBytes', 'startLine', 'endLine', 'totalLines'].every(key => Number.isSafeInteger(raw[key]))
    || raw.sizeBytes < 0 || raw.startLine < 1 || raw.endLine < 0 || raw.totalLines < 0
    || raw.endLine > raw.totalLines
    || (raw.totalLines > 0 && (raw.startLine > raw.endLine || raw.endLine === 0))
    || (!raw.partial && (raw.startLine !== 1 || raw.endLine !== raw.totalLines))) return null;
  return makeReadState(raw);
}

export class WorkspaceStateStore {
  constructor(stateDir, sessionId) {
    this.sessionId = normalizeSessionId(sessionId);
    // The on-disk directory is a sha256 hex of the normalized id, so a caller
    // cannot traverse out of stateDir ("../x") or collide with another session
    // by embedding a path separator. The original id is kept in the JSON files
    // for inspection but never used as a filesystem path component.
    this.sessionKey = sessionKeyFor(this.sessionId);
    this.dir = join(stateDir, this.sessionKey);
    this._readStatePath = join(this.dir, 'read-state.json');
    this._pendingPath = join(this.dir, 'pending-approvals.json');
    /** Map<relativePath, readState> (BigInt mtimeNs, in memory). */
    this._readState = new Map();
    /** Map<interactionId, pending> (in memory). */
    this._pending = new Map();
    this._loaded = false;
  }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    this._readState = this._loadReadState();
    this._pending = this._loadPending();
  }

  _loadReadState() {
    try {
      const raw = JSON.parse(readFileSync(this._readStatePath, 'utf-8'));
      if (raw && raw.version === READ_STATE_VERSION && raw.sessionId === this.sessionId
        && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
        this._conversationBranch = raw.conversationBranch;
        const map = new Map();
        for (const [key, value] of Object.entries(raw.entries)) {
          const state = deserializeReadState(value);
          // Drop entries missing the fields validateReadState needs; an edit
          // against a dropped entry is correctly re-rejected as file_not_read
          // rather than crashing the restart on a BigInt/NaN coercion.
          if (state && state.path === key) {
            map.set(key, state);
          }
        }
        return map;
      }
    } catch { /* missing or corrupt: start clean */ }
    return new Map();
  }

  _loadPending() {
    try {
      const raw = JSON.parse(readFileSync(this._pendingPath, 'utf-8'));
      if (raw && raw.version === PENDING_VERSION && raw.sessionId === this.sessionId
        && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
        return new Map(Object.entries(raw.entries).filter(([id, pending]) => pending && pending.interactionId === id
          && typeof pending.callId === 'string' && pending.callId.trim() && typeof pending.name === 'string' && pending.name.trim()
          && typeof pending.argumentsDigest === 'string' && HEX.test(pending.argumentsDigest)
          && Number.isSafeInteger(pending.createdAt) && pending.createdAt >= 0
          && Number.isSafeInteger(pending.expiresAt) && pending.expiresAt >= pending.createdAt));
      }
    } catch { /* missing or corrupt: start clean */ }
    return new Map();
  }

  _persistReadState() {
    this._ensureDir();
    const payload = {
      version: READ_STATE_VERSION,
      sessionId: this.sessionId,
      ...(this._conversationBranch ? { conversationBranch: this._conversationBranch } : {}),
      entries: Object.fromEntries(
        [...this._readState.values()].map(serializeReadState).map((s) => [s.path, s]),
      ),
    };
    atomicWriteJson(this._readStatePath, payload);
  }

  _persistPending() {
    this._ensureDir();
    const payload = {
      version: PENDING_VERSION,
      sessionId: this.sessionId,
      entries: Object.fromEntries(this._pending),
    };
    atomicWriteJson(this._pendingPath, payload);
  }

  _ensureDir() {
    mkdirSync(this.dir, { recursive: true });
  }

  getReadState(relativePath) {
    this._ensureLoaded();
    return this._readState.get(relativePath);
  }

  recordReadState(state) {
    this._ensureLoaded();
    this._readState.set(state.path, state);
    this._persistReadState();
  }

  clearReadState() {
    this._ensureLoaded();
    this._readState.clear();
    this._persistReadState();
  }

  adoptConversationBranch(branch, restore = () => []) {
    if (!branch) return;
    if (!Number.isSafeInteger(branch.generation) || branch.generation < 1 || typeof branch.commandId !== 'string' || !branch.commandId.trim())
      throw Object.assign(Error('workspace_read_branch_invalid'), { code: 'workspace_read_branch_invalid' });
    this._ensureLoaded();
    if (this._conversationBranch?.generation === branch.generation && this._conversationBranch.commandId === branch.commandId) return;
    if (this._conversationBranch?.generation >= branch.generation)
      throw Object.assign(Error('workspace_read_branch_conflict'), { code: 'workspace_read_branch_conflict' });
    // Never let a read on the removed branch authorize an edit after rewind.
    // Fresh reads in this generation remain valid across later turns/restarts.
    const retained = new Map();
    for (const raw of restore()) {
      const state = deserializeReadState(raw);
      if (state && !state.partial) retained.set(state.path, state);
    }
    const previousReads = this._readState, previousBranch = this._conversationBranch;
    this._readState = retained; this._conversationBranch = { ...branch };
    try { this._persistReadState(); }
    catch (error) { this._readState = previousReads; this._conversationBranch = previousBranch; throw error; }
  }

  addPending({ callId, name, argumentsDigest, ttlMs = PENDING_TTL_MS }) {
    this._ensureLoaded();
    const now = Date.now();
    const interactionId = randomUUID();
    const pending = {
      interactionId,
      callId,
      name,
      argumentsDigest,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this._pending.set(interactionId, pending);
    this._persistPending();
    return pending;
  }

  getPending(interactionId) {
    this._ensureLoaded();
    const pending = this._pending.get(interactionId);
    if (!pending) return undefined;
    if (pending.expiresAt < Date.now()) {
      this._pending.delete(interactionId);
      this._persistPending();
      return undefined;
    }
    return pending;
  }

  consumePending(interactionId) {
    this._ensureLoaded();
    const pending = this._pending.get(interactionId);
    if (!pending) return undefined;
    this._pending.delete(interactionId);
    this._persistPending();
    if (pending.expiresAt < Date.now()) return undefined;
    return pending;
  }
}

/** Write JSON atomically (temp sibling + rename) to avoid torn reads on restart. */
export function atomicWriteJson(dest, value) {
  const dir = join(dest, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${dest.split('/').pop()}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify(value), 'utf-8');
  renameSync(tmp, dest);
}

/**
 * The sha256 directory key contains no path separators, so identifiers cannot
 * traverse out of stateDir. Stored records also carry the original identity.
 */
export function sessionKeyFor(sessionId) {
  const digest = createHash('sha256').update(normalizeSessionId(sessionId), 'utf-8').digest('hex');
  return HEX.test(digest) ? digest : 'default';
}

function normalizeSessionId(sessionId) {
  if (sessionId === undefined) return 'default';
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('workspace sessionId must be a nonempty string');
  return sessionId;
}

/** sha256 hex digest of a JSON-serializable value (stable key order). */
export function argumentsDigest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
