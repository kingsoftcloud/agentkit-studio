// REST is preferred; bounded read-only Git advertisements recover public quota
// failures. Each request has its own deadline, independent of caller authority.
const HEX40 = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const fail = code => Object.assign(new Error(code), { code });
const discard = value => { try { Promise.resolve(value?.cancel()).catch(() => {}); } catch {} };
function authority(signal, assertCurrent) {
  signal.throwIfAborted(); const current = assertCurrent();
  if (current !== true) {
    if (current && typeof current.then === 'function') Promise.resolve(current).catch(() => {});
    throw fail('skill_github_authority_lost');
  }
  signal.throwIfAborted();
}
function race(work, signal, late) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); fn(value); } };
    const abort = () => done(reject, signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => {
      if (settled) { try { Promise.resolve(late?.(value)).catch(() => {}); } catch {} }
      else done(resolve, value);
    }, error => done(reject, error));
    if (signal.aborted) abort();
  });
}
async function request(url, maxBytes, { fetchImpl, signal, assertCurrent }) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const guard = () => { authority(signal, assertCurrent); if (deadline.aborted) throw fail('skill_github_ref_invalid'); };
  let response, reader;
  async function io(work, late) {
    guard();
    try { return await race(work(), deadline, late); }
    catch { authority(signal, assertCurrent); throw fail('skill_github_ref_invalid'); }
  }
  try {
    response = await io(() => fetchImpl(url, { method: 'GET', redirect: 'error', signal: deadline,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }), value => discard(value?.body));
    guard();
    if (!response?.ok || typeof response.body?.getReader !== 'function') throw fail('skill_github_ref_invalid');
    const length = response.headers?.get?.('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw fail('skill_github_response_limit');
    reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const next = await io(() => reader.read()); guard();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw fail('skill_github_ref_invalid');
      size += next.value.byteLength;
      if (size > maxBytes) throw fail('skill_github_response_limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally { discard(reader ?? response?.body); try { reader?.releaseLock(); } catch {} }
}
function advertisedCommit(bytes, ref) {
  let cursor = 0;
  function packet() {
    if (cursor + 4 > bytes.length) throw fail('skill_github_ref_invalid');
    const hex = bytes.toString('latin1', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw fail('skill_github_ref_invalid');
    const size = Number.parseInt(hex, 16); cursor += 4;
    if (size === 0) return null;
    if (size < 4 || size > 65520 || cursor + size - 4 > bytes.length) throw fail('skill_github_ref_invalid');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(cursor, cursor + size - 4)); }
    catch { throw fail('skill_github_ref_invalid'); }
    cursor += size - 4; return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
  if (packet() !== '# service=git-upload-pack' || packet() !== null) throw fail('skill_github_ref_invalid');
  const refs = new Map();
  for (;;) {
    const line = packet();
    if (line === null) break;
    const record = line.split('\0')[0], match = /^([a-f0-9]{40}) (HEAD|refs\/[^\x00-\x20\x7f]+)$/.exec(record);
    if (!match || refs.has(match[2])) throw fail('skill_github_ref_invalid');
    refs.set(match[2], match[1]);
  }
  if (cursor !== bytes.length) throw fail('skill_github_ref_invalid');
  for (const name of [`refs/tags/${ref}^{}`, `refs/heads/${ref}`, `refs/tags/${ref}`]) if (refs.has(name)) return refs.get(name);
  throw fail('skill_github_ref_invalid');
}
export async function resolveGithubCommit({ fetchImpl, owner, repository, ref, signal, assertCurrent }) {
  if (typeof fetchImpl !== 'function') throw fail('skill_github_fetch_required');
  if (typeof owner !== 'string' || !OWNER.test(owner) || typeof repository !== 'string' || !OWNER.test(repository)) throw fail('skill_github_url_invalid');
  if (!(signal instanceof AbortSignal)) throw fail('skill_github_signal_required');
  if (typeof assertCurrent !== 'function') throw fail('skill_github_authority_required');
  ref = typeof ref === 'string' ? ref.trim() : '';
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(ref) || ref.startsWith('/') || ref.split('/').includes('..')) throw fail('skill_github_ref_invalid');
  authority(signal, assertCurrent);
  if (HEX40.test(ref.toLowerCase())) return ref.toLowerCase();
  const context = { fetchImpl, signal, assertCurrent }, path = `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  try {
    const bytes = await request(`https://api.github.com/repos/${path}/commits/${encodeURIComponent(ref)}`, 2 * 1024 * 1024, context);
    authority(signal, assertCurrent);
    const commit = String(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.sha || '').toLowerCase();
    if (HEX40.test(commit)) return commit;
  } catch (error) {
    authority(signal, assertCurrent);
    if (error?.code === 'skill_github_authority_lost') throw error;
    // All other REST failures are read-only and may use a fresh Git request.
  }
  const bytes = await request(`https://github.com/${path}.git/info/refs?service=git-upload-pack`, 5 * 1024 * 1024, context);
  authority(signal, assertCurrent); return advertisedCommit(bytes, ref);
}
