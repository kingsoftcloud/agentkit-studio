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
 * separate <stateDir>/<sessionId>/ directory per session.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const READ_STATE_VERSION = 'native-workspace-read-state/v1';
const PENDING_VERSION = 'native-workspace-pending-approvals/v1';
const PENDING_TTL_MS = 10 * 60 * 1000;

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
  return makeReadState({
    path: raw.path,
    mtimeNs: BigInt(raw.mtimeNs),
    sizeBytes: raw.sizeBytes,
    startLine: raw.startLine,
    endLine: raw.endLine,
    totalLines: raw.totalLines,
    partial: raw.partial,
    canonicalPath: raw.canonicalPath,
    contentSha256: raw.contentSha256,
  });
}

export class WorkspaceStateStore {
  constructor(stateDir, sessionId) {
    this.sessionId = String(sessionId || 'default');
    this.dir = join(stateDir, this.sessionId);
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
      if (raw && raw.version === READ_STATE_VERSION && raw.entries) {
        const map = new Map();
        for (const [key, value] of Object.entries(raw.entries)) {
          map.set(key, deserializeReadState(value));
        }
        return map;
      }
    } catch { /* missing or corrupt: start clean */ }
    return new Map();
  }

  _loadPending() {
    try {
      const raw = JSON.parse(readFileSync(this._pendingPath, 'utf-8'));
      if (raw && raw.version === PENDING_VERSION && raw.entries) {
        return new Map(Object.entries(raw.entries));
      }
    } catch { /* missing or corrupt: start clean */ }
    return new Map();
  }

  _persistReadState() {
    this._ensureDir();
    const payload = {
      version: READ_STATE_VERSION,
      sessionId: this.sessionId,
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

/** sha256 hex digest of a JSON-serializable value (stable key order). */
export function argumentsDigest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
