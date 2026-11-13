import { installTaskTimeline as install } from '@kingsoftcloud/agentkit-harness-ui/host/task-timeline';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';
import { HARNESS_SERVICE_PRESET_SUFFIX } from '../../harness-service-preset.mjs';

const deliveryUrl = params => 'api/agentkit.native-web-delivery?' + new URLSearchParams(params);

async function loadDeliveryEvidence(sessionId, seq, signal) {
  const response = await fetch(deliveryUrl({ sessionId, seq, mode: 'summary' }), { credentials: 'same-origin', signal });
  if (!response.ok) return null;
  const evidence = await response.json();
  return { ...evidence, screenshots: evidence.screenshots.map(path => ({
    path, href: deliveryUrl({ sessionId, seq, path, mode: 'image' }),
  })) };
}

async function resolveWebDelivery(ctx, sessionId, delivery, signal) {
  const href = deliveryUrl({ sessionId, seq: delivery.seq, path: delivery.path, ...(delivery.application ? { application: '1' } : {}) });
  const response = await fetch(href, { method: 'HEAD', credentials: 'same-origin', signal });
  if (!response.ok) return null;
  if (ctx.get('sidebarRightTabs')?.get('browser') === undefined) return { href };
  return { href, async openInSidebar(openSignal) {
    const response = await fetch(href + '&mode=sidebar', { credentials: 'same-origin', signal: openSignal });
    if (!response.ok) throw Error('无法打开交付网页');
    const { url } = await response.json();
    const preview = new URL(url);
    const validTarget = delivery.application
      ? preview.hostname === '127.0.0.1' && preview.port && preview.pathname === '/' && !preview.search && !preview.hash
      : /^preview-[a-f0-9]{24}\.localhost$/.test(preview.hostname) && /^\/[a-f0-9]{48}\//.test(preview.pathname);
    if (preview.protocol !== 'http:' || preview.username || preview.password || !validTarget)
      throw Error('交付网页地址无效');
    openSignal.throwIfAborted();
    ctx.sidebarRight.openTab('browser', { params: { url: preview.href } });
  } };
}

/** Native owns task interaction; Studio supplies its product preset identity. */
export function installTaskTimeline(ctx, options) {
  return install(ctx, { ...options, loadDeliveryEvidence, resolveWebDelivery: (...args) => resolveWebDelivery(ctx, ...args),
    isIndependentPreset: presetId => typeof presetId === 'string' && presetId.endsWith(HARNESS_SERVICE_PRESET_SUFFIX),
    resolveAgentFromPreset: (presetId, agents) => {
    const id = agentFromSessionPreset(presetId, agents);
    if (!id && typeof presetId === 'string' && presetId.startsWith('agentkit-studio-agent-'))
      throw Error('当前会话的智能体配置暂不可用，请重试读取');
    return id;
  } });
}
