import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { canonicalEngineWorkspace, HARNESS_SERVICE_MODEL_PROVIDER } from '../../providers/engine-service-workspaces.mjs';
import { modelInput } from '../../model-input.mjs';
import { createStarHarnessReleases, inspectStarHarness, probeStarHarness, startStarHarness, starHarnessError, starHarnessVersion } from './star-harness-release.mjs';
import { compareStarHarnessVersions } from './star-harness-catalog.mjs';

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
const newer = (a, b) => compareStarHarnessVersions(a, b) > 0;
const modelSelection = model => ({ provider: HARNESS_SERVICE_MODEL_PROVIDER, model });

export function createStarHarnessManager({ root, env, externalRoutes, profile, settings, packageManager, workspaceRegistry, modelProfiles = [],
  releases = createStarHarnessReleases({ directory: join(root, 'releases'), env, packageManager }),
  start = startStarHarness, probe = probeStarHarness, inspect = inspectStarHarness } = {}) {
  const configPath = join(root, 'settings.json');
  let configuration = initial, configError, clientError, clientAsset = null, toolCatalog = null;
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
  let mutation, latestVersion = null, releaseCatalog = null, releaseCatalogCheckedAt = -Infinity, registryUnavailable = false, closing;

  async function readAssets(next) {
    if (!next.enabled) return { client: null, toolCatalog: null };
    if (releases.assets) return releases.assets(next.version);
    return { client: await releases.client?.(next.version) ?? null, toolCatalog: null };
  }
  function applyAssets(assets) {
    clientAsset = assets.client;
    toolCatalog = assets.toolCatalog;
  }
  const clientDescriptor = () => clientAsset ? { version: clientAsset.version, sha256: clientAsset.sha256 } : null;
  async function save(next, nextAssets) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, '.settings-' + randomUUID());
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, configPath);
      applyAssets(nextAssets);
      clientError = null;
      configuration = next;
    } finally { await rm(temp, { force: true }); }
  }
  const managedBinding = workspace => configuration.bindings.find(item => item.workspace === workspace);
  const registeredWorkspaces = () => workspaceRegistry?.()?.list?.() ?? [];
  const defaultProfile = profiles => profiles.find(row => row.enabled !== false && row.default)
    ?? profiles.find(row => row.enabled !== false);
  const configuredProfile = id => configuredProfiles.find(row => row.enabled !== false && row.id === id);
  const automaticBinding = workspace => {
    if (!registeredWorkspaces().some(row => row.path === workspace)) return;
    const selected = defaultProfile(configuredProfiles);
    return { workspace, automatic: true, profileId: selected?.id, model: selected?.modelName || 'Star Harness',
      contextWindow: selected?.contextWindow, images: modelInput(selected).includes('image') };
  };
  const bindingFor = workspace => {
    if (leases.has(workspace)) return starting.get(workspace)?.binding ?? workers.get(workspace)?.binding;
    const binding = managedBinding(workspace);
    if (!binding) return automaticBinding(workspace);
    const selected = configuredProfile(binding.profileId);
    return { ...binding, contextWindow: selected?.modelName === binding.model ? selected.contextWindow : undefined };
  };
  const workspaceExists = workspace => typeof workspace === 'string' && canonicalEngineWorkspace(workspace) === workspace;
  const hasConflict = workspace => [...externalRoutes.keys()].some(bound => overlaps(bound, workspace));
  const presentBinding = binding => ({
    workspaceRoot: binding.workspace, modelSelection: modelSelection(binding.model), managed: true,
  });
  async function savedProfile(binding, signal) {
    const selected = await profile(binding.profileId, signal);
    if (selected.modelName !== binding.model && (!binding.automatic || binding.profileId))
      throw starHarnessError('STAR_HARNESS_MODEL_CHANGED', '工作区绑定的模型已变化，请重新绑定后启动。');
    return { ...selected,
      ...(binding.contextWindow !== undefined ? { contextWindow: binding.contextWindow } : {}),
      images: binding.automatic && !binding.profileId ? modelInput(selected).includes('image') : binding.images };
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
    const nextAssets = await readAssets(next);
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
      await save(next, nextAssets);
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
    get toolCatalog() { return toolCatalog && structuredClone(toolCatalog); },
    async restoreClientAsset() {
      try {
        applyAssets(await readAssets(configuration));
        clientError = null;
      }
      catch (error) {
        applyAssets({ client: null, toolCatalog: null });
        clientError = starHarnessError('STAR_HARNESS_RELEASE_INVALID', 'Star Harness 发行签名或文件校验失败，请在插件页安装兼容的签名版本。', { cause: error });
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
      const capabilities = activeBindings().filter(binding => binding.model === model).flatMap(binding => {
        const { automatic, workspace, profileId, images, contextWindow } = binding;
        // A legacy binding without a profile has no known capacity.
        if (!profileId) return [{ images, window: undefined }];
        if (automatic || leases.has(workspace)) return [{ images, window: contextWindow ?? 128000 }];
        // Keep stale bindings visible in settings, but exclude them from the
        // shared catalog entry's capabilities.
        return configuredProfile(profileId)?.modelName === model ? [{ images, window: contextWindow ?? 128000 }] : [];
      });
      // A legacy binding without a profile has no known capacity. Drop it
      // instead of letting `undefined` veto every sibling: one stale binding
      // must not strip the context window from the whole model.
      const windows = capabilities.map(row => row.window).filter(value => value !== undefined);
      return { images: capabilities.some(row => row.images),
        ...(windows.length && windows.every(value => Number.isSafeInteger(value) && value > 0)
          ? { contextWindow: Math.min(...windows) } : {}) };
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
    async status({ checkUpdates = false, includeWorkspaces = true, includeVersions = false, refreshVersions = false } = {}, signal) {
      if (configError) throw configError;
      signal?.throwIfAborted();
      if (checkUpdates && includeWorkspaces) {
        try {
          if (includeVersions) {
            if (refreshVersions === true || registryUnavailable || performance.now() - releaseCatalogCheckedAt >= 300_000) {
              releaseCatalog = await releases.catalog(signal);
              releaseCatalogCheckedAt = performance.now();
            }
            latestVersion = releaseCatalog[0]?.version ?? null;
          } else {
            latestVersion = await releases.latest(signal);
          }
          registryUnavailable = false;
        } catch {
          signal?.throwIfAborted();
          registryUnavailable = true;
        }
      }
      const { version, enabled, previousVersion } = configuration;
      const rollbackVersion = version && previousVersion && newer(version, previousVersion) ? previousVersion : null;
      if (!includeWorkspaces) return { canCreate: Boolean(version && enabled && !clientError) };
      const configuredModels = await settings();
      const external = await Promise.all([...externalRoutes.values()].map(async route => {
        let current;
        try { current = await inspect(route, { signal }); } catch { signal?.throwIfAborted(); }
        return { workspace: route.workspaceRoot, model: route.modelSelection.model, external: true,
          running: Boolean(current), version: current?.version ?? null };
      }));
      return {
        version, enabled, previousVersion, rollbackVersion, registryUnavailable, busy: Boolean(mutation || leases.size),
        clientUI: clientDescriptor(),
        recommendedVersion: latestVersion,
        availableUpgrade: latestVersion && version && newer(latestVersion, version) ? latestVersion : null,
        releaseVersions: releaseCatalog?.map(release => ({
          ...release,
          action: !version ? 'install' : release.version === version ? 'current' : release.version === rollbackVersion
            ? 'rollback' : newer(release.version, version) ? 'upgrade' : 'history',
        })) ?? null,
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
        let previousVersion = current;
        if (current && current !== version && releases.assets) {
          try { await releases.assets(current); }
          catch { guard.throwIfAborted(); previousVersion = null; }
        }
        const next = current === version ? configuration : { ...configuration, version, previousVersion };
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
        const worker = workers.get(cwd);
        if (JSON.stringify(original) === JSON.stringify(binding) && (!configuration.enabled
          || worker?.connection.alive && worker.binding.contextWindow === selected.contextWindow)) return;
        guard.throwIfAborted();
        await workspaceRegistry?.()?.create?.(cwd);
        const live = worker ? [worker.binding] : [];
        const candidates = configuration.enabled ? [{ ...binding, contextWindow: selected.contextWindow }] : [];
        await replaceWorkers(live, candidates, { ...configuration,
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
