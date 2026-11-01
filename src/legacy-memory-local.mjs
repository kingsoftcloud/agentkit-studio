/** Legacy local LTM keyword semantics, separate from Native profile extraction.
 * No old Python database or randomized candidate hashes are imported.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { invariant, canonical } from '@kingsoftcloud/agentkit-harness-core';
import { privateDirectory, privateFile, createPrivate } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';
import { nativeMemorySensitiveLabels } from '@kingsoftcloud/agentkit-harness-node/native/memory-candidate';

const inode = path => { const stat = lstatSync(path); return `${stat.dev}:${stat.ino}`; };
const sha = value => /^[a-f0-9]{64}$/.test(value);
export function legacyMemoryTokens(text) {
  let cjk = 0, other = 0;
  for (const char of text.trim()) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(char)) cjk += 1.5; else other++;
  }
  return text.trim() ? Math.max(1, Math.floor(cjk) + Math.ceil(other / 4)) : 0;
}

export class LegacyLocalMemory {
  constructor(root, { databasePath = '' } = {}) {
    const volatile = databasePath === ':memory:', filename = databasePath && !volatile ? resolve(databasePath) : join(root, 'local.sqlite');
    root = dirname(filename);
    privateDirectory(root, true); const rootIdentity = inode(root);
    if (!existsSync(filename)) { try { createPrivate(filename); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    privateFile(filename); const fileIdentity = inode(filename);
    let closed = false;
    const guard = () => {
      invariant(!closed, 'legacy_local_memory_closed'); privateDirectory(root); privateFile(filename);
      invariant(inode(root) === rootIdentity && inode(filename) === fileIdentity, 'legacy_local_memory_changed');
      for (const suffix of ['-wal', '-shm', '-journal']) privateFile(filename + suffix, true);
    };
    guard(); const db = new DatabaseSync(volatile ? ':memory:' : filename);
    try { db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS legacy_ltm_facts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS legacy_ltm_by_user ON legacy_ltm_facts(user_id);
      CREATE TABLE IF NOT EXISTS legacy_ltm_receipts (operation TEXT PRIMARY KEY, request TEXT NOT NULL);`); }
    catch (error) { db.close(); throw error; }
    this.close = () => { if (!closed) { closed = true; db.close(); } };
    this.save = ({ id, userId, content, createdAt, operationKey }) => {
      guard(); invariant(typeof id === 'string' && id && typeof userId === 'string' && userId.trim()
        && typeof content === 'string' && content.isWellFormed() && typeof createdAt === 'string' && sha(operationKey),
      'legacy_local_memory_write_invalid');
      // Python flush silently rejects these facts while save_memory returns true.
      // Preserve the rejection, but report it truthfully to the explicit tool.
      invariant(!nativeMemorySensitiveLabels(content).length, 'legacy_memory_content_rejected');
      const request = canonical({ id, userId, content, createdAt });
      db.exec('BEGIN IMMEDIATE');
      try {
        guard(); const previous = db.prepare('SELECT request FROM legacy_ltm_receipts WHERE operation=?').get(operationKey);
        invariant(!previous || previous.request === request, 'legacy_local_memory_identity_conflict');
        if (!previous) {
          db.prepare('INSERT INTO legacy_ltm_facts VALUES(?,?,?,?)').run(id, userId, content, createdAt);
          db.prepare('INSERT INTO legacy_ltm_receipts VALUES(?,?)').run(operationKey, request);
        }
        guard(); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    this.search = ({ userId, query, topK }) => {
      guard(); invariant(typeof userId === 'string' && userId.trim() && typeof query === 'string'
        && Number.isSafeInteger(topK) && topK > 0, 'legacy_local_memory_search_invalid');
      const normalized = query.toLowerCase(), ascii = [...new Set(normalized.match(/[a-z0-9][a-z0-9_.-]+/g) ?? [])].slice(0, 16), cjk = [];
      for (const [run] of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/gu))
        for (let index = 0; index < run.length - 1; index++) cjk.push(run.slice(index, index + 2));
      const terms = ascii.length ? ascii : [...new Set(cjk)].slice(0, 48);
      // LIKE preserves the reference's '_' wildcard behavior for ASCII tokens.
      const predicates = terms.map(() => 'lower(content) LIKE ?').join(ascii.length ? ' AND ' : ' OR ');
      const rows = db.prepare(`SELECT * FROM legacy_ltm_facts WHERE user_id=? ${terms.length ? `AND (${predicates})` : ''}
        ORDER BY created_at DESC,rowid ASC LIMIT ?`).all(userId, ...terms.map(term => `%${term}%`), Math.max(topK, 32));
      const seen = new Set(), selected = []; let tokens = 0;
      for (const row of rows) {
        if (seen.has(row.content)) continue; seen.add(row.content);
        const count = legacyMemoryTokens(row.content); if (tokens + count > 4000) break;
        tokens += count; selected.push(JSON.stringify({ parts: [{ text: row.content }], metadata: { memory_id: row.id } }));
        if (selected.length === topK) break;
      }
      return selected;
    };
  }
}
