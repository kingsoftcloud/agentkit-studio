/** This optional endpoint belongs to the Host. The model supplies only a query. */
export function webSearchEndpoint(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  const url = new URL(text);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search)
    throw new Error('搜索 API 地址需使用 HTTPS，或本机 HTTP。请填写不含密钥和查询参数的地址。');
  return url.href;
}
