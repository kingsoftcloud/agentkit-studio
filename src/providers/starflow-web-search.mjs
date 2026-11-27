import { hostFetch } from '../http-fetch.mjs';

const origin = 'https://kspmas.ksyun.com';

/** Use the selected official 星流 connection. Never send its key elsewhere. */
export function starflowWebSearch(profile, fetchImpl = hostFetch) {
  let url;
  try { url = new URL(profile?.baseUrl); } catch { return undefined; }
  if (url.hostname !== new URL(origin).hostname || url.port || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname.replace(/\/$/, '') !== '/v1'
    || !profile.apiKey || !profile.modelName) return undefined;
  return async (query, maxResults, signal) => {
    const deadline = AbortSignal.timeout(55000);
    const response = await fetchImpl(origin + '/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { Authorization: 'Bearer ' + profile.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: profile.modelName, tools: [{ type: 'web_search' }], max_tokens: 1600,
        messages: [
          { role: 'system', content: 'Use web search for the query. Summarize findings concisely and include source links when available.' },
          { role: 'user', content: query },
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
    const citations = Array.isArray(message?.citations) ? message.citations : [];
    const sources = citations.flatMap(citation => {
      try {
        const url = new URL(typeof citation === 'string' ? citation : citation?.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
        return [{ url: url.href, title: typeof citation?.title === 'string' ? citation.title : url.hostname }];
      } catch { return []; }
    }).slice(0, maxResults);
    return { sources, content: typeof message?.content === 'string' ? message.content.slice(0, 6000) : '', searchCount: count };
  };
}
