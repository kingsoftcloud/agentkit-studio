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
  unbound: () => starHarnessError('NATIVE_ENGINE_WORKSPACE_UNAVAILABLE', '请启用 Star Harness 并在 Studio 中选择该工作区。'),
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

export function createStarHarnessManager({ root, env, externalRoutes, profile, settings, bundledVersion, packageManager, workspaceRegistry, modelProfiles = [],
  releases = createStarHarnessReleases({ directory: join(root, 'releases'), env, packageManager }),
  start = startStarHarness, probe = probeStarHarness, inspect = inspectStarHarness } = {}) {
  const configPath = join(root, 'settings.json');
  let configuration = initial, configError, clientError, clientAsset = null;
  try {
    const found = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!(found.version === null && found.enabled === false || starHarnessVersion(found.version))
      || !(found.previousVersion === null || starHarnessVersion(found.previousVersion)) || typeof found.enabled !== 'boolean'
      || !Array.isArray(found.bindings) || found.bindings.some(row => !row || !isAbsolute(row.workspace)
        || typeof row.profileId !== 'string' || typeof row.model !== 'string' || !row.model || typeof row.images !== 'boolean')) throw codes.invalid();
    configuration = found;
  } catch (error) {
    if (error.code !== 'ENOENT') configError = starHarnessError('STAR_HARNESS_CONFIG_INVALID', 'Star Harness 的本地设置无法读取。');
  }
  const workers = new Map(), starting = new Map(), leases = new Map();
  let configuredProfiles = modelProfiles;
  const lifetime = new AbortController();
  let mutation, latestVersion = null, closing;

  const readClient = next => next.enabled ? releases.client?.(next.version) ?? null : null;
  const clientDescriptor = () => clientAsset ? { version: clientAsset.version, sha256: clientAsset.sha256 } : null;
  async function save(next, nextAsset = clientAsset) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, '.settings-' + randomUUID());
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, configPath);
      clientAsset = nextAsset;
      clientError = null;
      configuration = next;
    } finally { await rm(temp, { force: true }); }
  }
  const managedBinding = workspace => configuration.bindings.find(item => item.workspace === workspace);
  const registeredWorkspaces = () => workspaceRegistry?.()?.list?.() ?? [];
  const defaultProfile = profiles => profiles.find(row => row.enabled !== false && row.default)
    ?? profiles.find(row => row.enabled !== false);
  const automaticBinding = workspace => {
    if (!registeredWorkspaces().some(row => row.path === workspace)) return;
    if (leases.has(workspace)) return starting.get(workspace)?.binding ?? workers.get(workspace)?.binding;
    const selected = defaultProfile(configuredProfiles);
    return { workspace, automatic: true, profileId: selected?.id, model: selected?.modelName || 'Star Harness',
      contextWindow: selected?.contextWindow, images: modelInput(selected).includes('image') };
  };
  const bindingFor = workspace => managedBinding(workspace) ?? automaticBinding(workspace);
  const workspaceExists = workspace => typeof workspace === 'string' && canonicalEngineWorkspace(workspace) === workspace;
  const hasConflict = workspace => [...externalRoutes.keys()].some(bound => overlaps(bound, workspace));
  const presentBinding = binding => ({
    workspaceRoot: binding.workspace, modelSelection: modelSelection(binding.model), managed: true,
  });
  async function savedProfile(binding, signal) {
    const selected = await profile(binding.profileId, signal);
    if (selected.modelName !== binding.model && (!binding.automatic || binding.profileId))
      throw starHarnessError('STAR_HARNESS_MODEL_CHANGED', '工作区绑定的模型已变化，请重新绑定后启动。');
    return { ...selected, images: binding.automatic && !binding.profileId ? modelInput(selected).includes('image') : binding.images };
  }
  function ownWorker(binding, connection) {
    workers.set(binding.workspace, { binding, connection });
    return connection;
  }
  async function boot(binding, version, signal) {
    if (!workspaceExists(binding.workspace)) throw codes.unbound();
    if (hasConflict(binding.workspace))
      throw starHarnessError('STAR_HARNESS_WORKSPACE_CONFLICT', '该目录已被外部 Harness 或重叠的工作区使用。');
    const packageDirectory = await releases.entry(version);
    const stateDir = join(root, 'state', createHash('sha256').update(binding.workspace).digest('hex'));
    return start({ packageDirectory, version, workspaceRoot: binding.workspace, stateDir,
      profile: await savedProfile(binding, signal), env, signal });
  }
  async function stop(workspace) {
    const connection = workers.get(workspace)?.connection;
    if (!connection) return;
    await connection.stop();
    workers.delete(workspace);
  }
  function ensureWorker(binding) {
    const existing = workers.get(binding.workspace);
    const pending = starting.get(binding.workspace);
    if (pending) return pending.result;
    if (existing?.connection.alive && existing.binding.profileId === binding.profileId && existing.binding.model === binding.model
      && existing.binding.images === binding.images && existing.binding.contextWindow === binding.contextWindow)
      return Promise.resolve(existing.connection);
    const result = (async () => {
      await stop(binding.workspace);
      return ownWorker(binding, await boot(binding, configuration.version, lifetime.signal));
    })().finally(() => starting.delete(binding.workspace));
    starting.set(binding.workspace, { binding, result });
    return result;
  }
  async function replaceWorkers(before, after, next, signal) {
    // A workspace ledger has one writer. The new worker takes over only after
    // the old one has stopped. Restore its previous version if cutover fails.
    const nextAsset = await readClient(next);
    const stopped = [], started = [];
    try {
      for (const binding of before) {
        await stop(binding.workspace);
        stopped.push(binding);
      }
      for (const binding of after) {
        ownWorker(binding, await boot(binding, next.version, signal));
        started.push(binding);
      }
      signal.throwIfAborted();
      await save(next, nextAsset);
    } catch (error) {
      await Promise.allSettled(started.map(binding => stop(binding.workspace)));
      if (!lifetime.signal.aborted) await Promise.allSettled(stopped.filter(binding => available(binding.workspace) && bindingFor(binding.workspace)).map(async binding => {
        ownWorker(binding, await boot(binding, configuration.version, lifetime.signal));
      }));
      throw error;
    }
  }
  const mutate = (operation, signal) => {
    if (lifetime.signal.aborted) throw codes.closed();
    if (configError) throw configError;
    if (mutation || leases.size) throw codes.busy();
    const combined = AbortSignal.any([signal, lifetime.signal].filter(Boolean));
    const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined); });
    mutation = pending;
    return pending.finally(() => { if (mutation === pending) mutation = null; });
  };
  const available = workspace => workspaceExists(workspace) && !overlaps(root, workspace) && !hasConflict(workspace);
  const route = workspace => {
    if (clientError || !configuration.enabled || !available(workspace)) return;
    const binding = bindingFor(workspace);
    return binding && presentBinding(binding);
  };
  const availableBindings = () => [...new Set([
    ...configuration.bindings.map(row => row.workspace), ...registeredWorkspaces().map(row => row.path),
  ])].filter(available).map(bindingFor);
  const activeBindings = () => configuration.enabled && !clientError ? availableBindings() : [];

  return {
    get enabled() { return configuration.enabled; },
    get clientAsset() { return clientAsset; },
    async restoreClientAsset() {
      try { clientAsset = await readClient(configuration); }
      catch (error) {
        clientError = starHarnessError('STAR_HARNESS_RELEASE_INVALID', 'Star Harness 前端校验失败，请重新安装当前版本。', { cause: error });
        throw clientError;
      }
    },
    get routes() { return activeBindings().map(presentBinding); },
    route,
    refreshModelProfiles(profiles) { configuredProfiles = profiles; },
    summaryProfile(workspace, model) {
      if (!route(workspace)) return undefined;
      const binding = bindingFor(workspace);
      const profiles = configuredProfiles.filter(item => item.enabled !== false && item.modelName === model);
      if (binding.model === model && binding.profileId) return profiles.find(item => item.id === binding.profileId);
      return profiles.length === 1 ? profiles[0] : undefined;
    },
    modelInfo(model) {
      const bindings = activeBindings().filter(row => row.model === model);
      if (!bindings.length) return { images: false };
      const windows = bindings.map(binding => {
        if (binding.automatic && binding.profileId) return binding.contextWindow ?? 128000;
        const selected = configuredProfiles.find(row => row.enabled !== false && row.id === binding.profileId);
        // The worker uses the same profile and defaults to 128,000 tokens
        // when its provider window has not been configured.
        return selected?.modelName === model ? selected.contextWindow ?? 128000 : undefined;
      });
      // The desktop catalog has one entry even when several workspaces bind
      // the same model name through different providers.
      return { images: bindings.some(row => row.images),
        ...(windows.every(value => Number.isSafeInteger(value) && value > 0) ? { contextWindow: Math.min(...windows) } : {}) };
    },
    async acquire(workspace) {
      if (mutation) throw codes.busy();
      if (lifetime.signal.aborted) throw codes.closed();
      const binding = bindingFor(workspace);
      if (clientError) throw clientError;
      if (!route(workspace)) throw codes.unbound();
      leases.set(workspace, (leases.get(workspace) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const remaining = leases.get(workspace) - 1;
        if (remaining) leases.set(workspace, remaining);
        else leases.delete(workspace);
      };
      try { return { connection: await ensureWorker(binding), release }; }
      catch (error) { release(); throw error; }
    },
    async status({ checkUpdates = false, includeWorkspaces = true } = {}, signal) {
      if (configError) throw configError;
      let registryUnavailable = false;
      if (checkUpdates) {
        try { latestVersion = await releases.latest(signal); }
        catch { signal?.throwIfAborted(); latestVersion = null; registryUnavailable = true; }
      }
      const { version, enabled, previousVersion } = configuration;
      const recommendedVersion = starHarnessVersion(bundledVersion) && (!latestVersion || newer(bundledVersion, latestVersion))
        ? bundledVersion : latestVersion;
      if (!includeWorkspaces) return { canCreate: Boolean(version && enabled && !clientError) };
      const configuredModels = await settings();
      const external = await Promise.all([...externalRoutes.values()].map(async route => {
        let current;
        try { current = await inspect(route, { signal }); } catch { signal?.throwIfAborted(); }
        return { workspace: route.workspaceRoot, model: route.modelSelection.model, external: true,
          running: Boolean(current), version: current?.version ?? null };
      }));
      return {
        version, enabled, previousVersion, registryUnavailable, busy: Boolean(mutation || leases.size), clientUI: clientDescriptor(),
        recommendedVersion,
        availableUpgrade: recommendedVersion && version && newer(recommendedVersion, version) ? recommendedVersion : null,
        canCreate: Boolean(version && enabled && !clientError), repairNeeded: Boolean(clientError),
        workspaceChoices: (workspaceRegistry?.()?.list?.() ?? []).map(({ path, title }) => ({ path, title })),
        models: (configuredModels.modelProfiles ?? []).filter(item => item.enabled !== false).map(item => ({
          id: item.id, label: item.displayName || item.modelName || item.id,
        })),
        workspaces: [...external, ...[
          ...availableBindings(), ...configuration.bindings.filter(binding => !available(binding.workspace)),
        ].map(binding => ({
          workspace: binding.workspace, model: binding.model, profileId: binding.profileId, external: false,
          missing: !workspaceExists(binding.workspace), running: workers.get(binding.workspace)?.connection.alive === true,
          version: enabled ? version : null,
        }))],
      };
    },
    install(version, signal) {
      return mutate(async guard => {
        if (!starHarnessVersion(version)) throw codes.invalid();
        const current = configuration.version;
        if (current && version !== current && version !== configuration.previousVersion && !newer(version, current))
          throw starHarnessError('STAR_HARNESS_VERSION_UNSUPPORTED', '请选择新版，或回退到上次使用的版本。');
        await mkdir(root, { recursive: true, mode: 0o700 });
        const packageDirectory = await releases.install(version, guard);
        await probe({ root, packageDirectory, version, env, signal: guard });
        if (current === version && !clientError) return;
        const next = current === version ? configuration : { ...configuration, version, previousVersion: current };
        const live = [...workers.values()].map(row => row.binding);
        await replaceWorkers(live, live.map(({ workspace }) => available(workspace) && bindingFor(workspace)).filter(Boolean), next, guard);
      }, signal);
    },
    setEnabled(enabled, signal) {
      return mutate(async guard => {
        if (typeof enabled !== 'boolean') throw codes.invalid();
        if (!configuration.version) throw codes.notInstalled();
        if (configuration.enabled === enabled) return;
        const candidates = enabled ? availableBindings() : [];
        if (enabled && !candidates.length && !externalRoutes.size) throw codes.unbound();
        const live = [...workers.values()].map(row => row.binding);
        await replaceWorkers(live, candidates, { ...configuration, enabled }, guard);
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
        if (JSON.stringify(original) === JSON.stringify(binding) && (!configuration.enabled || workers.get(cwd)?.connection.alive)) return;
        guard.throwIfAborted();
        await workspaceRegistry?.()?.create?.(cwd);
        const previousWorker = workers.get(cwd)?.binding;
        const live = previousWorker ? [previousWorker] : [];
        await replaceWorkers(live, configuration.enabled ? [binding] : [], { ...configuration,
          bindings: [...configuration.bindings.filter(row => row.workspace !== cwd), binding] }, guard);
      }, signal);
    },
    unbind(workspace, signal) {
      return mutate(async guard => {
        if (typeof workspace !== 'string') throw codes.invalid();
        const binding = managedBinding(workspace);
        if (!binding) throw codes.unbound();
        const previousWorker = workers.get(workspace)?.binding;
        await replaceWorkers(previousWorker ? [previousWorker] : [], [], {
          ...configuration, bindings: configuration.bindings.filter(row => row !== binding),
        }, guard);
      }, signal);
    },
    close() {
      lifetime.abort();
      return closing ??= (async () => {
        await Promise.allSettled([mutation, ...[...starting.values()].map(item => item.result)]);
        await Promise.allSettled([...workers.keys()].map(stop));
      })();
    },
  };
}
