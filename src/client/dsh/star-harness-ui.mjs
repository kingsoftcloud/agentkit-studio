const changes = 'agentkit-studio:star-harness-ui';
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Only accept a fingerprinted asset from Studio's authenticated, local Host.
export async function loadStarHarnessUI(descriptor, importModule = url => import(url)) {
  if (descriptor == null) return null;
  const { version, sha256 } = descriptor;
  if (typeof version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)
    || !validDigest(sha256))
    throw Error('Star Harness UI 发布描述无效。');
  const module = await importModule('/api/agentkit.star-harness.client.mjs?sha256=' + sha256);
  if (module?.contract !== 'agentkit.studio-harness-ui/v1' || module.version !== version
    || typeof module.installTaskTimeline !== 'function' || typeof module.createNativeChildPanel !== 'function')
    throw Error('Star Harness UI 与当前 Studio 不兼容。');
  return module;
}

export function watchStarHarnessUI(window) {
  if (!window.BroadcastChannel) return () => {};
  const channel = new window.BroadcastChannel(changes);
  const loaded = window.__AGENTKIT_STUDIO__?.starHarnessUI?.sha256 ?? null;
  channel.onmessage = ({ data }) => {
    if ((data === null || validDigest(data)) && data !== loaded) window.location.reload();
  };
  return () => channel.close();
}

export function refreshStarHarnessUI(window, descriptor, repair) {
  const loaded = window.__AGENTKIT_STUDIO__?.starHarnessUI?.sha256 ?? null;
  const next = descriptor?.sha256 ?? null;
  if (loaded === next && !repair) return;
  if (window.BroadcastChannel) {
    const channel = new window.BroadcastChannel(changes);
    channel.postMessage(next);
    channel.close();
  }
  window.location?.reload?.();
}
