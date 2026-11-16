import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { canonicalEngineWorkspace, HARNESS_SERVICE_MODEL_PROVIDER } from '../../providers/engine-service-workspaces.mjs';
import { modelInput } from '../../model-service.mjs';
import { createStarHarnessReleases, inspectStarHarness, probeStarHarness, startStarHarness, starHarnessError, starHarnessVersion } from './star-harness-release.mjs';

const initial = { version: null, previousVersion: null, enabled: false, bindings: [] };
const codes = {
  busy: () => starHarnessError('STAR_HARNESS_BUSY', 'Star Harness 正在运行任务或应用变更，请稍后重试。'),
  closed: () => starHarnessError('STAR_HARNESS_CLOSED', 'Star Harness 管理服务已关闭。'),
  invalid: () => starHarnessError('STAR_HARNESS_INVALID_REQUEST', 'Star Harness 操作参数无效。'),
  notInstalled: () => starHarnessError('STAR_HARNESS_NOT_INSTALLED', '请先安装 Star Harness。'),
  unbound: () => starHarnessError('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '请先为该工作区绑定并启用 Star Harness。'),
};
const contains = (parent, child) => {
  const offset = relative(parent, child);
  return !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep);
};
const overlaps = (a, b) => contains(a, b) || contains(b, a);
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x[0] > y[0] || x[0] === y[0] && (x[1] > y[1] || x[1] === y[1] && x[2] > y[2]);
};
const modelSelection = model => ({ provider: HARNESS_SERVICE_MODEL_PROVIDER, model });

