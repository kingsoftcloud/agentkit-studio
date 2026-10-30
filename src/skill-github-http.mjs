/** Public GitHub GET redirects, checked before every additional request. */
const origins = new Set(['https://github.com', 'https://api.github.com', 'https://codeload.github.com']);
const redirects = new Set([301, 302, 303, 307, 308]);
const invalid = () => Object.assign(new Error('GitHub redirect is not supported'), { code: 'skill_github_redirect_invalid' });
const discard = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };

function target(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw invalid(); }
  if (!origins.has(url.origin) || url.username || url.password || url.hash) throw invalid();
  return url.href;
}

/** request must race fetch against the caller's existing deadline/cancellation.
 * guard revalidates the original invocation, rather than authorizing a new one. */
export async function followGithubRedirects(url, { request, guard }) {
  let current = target(url), response;
  const seen = new Set();
  try {
    for (let hops = 0; ; hops++) {
      guard();
      if (seen.has(current)) throw invalid();
      seen.add(current);
      response = await request(current);
      guard();
      if (!redirects.has(response?.status)) { const result = response; response = undefined; return result; }
      if (hops >= 20) throw invalid();
      const location = response.headers?.get?.('location');
      if (typeof location !== 'string' || !location.trim()) throw invalid();
      const next = target(location, current);
      discard(response); response = undefined;
      current = next;
    }
  } finally { discard(response); }
}
