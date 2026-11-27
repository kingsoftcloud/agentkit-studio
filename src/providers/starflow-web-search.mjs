import { hostFetch } from '../http-fetch.mjs';
import { dshModelRoute, HARNESS_SERVICE_MODEL_PROVIDER } from '../model-route.mjs';

const origin = 'https://kspmas.ksyun.com';

/** Resolve credentials only for the requested route/model pair. */
export async function resolveStarflowWebSearch(models, selection, { profile, harnessProfile, dshProfile, fetch } = {}) {
  if (!selection?.provider || !selection.model) return undefined;
  try {
    if (!profile) {
      const settings = await models.settings();
      const selected = selection.provider === HARNESS_SERVICE_MODEL_PROVIDER
        ? harnessProfile?.(selection.model)
        : (settings.modelProfiles || []).find(item => item.enabled !== false
          && item.modelName === selection.model && dshModelRoute(item) === selection.provider);
      profile = selected ? await models.profile(selected.id) : await dshProfile?.(selection);
    }
    return starflowWebSearch(profile, fetch);
  } catch {
    return undefined;
  }
}

export function isStarflowSearchEndpoint(baseUrl) {
  if (!URL.canParse(baseUrl)) return false;
  const url = new URL(baseUrl);
  return url.hostname === 'kspmas.ksyun.com' && !url.port && ['https:', 'http:'].includes(url.protocol)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, '') === '/v1';
}

/** Use the selected official 星流 connection. Never send its key elsewhere. */
export function starflowWebSearch(profile, fetchImpl = hostFetch) {
  if (!isStarflowSearchEndpoint(profile?.baseUrl) || !profile.modelName) return undefined;
  const auth = Object.entries(profile.headers || {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  const authorization = auth ?? (profile.apiKey ? 'Bearer ' + profile.apiKey : '');
  if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization)) return undefined;
  return async (query, maxResults, signal) => {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text || text.length > 4000) throw Object.assign(new Error('搜索关键词格式无效'), { code: 'invalid_search_query' });
    const deadline = AbortSignal.timeout(55000);
    const response = await fetchImpl(origin + '/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: profile.modelName, tools: [{ type: 'web_search' }], max_tokens: 1600,
        messages: [
          { role: 'system', content: 'Use web search for the query. Summarize findings concisely and include source links when available.' },
          { role: 'user', content: '请联网搜索并根据来源回答以下查询：\n' + text },
        ] }),
    });
    const fail = code => Object.assign(new Error(code), { code });
    if (!response.ok) {
      await response.body?.cancel();
      throw fail(response.status === 429 ? 'starflow_search_rate_limited'
        : response.status === 401 || response.status === 403 ? 'starflow_search_unauthorized' : 'starflow_search_rejected');
    }
    const value = await response.json();
    const count = value?.usage?.web_search_queries;
    if (!Number.isSafeInteger(count) || count < 1) throw fail('starflow_search_not_performed');
    const message = value.choices?.[0]?.message;
    const citations = [
      ...(Array.isArray(message?.citations) ? message.citations : []),
      ...(Array.isArray(message?.annotations) ? message.annotations.map(item => item?.url_citation ?? item) : []),
    ];
    const seen = new Set();
    const sources = citations.flatMap(citation => {
      try {
        const url = new URL(typeof citation === 'string' ? citation : citation?.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
        seen.add(url.href);
        return [{ url: url.href, title: typeof citation?.title === 'string' ? citation.title : url.hostname }];
      } catch { return []; }
    }).slice(0, maxResults);
    return { sources, content: typeof message?.content === 'string' ? message.content.slice(0, 6000) : '', searchCount: count };
  };
}

/** Codex App Server disables its hosted search for custom model routes. */
export function createStarflowSearchTool(search) {
  if (!search) return undefined;
  const spec = {
    type: 'function', name: 'studio_web_search',
    description: 'Search the web for current information and cite the returned sources.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } },
      required: ['query'], additionalProperties: false },
  };
  return { spec, handler: async ({ name, arguments: args, signal }) =>
    name === spec.name ? JSON.stringify(await search(args?.query, 5, signal)) : undefined };
}