export function createStarHarnessManager({ root, env, externalRoutes, profile, settings, bundledVersion, packageManager, workspaceRegistry,
  releases = createStarHarnessReleases({ directory: join(root, 'releases'), env, packageManager }),
  start = startStarHarness, probe = probeStarHarness, inspect = inspectStarHarness } = {}) {
  const configPath = join(root, 'settings.json');
  let configuration = initial, configError;
  try {
    const found = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!(found.version === null || starHarnessVersion(found.version))
      || !(found.previousVersion === null || starHarnessVersion(found.previousVersion)) || typeof found.enabled !== 'boolean'
      || !Array.isArray(found.bindings) || found.bindings.some(row => !row || !isAbsolute(row.workspace)
        || typeof row.profileId !== 'string' || typeof row.model !== 'string' || !row.model || typeof row.images !== 'boolean')) throw codes.invalid();
    configuration = found;
  } catch (error) {
    if (error.code !== 'ENOENT') configError = starHarnessError('STAR_HARNESS_CONFIG_INVALID', 'Star Harness 的本地设置无法读取。');
  }
  const workers = new Map(), starting = new Map();
  const lifetime = new AbortController();
  let running = 0, mutation, latestVersion = null, closing;

  async function save(next) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, '.settings-' + randomUUID());
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, configPath);
      configuration = next;
    } finally { await rm(temp, { force: true }); }
  }
  const managedBinding = workspace => configuration.bindings.find(item => item.workspace === workspace);
  const hasConflict = workspace => [...externalRoutes.keys()].some(bound => overlaps(bound, workspace));
  const presentBinding = binding => ({
    workspaceRoot: binding.workspace, modelSelection: modelSelection(binding.model), managed: true,
  });
  async function savedProfile(binding, signal) {
    const selected = await profile(binding.profileId, signal);
    if (selected.modelName !== binding.model)
      throw starHarnessError('STAR_HARNESS_MODEL_CHANGED', '工作区绑定的模型已变化，请重新绑定后启动。');
    return { ...selected, images: binding.images };
  }
  async function boot(binding, version, signal) {
    if (hasConflict(binding.workspace))
      throw starHarnessError('STAR_HARNESS_WORKSPACE_CONFLICT', '该目录已被外部 Harness 或重叠的工作区使用。');
    const packageDirectory = await releases.entry(version);
    const stateDir = join(root, 'state', createHash('sha256').update(binding.workspace).digest('hex'));
    return start({ packageDirectory, version, workspaceRoot: binding.workspace, stateDir,
      profile: await savedProfile(binding, signal), env, signal });
  }
  async function stop(workspace) {
    const worker = workers.get(workspace);
    if (!worker) return;
    await worker.stop();
    workers.delete(workspace);
  }
  function ensureWorker(binding) {
    const existing = workers.get(binding.workspace);
    if (existing?.alive) return Promise.resolve(existing);
    if (!starting.has(binding.workspace)) {
      const spawned = boot(binding, configuration.version, lifetime.signal).then(worker => {
        workers.set(binding.workspace, worker);
        return worker;
      }).finally(() => starting.delete(binding.workspace));
      starting.set(binding.workspace, spawned);
    }
    return starting.get(binding.workspace);
  }
  async function replaceWorkers(before, after, next, signal) {
    // A workspace ledger has one writer. The new worker takes over only after
    // the old one has stopped. Restore its previous version if cutover fails.
    const stopped = [], started = [];
    try {
      for (const binding of before) {
        await stop(binding.workspace);
        stopped.push(binding);
      }
      for (const binding of after) {
        const worker = await boot(binding, next.version, signal);
        workers.set(binding.workspace, worker);
        started.push(binding);
      }
      signal.throwIfAborted();
      await save(next);
    } catch (error) {
      await Promise.allSettled(started.map(binding => stop(binding.workspace)));
      if (!lifetime.signal.aborted) await Promise.allSettled(stopped.map(async binding => {
        workers.set(binding.workspace, await boot(binding, configuration.version, lifetime.signal));
      }));
      throw error;
    }
  }
  const mutate = (operation, signal) => {
    if (lifetime.signal.aborted) throw codes.closed();
    if (configError) throw configError;
    if (mutation || running) throw codes.busy();
    const combined = AbortSignal.any([signal, lifetime.signal].filter(Boolean));
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined); });
    mutation = pending;
    return pending.finally(() => { if (mutation === pending) mutation = null; });
  };
  const route = workspace => {
    const binding = managedBinding(workspace);
    return configuration.enabled && binding && !hasConflict(workspace) ? presentBinding(binding) : undefined;
  };
  const activeBindings = () => configuration.enabled ? configuration.bindings.filter(row => !hasConflict(row.workspace)) : [];

  return {
    get enabled() { return configuration.enabled; },
    get routes() { return activeBindings().map(presentBinding); },
    route,
    modelInfo(model) { return { images: activeBindings().some(row => row.model === model && row.images) }; },
    async acquire(workspace) {
      if (mutation) throw codes.busy();
      if (lifetime.signal.aborted) throw codes.closed();
      const binding = managedBinding(workspace);
      if (!route(workspace)) throw codes.unbound();
      running++;
      let released = false;
      const release = () => { if (!released) { released = true; running--; } };
      try { return { connection: await ensureWorker(binding), release }; }
      catch (error) { release(); throw error; }
    },
    async status({ checkUpdates = false, includeWorkspaces = true } = {}, signal) {
      if (configError) throw configError;
      let registryUnavailable = false;
      if (checkUpdates) {
        try { latestVersion = await releases.latest(signal); }
        catch { signal?.throwIfAborted(); registryUnavailable = true; }
      }
      const { version, enabled, previousVersion } = configuration;
      const hasWorkspace = activeBindings().length > 0 || externalRoutes.size > 0;
      if (!includeWorkspaces) return { canCreate: Boolean(version && enabled && hasWorkspace) };
      const configuredModels = await settings();
      const external = await Promise.all([...externalRoutes.values()].map(async route => {
        let current;
        try { current = await inspect(route, { signal }); } catch { signal?.throwIfAborted(); }
        return { workspace: route.workspaceRoot, model: route.modelSelection.model, external: true,
          running: Boolean(current), version: current?.version ?? null };
      }));
      return {
        version, enabled, previousVersion, registryUnavailable, busy: Boolean(mutation || running),
        recommendedVersion: latestVersion || bundledVersion,
        availableUpgrade: latestVersion && version && newer(latestVersion, version) ? latestVersion : null,
        canCreate: Boolean(version && enabled && hasWorkspace),
        workspaceChoices: (workspaceRegistry?.()?.list?.() ?? []).map(({ path, title }) => ({ path, title })),
        models: (configuredModels.modelProfiles ?? []).filter(item => item.enabled !== false).map(item => ({
          id: item.id, label: item.displayName || item.modelName || item.id,
        })),
        workspaces: [...external, ...configuration.bindings.map(binding => ({
          workspace: binding.workspace, model: binding.model, profileId: binding.profileId, external: false,
          running: workers.get(binding.workspace)?.alive === true, version: enabled ? version : null,
        }))],
      };
    },
    install(version, signal) {
      return mutate(async guard => {
        if (!starHarnessVersion(version)) throw codes.invalid();
        const current = configuration.version;
        if (current === version) return;
        if (current && version !== configuration.previousVersion && !newer(version, current))
          throw starHarnessError('STAR_HARNESS_VERSION_UNSUPPORTED', '请选择新版，或回退到上次使用的版本。');
        await mkdir(root, { recursive: true, mode: 0o700 });
        const packageDirectory = await releases.install(version, guard);
        await probe({ root, packageDirectory, version, env, signal: guard });
        const next = { ...configuration, version, previousVersion: current };
        const live = activeBindings().filter(binding => workers.get(binding.workspace)?.alive);
        await replaceWorkers(live, live, next, guard);
      }, signal);
    },
    setEnabled(enabled, signal) {
      return mutate(async guard => {
        if (typeof enabled !== 'boolean') throw codes.invalid();
        if (!configuration.version) throw codes.notInstalled();
        if (configuration.enabled === enabled) return;
        const candidates = configuration.bindings.filter(binding => !hasConflict(binding.workspace));
        if (enabled && !candidates.length && !externalRoutes.size) throw codes.unbound();
        const live = candidates.filter(binding => workers.get(binding.workspace)?.alive);
        await replaceWorkers(live, enabled ? candidates : [], { ...configuration, enabled }, guard);
      }, signal);
    },
    bind(workspace, profileId, signal) {
      return mutate(async guard => {
        if (!configuration.version) throw codes.notInstalled();
        const cwd = canonicalEngineWorkspace(workspace);
        if (!cwd || typeof profileId !== 'string' || profileId.length > 128) throw codes.invalid();
        if (hasConflict(cwd) || overlaps(root, cwd) || configuration.bindings.some(row => row.workspace !== cwd && overlaps(row.workspace, cwd)))
          throw starHarnessError('STAR_HARNESS_WORKSPACE_CONFLICT', '工作区不能与已有绑定或 Star Harness 状态目录重叠。');
        const available = (await settings()).modelProfiles ?? [];
        if (profileId && !available.some(item => item.id === profileId && item.enabled !== false)) throw codes.invalid();
        const selected = await profile(profileId, guard);
        const binding = { workspace: cwd, profileId: selected.id || profileId, model: selected.modelName,
          images: modelInput(selected).includes('image') };
        const original = managedBinding(cwd);
        if (JSON.stringify(original) === JSON.stringify(binding) && (!configuration.enabled || workers.get(cwd)?.alive)) return;
        guard.throwIfAborted();
        await workspaceRegistry?.()?.create?.(cwd);
        const live = original && workers.get(cwd)?.alive ? [original] : [];
        await replaceWorkers(live, configuration.enabled ? [binding] : [], { ...configuration,
          bindings: [...configuration.bindings.filter(row => row.workspace !== cwd), binding] }, guard);
      }, signal);
    },
    unbind(workspace, signal) {
      return mutate(async guard => {
        if (typeof workspace !== 'string') throw codes.invalid();
        const binding = managedBinding(workspace);
        if (!binding) throw codes.unbound();
        await replaceWorkers(workers.get(workspace)?.alive ? [binding] : [], [], {
          ...configuration, bindings: configuration.bindings.filter(row => row !== binding),
        }, guard);
      }, signal);
    },
    close() {
      lifetime.abort();
      return closing ??= (async () => {
        await Promise.allSettled([mutation, ...starting.values()]);
        await Promise.allSettled([...workers.keys()].map(stop));
      })();
    },
  };
}
