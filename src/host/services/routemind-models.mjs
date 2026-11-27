import { normalizeModelEndpoint } from '../../model-endpoint.mjs';

export const ROUTEMIND_PROVIDER = 'routemind-auto';
export const ROUTEMIND_MODELS = Object.freeze([
  { id: 'auto', name: 'Auto' },
  { id: 'auto-cost', name: 'Auto · 价格优先' },
  { id: 'auto-balance', name: 'Auto · 均衡' },
  { id: 'auto-quality', name: 'Auto · 质量优先' },
]);

const namespace = 'llm-pi-ai';
const credential = 'AGENTKIT_ROUTEMIND_GATEWAY_TOKEN';

export function routeMindGateway(env) {
  try {
    const url = new URL(env.ROUTEMIND_GATEWAY_URL || 'http://127.0.0.1:8787');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: normalizeModelEndpoint(url.href, 'openai-compatible'), apiKey: String(env.ROUTEMIND_TOKEN || ''),
      local: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) };
  } catch {
    return null;
  }
}

/** One dedicated DSH route, reconciled with the effective plugin lifecycle. */
export function mountRouteMindModels(ctx, { active, gateway, credentials }) {
  let pending = Promise.resolve(), closed = false;
  const sync = () => {
    pending = pending.catch(() => {}).then(async () => {
      if (closed) return;
      const settings = ctx.get('settings');
      const entry = settings?.describe({ redactSecrets: true }).find(item => item.ns === namespace);
      if (!entry) return;
      const previous = entry.value?.providers?.[ROUTEMIND_PROVIDER];
      const configured = await active() ? await gateway() : null;
      const path = ['providers', ROUTEMIND_PROVIDER];
      if (!configured) {
        if (previous) await settings.mutate(namespace, [{ op: 'unset', path }], entry.revision);
        return;
      }
      // The local gateway's default configuration does not require a token.
      const key = configured.apiKey || (configured.local ? 'routemind-local' : '');
      if (key && (await credentials.resolve(credential))?.value !== key) await credentials.set(credential, key);
      const value = { displayName: 'RouteMind', api: 'openai-completions', baseURL: configured.baseUrl,
        apiKeyEnv: credential, compat: { supportsDeveloperRole: false, supportsStore: false },
        models: ROUTEMIND_MODELS.map(model => ({ ...model, input: ['text'] })) };
      const current = previous?.baseURL === value.baseURL && previous?.apiKeyEnv === credential
        && previous?.models?.map(model => model.id).join(',') === value.models.map(model => model.id).join(',');
      if (key && !current) await settings.mutate(namespace, [{ op: 'set', path, value }], entry.revision);
      else if (!key && previous) await settings.mutate(namespace, [{ op: 'unset', path }], entry.revision);
    }).catch(error => { ctx.logger?.warn('RouteMind model registration failed (%s)', error?.name || 'Error'); });
    return pending;
  };
  ctx.on('plugin-manager/changed', sync);
  ctx.on('app-boot/config-reload', sync);
  ctx.effect(() => {
    void Promise.resolve(ctx.root?.loader?.await()).then(sync).catch(() => {});
    return () => { closed = true; };
  }, 'agentkit-studio: RouteMind model directory');
  ctx.on('llm/stream', async function* (request, next) {
    if (request.provider === ROUTEMIND_PROVIDER && !await active()) {
      throw Object.assign(new Error('请先启用 RouteMind 智能路由'), { code: 'ROUTEMIND_DISABLED' });
    }
    yield* next();
  }, { prepend: true });
  return sync;
}
