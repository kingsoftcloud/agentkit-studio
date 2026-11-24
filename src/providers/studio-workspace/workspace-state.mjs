import { constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './workspace-paths.mjs';

const VERSION = 'native-workspace-read-state/v1';
const HEX = /^[0-9a-f]{64}$/u;

export function serializeReadState(state) {
  return { ...state, mtimeNs: state.mtimeNs.toString() };
}

function deserializeReadState(path, raw) {
  if (raw?.path !== path || !raw.path || isAbsolute(path) || path.includes('\0') || path.split('/').includes('..')
    || typeof raw.canonicalPath !== 'string' || !isAbsolute(raw.canonicalPath)
    || typeof raw.contentSha256 !== 'string' || !HEX.test(raw.contentSha256)
    || typeof raw.mtimeNs !== 'string' || !/^-?\d+$/u.test(raw.mtimeNs) || typeof raw.partial !== 'boolean') return null;
  if (!['sizeBytes', 'startLine', 'endLine', 'totalLines'].every(key => Number.isSafeInteger(raw[key]))
    || raw.sizeBytes < 0 || raw.startLine < 1 || raw.endLine < 0 || raw.totalLines < 0 || raw.endLine > raw.totalLines
    || (raw.totalLines > 0 && (raw.startLine > raw.endLine || raw.endLine === 0))
    || (!raw.partial && (raw.startLine !== 1 || raw.endLine !== raw.totalLines))) return null;
  const { sizeBytes, startLine, endLine, totalLines, partial, canonicalPath, contentSha256 } = raw;
  return { path, mtimeNs: BigInt(raw.mtimeNs), sizeBytes, startLine, endLine, totalLines, partial, canonicalPath, contentSha256 };
}

/** Read state is keyed by the real DSH session and stays portable across app updates. */
export class WorkspaceStateStore {
  #filename;
  #sessionId;

  constructor(stateDir, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('workspace sessionId must be a nonempty string');
    this.#filename = join(stateDir, sha256(sessionId), 'read-state.json');
    this.#sessionId = sessionId;
  }

  #load() {
    try {
      const value = JSON.parse(readFileSync(this.#filename, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }));
      if (value?.version === VERSION && value.sessionId === this.#sessionId
        && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)) return value;
    } catch {
      // A missing or invalid receipt cannot authorize a write.
    }
    return { version: VERSION, sessionId: this.#sessionId, entries: {} };
  }

  getReadState(path) {
    const { entries } = this.#load();
    return Object.hasOwn(entries, path) ? deserializeReadState(path, entries[path]) : null;
  }

  recordReadState(state) {
    const document = this.#load();
    const directory = dirname(this.#filename);
    Object.defineProperty(document.entries, state.path, { value: serializeReadState(state), enumerable: true, configurable: true });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(document), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.#filename);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
