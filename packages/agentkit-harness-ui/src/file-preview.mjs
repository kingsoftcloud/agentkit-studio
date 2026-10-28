const byteLength = text => new TextEncoder().encode(text).length;
function validPage(page) {
  if (page?.contract !== 'agentkit.native-child-file/v1' || page.workspace !== 'child' || page.readOnly !== true
    || typeof page.path !== 'string' || !page.path || page.path.length > 1024 || /[\0\\]/.test(page.path)
    || !page.path.split('/').every(part => part && part !== '.' && part !== '..')
    || !Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.totalBytes)
    || page.totalBytes < page.offset || typeof page.text !== 'string' || page.text.length > 65536 || byteLength(page.text) > 65536
    || !/^sha256:[a-f0-9]{64}$/.test(page.pageDigest ?? '')) return false;
  const end = page.offset + byteLength(page.text);
  return end <= page.totalBytes && (page.nextOffset === null ? end === page.totalBytes
    : Number.isSafeInteger(page.nextOffset) && page.nextOffset === end && end > page.offset && end < page.totalBytes);
}

/** A current read-only observation, separate from immutable tool results.
 * The Host owns scope, loading and cursors; this view renders one real page.
 */
export function createFilePreviewComponents(React) {
  const h = React.createElement;
  function FilePreviewPane({ page, loading = false, error = '', onNext, onPrevious, onCopy, labels = {}, theme = 'system' }) {
    const visible = validPage(page) && !loading && !error;
    const muted = theme === 'light' ? '#64666b' : '#96979b';
    const button = { type: 'button', style: { font: 'inherit', cursor: 'pointer' } };
    return h('section', { 'data-testid': 'harness-file-preview', 'aria-busy': loading,
      style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box', padding: 16,
        fontSize: 13, color: theme === 'system' ? 'CanvasText' : theme === 'light' ? '#222' : '#e5e5e5',
        background: theme === 'system' ? 'Canvas' : theme === 'light' ? '#fff' : '#141414' } },
    h('header', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('strong', { title: visible ? page.path : undefined,
        style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      visible ? page.path : labels.unavailable || 'File preview'),
      onCopy ? h('button', { ...button, 'data-testid': 'file-preview-copy', disabled: !visible,
        onClick: () => { if (visible) onCopy(page.text); } }, labels.copy || 'Copy page') : null),
    h('p', { style: { color: muted } }, labels.readOnly || 'Read-only workspace observation'),
    loading ? h('p', { role: 'status' }, labels.loading || 'Reading file…') : error
      ? h('p', { role: 'alert' }, error) : !visible ? h('p', { role: 'alert' }, labels.unavailable || 'File observation unavailable') : null,
    visible ? h(React.Fragment, null,
      h('p', { 'data-testid': 'file-preview-range', style: { color: muted } },
        `${page.offset}–${page.offset + byteLength(page.text)} / ${page.totalBytes} ${labels.bytes || 'bytes'}`),
      h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
        h('pre', { 'data-testid': 'file-preview-text', style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: 1.6 } }, page.text)),
      h('p', { style: { color: muted } }, labels.observation || 'Current file data, not a tool receipt or task verification.')) : null,
    h('nav', { style: { display: 'flex', gap: 8, marginTop: 12 } },
      onPrevious ? h('button', { ...button, 'data-testid': 'file-preview-previous', disabled: loading,
        onClick: () => { if (!loading) onPrevious(); } }, labels.previous || 'Previous page') : null,
      onNext ? h('button', { ...button, 'data-testid': 'file-preview-next', disabled: !visible || page.nextOffset === null,
        onClick: () => { if (visible && page.nextOffset !== null) onNext(page.nextOffset); } }, labels.next || 'Next page') : null));
  }
  return { FilePreviewPane };
}
