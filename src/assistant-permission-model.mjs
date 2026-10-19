/** New assistant workspace authority. Native DSH still owns tools and approval audit. */
import { existsSync, lstatSync, realpathSync, opendirSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { registerAssistantWorkspaceTools } from './assistant-workspace-tools.mjs';

export const ASSISTANT_PERMISSION_PROFILE = 'workspace-managed/v1';
const ROUTINE = Object.freeze(['read', 'read_image', 'write', 'edit', 'glob', 'grep']);
const liveGuards = new WeakMap();
const SENSITIVE = new Set(['external-send', 'payment', 'destructive-delete', 'account-permission']);
const fail = message => Object.assign(new Error(message), { code: 'ASSISTANT_PERMISSION_UNAVAILABLE', status: 503 });
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)); };
const legacy = Object.freeze({ profile: 'legacy-read-only/v1', permission: 'read-only', approval: 'never', managed: false });

function expectedWorkspaceBase(env) {
  if (!env.AGENTKIT_HOME || !env.DSH_HOME) return null;
  const root = dirname(resolve(env.AGENTKIT_HOME));
  return resolve(env.AGENTKIT_HOME) === join(root, 'agentkit') && resolve(env.DSH_HOME) === join(root, 'dsh')
    ? join(root, 'assistant-workspaces') : null;
}

/**
 * Synchronous bootstrap fence, before presets or restored timer work become
 * executable. It grants nothing and performs no filesystem I/O. Agent-scoped
 * denial survives disposal of this installing plugin and is handed off only
 * after the permission model has installed its replacement denial.
 */
export function installAssistantStartupGuard(ctx, env = {}) {
  const base = expectedWorkspaceBase(env);
  if (!base) return () => {};
  const install = agent => {
    const cwd = agent?.session?.header?.cwd;
    if (!agent?.session?.id?.startsWith('assistant-') || typeof cwd !== 'string') return;
    const suffix = relative(base, cwd).split(sep);
    if (suffix.length !== 2 || !/^[a-f0-9]{64}$/.test(suffix[0]) || suffix[1] !== 'files' || cwd !== join(base, ...suffix)) return;
    if (liveGuards.has(agent)) return;
    const tools = agent.ctx?.get('tools');
    if (typeof tools?.guard !== 'function') throw fail('Managed Agent cannot start without a native monotonic guard');
    const release = tools.guard(() => 'Assistant workspace permissions are awaiting trusted Host initialization');
    liveGuards.set(agent, { retire: release });
  };
  const listener = ctx.on('agent/created', ({ agent }) => install(agent));
  const scan = scope => { for (const agent of scope.get('agents')?.list?.() || []) install(agent); };
  scan(ctx); // Already-live services must be fenced synchronously, not next tick.
  if (typeof ctx.inject === 'function') ctx.inject(['tools', 'agents'], scope => { scan(scope); });
  return listener;
}

/** Only an explicit version in a newly authored spec opts in. Missing/unknown versions never migrate old deployments. */
export function selectAssistantPermissionProfile(value) {
  return value === ASSISTANT_PERMISSION_PROFILE ? ASSISTANT_PERMISSION_PROFILE : legacy.profile;
}

function checkedPath(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(input)) return false;
  const target = resolve(root, input);
  if (!inside(root, target) || realpathSync(root) !== root) return false;
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // New assistant tools cannot create links. Reject aliases supplied by an
    // external writer instead of allowing them to borrow workspace authority.
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) return false;
  }
  return true;
}

function checkedSearchTree(root, input) {
  if (!checkedPath(root, input)) return false;
  const pending = [{ path: resolve(root, input), depth: 0 }]; let count = 0;
  while (pending.length) {
    const { path, depth } = pending.pop();
    if (++count > 10000 || depth > 64) return false;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) return false;
    if (info.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (let entry; (entry = directory.readSync()) !== null;) {
          if (count + pending.length >= 10000) return false;
          pending.push({ path: join(path, entry.name), depth: depth + 1 });
        }
      } finally { directory.closeSync(); }
    }
  }
  return true;
}

