import { redactValue, truncateText } from './summary.mjs';

const bounded = value => {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { /* text observation */ } }
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, (key, value) => redactValue(key, value), 2);
  return truncateText(text.slice(0, 24000), { maxChars: 4000, maxLines: 500 });
};

/** The host selects a committed call; the package owns the read-only dialog. */
export function createToolInspector(React) {
  const { createElement: h, useEffect, useRef } = React;
  return function ToolInspector({ item, onClose, labels = {} }) {
    const ref = useRef(null);
    useEffect(() => {
      const dialog = ref.current;
      if (!item || !dialog) return;
      dialog.showModal?.();
      return () => { if (dialog.open) dialog.close?.(); };
    }, [item?.callId]);
    if (!item) return null;
    return h('dialog', { ref, className: 'harness-tool-inspector', 'aria-label': labels.toolDetails || 'Tool details',
      onCancel: event => { event.preventDefault(); onClose(); },
      style: { color: 'inherit', background: 'var(--harness-bg, Canvas)', border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        borderRadius: '10px', padding: '20px', width: 'min(720px, calc(100vw - 40px))', maxHeight: '85vh', overflow: 'auto' } },
    h('style', null, '.harness-tool-inspector::backdrop{background:rgb(0 0 0 / .35)}.harness-tool-inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}'),
    h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('strong', null, item.name), h('button', { type: 'button', onClick: onClose, autoFocus: true }, labels.close || 'Close')),
    h('p', null, `${labels.state || 'State'}: ${item.status}`),
    h('h4', null, labels.arguments || 'Arguments'), h('pre', null, bounded(item.input ?? {})),
    h('h4', null, labels.result || 'Result'),
    h('pre', null, item.error ? bounded(item.error) : item.result != null ? bounded(item.result)
      : labels.noSettledResult || 'No settled result is available'),
    item.display?.kind === 'file_edit' ? h(React.Fragment, null,
      h('h4', null, labels.appliedChanges || 'Applied changes'),
      ...item.display.files.map(file => h('section', { key: file.path }, h('strong', null, file.path),
        h('pre', null, file.patch || labels.diffUnavailable || 'No diff preview is available'),
        file.truncated ? h('p', null, labels.diffTruncated || 'Diff preview is truncated') : null))) : null);
  };
}
