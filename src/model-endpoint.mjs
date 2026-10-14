/** Complete an OpenAI-compatible base URL without discarding a custom gateway prefix. */
export function normalizeModelEndpoint(value, provider = 'custom') {
  let input = String(value || '').trim();
  if (!input) return provider === 'ksyun' ? 'http://kspmas.ksyun.com/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:\/|$)/i.test(input) ? 'http://' : 'https://') + input;
  }
  let url;
  try { url = new URL(input); } catch { throw Object.assign(new Error('请填写有效的模型服务地址'), { code: 'MODEL_ENDPOINT_INVALID' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('模型服务地址须使用 HTTP(S)，且不包含账号、查询参数或片段'), { code: 'MODEL_ENDPOINT_INVALID' });
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/, '');
  if (!path) path = '/v1';
  url.pathname = path;
  return url.href.replace(/\/$/, '');
}