async function runtimeRoot(env) {
  if (!env.AGENTKIT_HOME || !env.DSH_HOME || !/^[a-f0-9]{64}$/.test(env.AGENTKIT_BUNDLE_SHA256 || '')) return null;
  const root = dirname(resolve(env.AGENTKIT_HOME));
  if (resolve(env.AGENTKIT_HOME) !== join(root, 'agentkit') || resolve(env.DSH_HOME) !== join(root, 'dsh')) return null;
  try {
    const receipt = JSON.parse(await readFile(join(root, '.agentkit-runtime.json'), 'utf8'));
    if (receipt.format !== 'agentkit.runtime-state/v1' || receipt.bundleSha256 !== env.AGENTKIT_BUNDLE_SHA256 || await realpath(root) !== root) return null;
    for (const name of ['agentkit', 'dsh']) {
      const info = await lstat(join(root, name));
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    }
    return root;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Trusted Host composition only: sensitiveTools is an exact tool-definition
 * catalog, never model/client data. Each entry needs name, category and a
 * describe(arguments) function giving the concrete action for one-shot review.
 * This is path containment in a private receipt-owned workspace, not isolation
 * from a hostile process with the same OS identity (see the companion guide).
 */
export async function createAssistantPermissionModel({ ctx, env = {}, profile, agentId, sensitiveTools = [] } = {}) {
  const optedIn = selectAssistantPermissionProfile(profile) === ASSISTANT_PERMISSION_PROFILE;
  const releaseStartup = installAssistantStartupGuard(ctx, env);
  let root = null;
  const expectedRoot = optedIn && env.AGENTKIT_HOME && env.DSH_HOME && /^[a-f0-9]{64}$/.test(env.AGENTKIT_BUNDLE_SHA256 || '')
    ? dirname(resolve(env.AGENTKIT_HOME)) : null;
  const expectedShape = expectedRoot && resolve(env.AGENTKIT_HOME) === join(expectedRoot, 'agentkit') && resolve(env.DSH_HOME) === join(expectedRoot, 'dsh');
  const validation = optedIn ? runtimeRoot(env).then(value => { root = value; }) : Promise.resolve();
  const states = new WeakMap(), staged = new WeakMap(), byId = new Map(), releases = new Set();
  const lifetime = new AbortController();
  let closed = false;
  const base = expectedShape && join(expectedRoot, 'assistant-workspaces');
  const catalog = new Map();
  for (const item of sensitiveTools) {
    if (!item || typeof item.name !== 'string' || !SENSITIVE.has(item.category) || typeof item.describe !== 'function'
      || item.definition?.name !== item.name || typeof item.definition?.execute !== 'function' || ROUTINE.includes(item.name) || ['bash', 'run_code', 'pwsh', 'terminal'].includes(item.name) || catalog.has(item.name)) throw fail('Invalid sensitive tool catalog');
    catalog.set(item.name, { ...item });
  }
  function location(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || typeof agentId !== 'string' || !agentId) throw fail('Workspace owner is missing');
    return join(base, createHash('sha256').update(JSON.stringify([agentId, sessionId])).digest('hex'));
  }
  async function owned(sessionId) {
    if (!root || !base) return null;
    const home = location(sessionId), cwd = join(home, 'files');
    try {
      const ownerPath = join(home, 'owner.json'), ownerInfo = await lstat(ownerPath);
      if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.nlink !== 1 || (ownerInfo.mode & 0o077) !== 0) throw fail('Workspace ownership record is not private');
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (owner.profile !== ASSISTANT_PERMISSION_PROFILE || owner.agentId !== agentId || owner.sessionId !== sessionId || owner.bundleSha256 !== env.AGENTKIT_BUNDLE_SHA256) throw fail('Workspace ownership does not match this deployment');
      for (const path of [base, home, cwd]) {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (info.mode & 0o077) !== 0) throw fail('Workspace must remain a private real directory');
      }
      return cwd;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function newSessionCwd(sessionId) {
    if (closed) throw fail('Assistant permission model is closed');
    if (!optedIn) return undefined;
    if (!root || !base) throw fail('Managed permissions require a receipt-owned isolated runtime');
    const existing = await owned(sessionId);
    if (existing) return existing;
    await mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || await realpath(base) !== base || (baseInfo.mode & 0o077) !== 0) throw fail('Workspace parent is not private');
    // EEXIST is checked below; do not adopt an arbitrary pre-existing cwd.
    return create(sessionId);
  }
  async function create(sessionId) {
    const home = location(sessionId);
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(home, 'files'), { mode: 0o700 });
    await writeFile(join(home, 'owner.json'), JSON.stringify({ profile: ASSISTANT_PERMISSION_PROFILE, agentId, sessionId, bundleSha256: env.AGENTKIT_BUNDLE_SHA256 }) + '\n', { flag: 'wx', mode: 0o600 });
    return owned(sessionId);
  }
  function stage(agent) {
    if (!base || !agent?.session?.id?.startsWith('assistant-')) return null;
    const home = location(agent.session.id);
    if (agent.session.header.cwd !== join(home, 'files') && !existsSync(join(home, 'owner.json'))) return null;
    if (staged.has(agent)) return staged.get(agent);
    const tools = agent.ctx?.get('tools');
    if (typeof tools?.guard !== 'function') throw fail('Native monotonic tool guard is unavailable');
    const state = { ready: false, guard: undefined, pending: undefined };
    const releaseGuard = tools.guard(exec => state.ready ? state.guard(exec) : 'Assistant workspace permissions are not ready');
    const previous = liveGuards.get(agent);
    liveGuards.set(agent, { retire: () => { state.ready = false; state.releaseListener?.(); releaseGuard(); } });
    previous?.retire(); // New denial is installed before retiring the old gate.
    staged.set(agent, state);
    return state;
  }
  async function configure(agent, created) {
    lifetime.signal.throwIfAborted();
    if (!created) return;
    const approval = ctx.get('approval');
    const result = await ctx.get('commands')?.execute(agent, '/permission workspace-write', [], new AbortController().signal);
    if (!result || result.result?.kind === 'error' || ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode !== 'workspace-write'
      || approval.effectivePolicy(agent.session) !== 'ask') throw fail('Native managed permission initialization failed');
  }
  async function ensure(agent, created = false) {
    if (closed) throw fail('Assistant permission model is closed');
    if (!optedIn) return legacy;
    const state = stage(agent);
    await validation; lifetime.signal.throwIfAborted();
    if (state && !root) throw fail('Managed runtime receipt could not be verified');
    if (state?.pending) await state.pending;
    if (states.has(agent)) { if (!state?.ready) throw fail('Managed permission guard is not ready'); await configure(agent, created); return snapshot(agent); }
    if (!state) {
      if (created) throw fail('A new managed Session must use its own provisioned workspace');
      return legacy;
    }
    state.pending = initialize(agent, state);
    try { await state.pending; await configure(agent, created); return snapshot(agent); }
    catch (error) { state.ready = false; throw error; }
    finally { state.pending = undefined; }
  }
  async function initialize(agent, state) {
    const cwd = await owned(agent?.session?.id);
    lifetime.signal.throwIfAborted();
    if (!cwd || agent?.session?.header?.cwd !== cwd) {
      throw fail('Managed workspace ownership cannot be restored');
    }
    const tools = agent.ctx?.get('tools'), approval = ctx.get('approval'), fs = ctx.get('fs'), directory = ctx.get('workingDirectory');
    if (typeof tools?.guard !== 'function' || typeof tools.get !== 'function' || typeof approval?.request !== 'function'
      || typeof approval.effectivePolicy !== 'function' || !['read-only', 'workspace-write'].includes(fs?.sandboxMode)
      || typeof directory?.get !== 'function') throw fail('Native workspace guard services are unavailable');
    const sensitiveCatalog = new Map(catalog);
    for (const item of registerAssistantWorkspaceTools({ agent, workspaceRoot: cwd })) sensitiveCatalog.set(item.name, item);
    for (const item of sensitiveCatalog.values()) if (tools.get(item.name, agent) !== item.definition) throw fail('Sensitive tool definition is not the trusted catalog entry');
    const admitted = new Map([...ROUTINE, ...sensitiveCatalog.keys()].map(name => [name, tools.get(name, agent)]).filter(([, definition]) => definition));
    const grants = new WeakSet(); let disposed = false;
    function decision(exec) {
      if (disposed || exec.agent !== agent || exec.signal?.aborted || directory.get(agent.session) !== cwd || agent.session.header.cwd !== cwd) return 'Assistant workspace ownership changed';
      if (!admitted.has(exec.name) || tools.get(exec.name, agent) !== admitted.get(exec.name)) return 'This tool is not admitted by the assistant workspace policy';
      if (exec.arguments?.sandbox_permissions !== undefined) return 'Sandbox escalation requires a separate supported capability';
      if (sensitiveCatalog.has(exec.name)) return approval.effectivePolicy(agent.session) === 'ask' ? undefined : 'Sensitive approvals are disabled for this session';
      const field = ['glob', 'grep'].includes(exec.name) ? 'path' : 'file_path';
      try {
        const input = exec.arguments?.[field] ?? (field === 'path' ? '.' : undefined);
        if (!(field === 'path' ? checkedSearchTree(cwd, input) : checkedPath(cwd, input))) return 'Path is outside the assistant workspace, uses an unsupported link, or exceeds the bounded search tree';
      }
      catch { return 'Assistant workspace path cannot be verified'; }
      return undefined;
    }
    state.guard = exec => decision(exec) || (sensitiveCatalog.has(exec.name) && !grants.delete(exec) ? 'This sensitive action has no live one-shot approval' : undefined);
    const listener = agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const denied = decision(exec); if (denied) return { kind: 'deny', reason: denied };
      const sensitive = sensitiveCatalog.get(exec.name);
      if (!sensitive) return next();
      let reason;
      try { reason = sensitive.describe(exec.arguments, exec); } catch { /* Incomplete details cannot be approved. */ }
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) return { kind: 'deny', reason: 'Concrete action details are unavailable for approval' };
      const outcome = await approval.request({ agent, toolName: exec.name, callId: exec.callId, reason, signal: AbortSignal.any([exec.signal, lifetime.signal]) });
      if (outcome !== 'allowed-once' || exec.signal.aborted) return { kind: 'deny', reason: 'Sensitive action was not approved for this invocation' };
      grants.add(exec);
      return next();
    }, { prepend: true });
    state.releaseListener = listener;
    const release = () => { disposed = true; state.ready = false; listener(); releases.delete(release); };
    releases.add(release); states.set(agent, { cwd, sensitiveCatalog }); byId.set(agent.session.id, agent);
    state.ready = true;
  }

  function snapshot(value) {
    if (closed && optedIn) return { profile: ASSISTANT_PERMISSION_PROFILE, managed: false, permission: 'unavailable', approval: 'unavailable', status: 'closed' };
    const agent = typeof value === 'string' ? byId.get(value) : value;
    if (!agent || !states.has(agent)) return typeof value === 'string' && optedIn
      ? { profile: ASSISTANT_PERMISSION_PROFILE, managed: false, permission: 'unknown', approval: 'unavailable', status: 'awaiting-session-validation' } : legacy;
    const permission = ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode;
    const approval = ctx.get('approval')?.effectivePolicy(agent.session);
    return { profile: ASSISTANT_PERMISSION_PROFILE, managed: true, permission, approval,
      execution: 'fixed-tool-operations', arbitraryShell: false, network: false,
      sensitiveTools: [...states.get(agent).sensitiveCatalog.keys()].filter(name => agent.ctx.get('tools').get(name, agent)),
      isolation: 'private-runtime-workspace' };
  }
  // The synchronous guard precedes any asynchronous receipt I/O or restored
  // timer work. Disposing this facade leaves denial in place until Agent scope
  // disposal; it never exposes a still-live agent with persisted wider knobs.
  const releaseCreated = base && ctx.on('agent/created', ({ agent }) => {
    if (!stage(agent)) return;
    return ensure(agent).catch(error => { const state = staged.get(agent); if (state) state.ready = false; throw error; });
  });
  const initial = base ? (ctx.get('agents')?.list?.() || []).filter(agent => stage(agent)) : [];
  await validation;
  for (const agent of initial) await ensure(agent);
  return { enabled: optedIn && Boolean(root), newSessionCwd, ensure, snapshot,
    policyOf: agent => snapshot(agent).approval,
    ownsSession: id => { const agent = byId.get(id); return !closed && Boolean(agent && staged.get(agent)?.ready); },
    dispose: () => { closed = true; lifetime.abort(); if (typeof releaseStartup === 'function') releaseStartup(); releaseCreated?.(); for (const release of [...releases]) release(); } };
}
