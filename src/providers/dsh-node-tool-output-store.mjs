/** Private, content-addressed full tool output for real DSH Agent/Session calls.
 * No Native Run or authority is invented. A complete fsynced entry directory is
 * published in one rename; concurrent writers never share staging files. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { nativeWebToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/web-tools';

export const DSH_NODE_TOOL_OUTPUT_CONTRACT = 'agentkit.dsh-node-tool-output/v1';
const MAX_BYTES = 16 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}`;
const noFollow = constants.O_NOFOLLOW ?? 0;
const privateMode = stat => process.platform === 'win32' || !(stat.mode & 0o077);
const failure = code => Object.assign(new Error(code), { code });

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function directoryStat(path) {
  const stat = lstatSync(path);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && privateMode(stat), 'output_directory_not_private');
  return stat;
}

function fileStat(stat) {
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && privateMode(stat), 'output_file_not_private');
}

function readPrivate(path, maxBytes) {
  const before = lstatSync(path); fileStat(before);
  invariant(before.size <= maxBytes, 'output_entry_oversized');
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd); fileStat(opened);
    invariant(identity(opened) === identity(before), 'output_file_changed');
    // One extra byte detects growth without letting a modified file turn a
    // bounded output verification into an unbounded allocation/read.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd); fileStat(after);
    const named = lstatSync(path); fileStat(named);
    invariant(bytes.length <= maxBytes && bytes.length === after.size && before.size === after.size
      && identity(named) === identity(opened), 'output_file_changed');
    return bytes;
  } finally { closeSync(fd); }
}

function writePrivate(path, bytes, guard) {
  guard();
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    fileStat(fstatSync(fd));
    for (let offset = 0; offset < bytes.length;) {
      guard();
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      invariant(count > 0, 'output_write_stalled'); offset += count;
    }
    fsyncSync(fd); guard();
    const stat = fstatSync(fd); fileStat(stat);
    invariant(stat.size === bytes.length && identity(lstatSync(path)) === identity(stat), 'output_file_changed');
  } finally { closeSync(fd); }
}

export function createDshNodeToolOutputStore({ directory, agentId, isClosed = () => false, signal,
  toolDefinitions = nativeWebToolDefinitions().filter(item => item.name === 'web_fetch') } = {}) {
  invariant(typeof directory === 'string' && directory.trim() && typeof agentId === 'string' && agentId.trim()
    && typeof isClosed === 'function', 'output_binding_invalid');
  invariant(signal === undefined || signal instanceof AbortSignal, 'output_host_signal_invalid');
  const configured = resolve(directory);
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  // Only this Host-supplied root may be an alias. Every owned descendant below
  // its canonical path must remain the original private directory.
  const root = realpathSync(configured), rootIdentity = identity(lstatSync(root));
  invariant(lstatSync(root).isDirectory(), 'output_root_invalid');
  const knownDirectories = new Map();
  invariant(Array.isArray(toolDefinitions) && toolDefinitions.length > 0
    && toolDefinitions.every(item => typeof item?.name === 'string')
    && new Set(toolDefinitions.map(item => item.name)).size === toolDefinitions.length, 'output_definitions_invalid');
  const definitions = new Map(toolDefinitions.map(item => [item.name, copy(item)]));
  let closed = false;
  const assertOpen = () => {
    if (closed || signal?.aborted) throw failure('output_closed');
    const value = isClosed();
    if (value !== false) {
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
      throw failure(value === true ? 'output_closed' : 'output_is_closed_invalid');
    }
    invariant(realpathSync(configured) === root && identity(lstatSync(root)) === rootIdentity, 'output_root_changed');
  };
  const assertDirectory = path => {
    const stat = directoryStat(path);
    invariant(!knownDirectories.has(path) || knownDirectories.get(path) === identity(stat), 'output_directory_changed');
    knownDirectories.set(path, identity(stat));
  };
  const ownDirectory = (parent, name) => {
    assertOpen(); if (parent !== root) assertDirectory(parent);
    const path = join(parent, name);
    try { mkdirSync(path, { mode: 0o700 }); syncDirectory(parent); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertDirectory(path); return path;
  };
  const agentDirectory = ownDirectory(root, sha256(agentId));

  return {
    contract: DSH_NODE_TOOL_OUTPUT_CONTRACT,
    close() { closed = true; },
    persistOutput(request, text, metadata) {
      assertOpen();
      invariant(request?.agentId === agentId && typeof request.sessionId === 'string' && request.sessionId.trim()
        && request.signal instanceof AbortSignal && typeof request.call?.callId === 'string' && request.call.callId.trim(),
      'output_request_unbound');
      const definition = definitions.get(request.call.name);
      invariant(definition && canonical(request.definition) === canonical(definition)
        && request.call.name === definition.name && !toolInputRejection(definition, request.call), 'output_definition_invalid');
      invariant(typeof text === 'string', 'output_text_invalid');
      const bytes = Buffer.from(text, 'utf8');
      invariant(bytes.length > 0 && bytes.length <= MAX_BYTES, 'output_text_size_invalid');
      invariant(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.toolName === definition.name
        && typeof metadata.mediaType === 'string' && metadata.mediaType.trim()
        && Number.isSafeInteger(metadata.fullBytes) && metadata.fullBytes >= 0
        && typeof metadata.reachedByteCeiling === 'boolean', 'output_metadata_invalid');
      const { signal: originalSignal, ...json } = request;
      const sealed = canonical(json), metaJson = canonical(metadata);
      const facts = { contract: DSH_NODE_TOOL_OUTPUT_CONTRACT, request: copy(json), metadata: copy(metadata),
        sizeBytes: bytes.length, sha256: sha256(bytes) };
      const metadataBytes = Buffer.from(canonical(facts));
      invariant(metadataBytes.length <= 1024 * 1024, 'output_identity_oversized');
      const entryDigest = sha256(canonical(facts));
      const sessionDirectory = ownDirectory(agentDirectory, sha256(request.sessionId));
      const entry = join(sessionDirectory, entryDigest), textPath = join(entry, 'output.txt');
      const guard = () => {
        assertOpen(); assertDirectory(agentDirectory); assertDirectory(sessionDirectory);
        originalSignal.throwIfAborted();
        const { signal: currentSignal, ...current } = request;
        invariant(currentSignal === originalSignal && canonical(current) === sealed && canonical(metadata) === metaJson,
          'output_request_drifted');
      };
      const verify = () => {
        guard(); const stat = directoryStat(entry);
        const meta = readPrivate(join(entry, 'metadata.json'), 1024 * 1024);
        invariant(meta.equals(metadataBytes), 'output_entry_identity_mismatch');
        const saved = readPrivate(textPath, MAX_BYTES);
        invariant(saved.length === bytes.length && sha256(saved) === facts.sha256, 'output_entry_content_mismatch');
        invariant(identity(directoryStat(entry)) === identity(stat), 'output_entry_changed');
        guard(); return { path: textPath, uri: textPath, sizeBytes: bytes.length, sha256: facts.sha256 };
      };
      guard();
      // lstat also sees dangling links; no entry path is ever replaced or
      // repaired in place. Corruption needs an explicit owner decision.
      let exists = false;
      try { lstatSync(entry); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (exists) return verify();
      const stage = mkdtempSync(join(sessionDirectory, '.stage-'));
      const stageIdentity = identity(directoryStat(stage));
      const stageGuard = () => {
        guard(); invariant(identity(directoryStat(stage)) === stageIdentity, 'output_stage_changed');
      };
      let published = false;
      try {
        writePrivate(join(stage, 'output.txt'), bytes, stageGuard);
        writePrivate(join(stage, 'metadata.json'), metadataBytes, stageGuard);
        syncDirectory(stage); stageGuard();
        try {
          // A competing publication is a nonempty directory. rename cannot
          // replace it: both durable files become visible as a single entry.
          renameSync(stage, entry); published = true;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
          const result = verify(); syncDirectory(sessionDirectory); guard(); return result;
        }
        syncDirectory(sessionDirectory);
        return verify();
      } finally {
        // Delete only THIS writer's staging files. Never delete a published
        // entry when a caller cancels or another writer wins the race.
        if (!published) {
          try {
            if (identity(directoryStat(stage)) === stageIdentity) {
              for (const name of ['output.txt', 'metadata.json']) try { unlinkSync(join(stage, name)); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              rmdirSync(stage);
            }
          } catch { /* An abandoned private stage is not a published entry. */ }
        }
      }
    },
  };
}
