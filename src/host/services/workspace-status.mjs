import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
const execute = promisify(execFile);
const sum = output => {
  const records = output.split('\0'), total = { added: 0, removed: 0 };
  for (let index = 0; index < records.length; index++) {
    const row = records[index]; if (!row) continue;
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw Error('invalid_git_numstat');
    const added = row.slice(0, first), removed = row.slice(first + 1, second);
    // -z represents differing old/new paths as two following NUL records,
    // including --no-index additions from /dev/null.
    if (!row.slice(second + 1)) { if (!records[index + 1] || !records[index + 2]) throw Error('invalid_git_numstat'); index += 2; }
    if (added === '-' || removed === '-') continue;
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw Error('invalid_git_numstat');
    total.added += Number(added); total.removed += Number(removed);
    if (!Number.isSafeInteger(total.added) || !Number.isSafeInteger(total.removed)) throw Error('invalid_git_numstat');
  }
  return total;
};

/** Bounded read-only Git facts. No credentials, contents, index writes or mutation actions. */
export function createWorkspaceGitStatus({ workspaceRoot, now = Date.now, ttlMs = 10000, lifetimeSignal, onError = () => {} } = {}) {
  let cached, expires = 0, pending;
  const root = resolve(workspaceRoot);
  const read = async signal => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' });
    const prefix = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
    const run = async (args, allowed = [0]) => {
      try { return (await execute('git', [...prefix, ...args], { cwd: root, env, signal, timeout: 2500, maxBuffer: 512 * 1024, encoding: 'utf8' })).stdout; }
      catch (error) { if (allowed.includes(error.code) && typeof error.stdout === 'string') return error.stdout; throw error; }
    };
    let repo;
    try { repo = (await run(['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) { if (error.code === 128 && /not a git repository/.test(error.stderr ?? '')) return { state: 'not_repository', git: null }; throw error; }
    // A status observation must not execute repository-defined clean/process filters.
    const filters = await run(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge|required)$'], [0, 1]);
    for (const key of filters.split('\0').filter(Boolean)) prefix.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    const branchName = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1])).trim() || null;
    const status = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
    const untracked = []; let dirtyFileCount = 0;
    for (let i = 0; i < status.length; i++) {
      const row = status[i]; if (!row) continue;
      dirtyFileCount++;
      if (row.startsWith('?? ')) untracked.push(row.slice(3));
      if (/^[RC]|^.[RC]/.test(row.slice(0, 2))) i++;
    }
    if (untracked.length > 128) return { state: 'unavailable', reason: 'untracked_file_limit', git: null };
    let head;
    try { head = (await run(['rev-parse', '--verify', 'HEAD'])).trim(); }
    catch (error) { if (error.code !== 128) throw error; head = (await run(['hash-object', '-t', 'tree', '/dev/null'])).trim(); }
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw Error('invalid_git_head');
    let counts = sum(await run(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', head, '--']));
    for (const path of untracked) {
      signal.throwIfAborted();
      const absolute = resolve(repo, path), rel = relative(repo, absolute);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error('invalid_git_path');
      const next = sum(await run(['diff', '--no-index', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--', '/dev/null', absolute], [0, 1]));
      counts.added += next.added; counts.removed += next.removed;
    }
    return { state: 'available', git: { branchName, dirtyFileCount, ...counts } };
  };
  return {
    async read(signal) {
      lifetimeSignal?.throwIfAborted();
      signal?.throwIfAborted();
      if (cached && now() < expires) return structuredClone(cached);
      if (!pending) {
        const timeout = lifetimeSignal ? AbortSignal.any([lifetimeSignal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
        pending = read(timeout).catch(error => { try { onError(error); } catch {} return { state: 'unavailable', git: null }; }).then(value => {
          cached = value; expires = now() + ttlMs; return value;
        }).finally(() => { pending = undefined; });
      }
      const value = await pending; signal?.throwIfAborted(); lifetimeSignal?.throwIfAborted(); return structuredClone(value);
    },
  };
}
