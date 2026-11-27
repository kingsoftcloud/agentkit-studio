const changes = 'agentkit-studio:star-harness-ui';
const clientPath = '/api/agentkit.star-harness.client.mjs';
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function readStarHarnessUIDescriptor(fetchImpl = fetch) {
  // Desktop's boot IPC replays its initial index injections on renderer reload.
  // The authenticated route reads the release that the Host has activated now.
  const response = await fetchImpl(clientPath + '?descriptor=1', {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('无法读取 StarOrigin Harness UI 发布信息。');
  return response.json();
}

export async function loadActiveStarHarnessUI({ fetchImpl = fetch, importModule } = {}) {
  const descriptor = await readStarHarnessUIDescriptor(fetchImpl);
  try {
    return { descriptor, module: await loadStarHarnessUI(descriptor, importModule) };
  } catch (error) {
    // A second window may activate a different signed release between reading
    // the descriptor and importing its asset. Keep a stable error when it did not.
    const current = await readStarHarnessUIDescriptor(fetchImpl);
    if ((current?.sha256 ?? null) === (descriptor?.sha256 ?? null)) throw error;
    return { descriptor: current, module: await loadStarHarnessUI(current, importModule) };
  }
}

// Only accept a fingerprinted asset from Studio's authenticated, local Host.
export async function loadStarHarnessUI(descriptor, importModule = url => import(url)) {
  if (descriptor == null) return null;
  const { version, sha256 } = descriptor;
  if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)
    || !validDigest(sha256))
    throw Error('StarOrigin Harness UI 发布描述无效。');
  const module = await importModule(clientPath + '?sha256=' + sha256);
  if (module?.contract !== 'agentkit.studio-harness-ui/v1' || module.version !== version
    || typeof module.installTaskTimeline !== 'function' || typeof module.createNativeChildPanel !== 'function')
    throw Error('StarOrigin Harness UI 与当前 Studio 不兼容。');
  return module;
}

export function watchStarHarnessUI(window, descriptor) {
  if (!window.BroadcastChannel) return () => {};
  const channel = new window.BroadcastChannel(changes);
  const loaded = descriptor?.sha256 ?? null;
  channel.onmessage = ({ data }) => {
    if ((data === null || validDigest(data)) && data !== loaded) window.location.reload();
  };
  return () => channel.close();
}

export function refreshStarHarnessUI(window, current, descriptor, repair) {
  const loaded = current?.sha256 ?? null;
  const next = descriptor?.sha256 ?? null;
  if (loaded === next && !repair) return;
  if (window.BroadcastChannel) {
    const channel = new window.BroadcastChannel(changes);
    channel.postMessage(next);
    channel.close();
  }
  window.location?.reload?.();
}
