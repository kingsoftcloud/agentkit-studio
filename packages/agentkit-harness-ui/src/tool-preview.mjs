import { h } from './view.mjs';
import { truncateText } from './summary.mjs';

/** A provider argument draft has no call authority, applied diff or outcome. */
export function toolPreviewBlock(item, { labels = {} } = {}) {
  const input = item.input ?? {}, path = input.path || input.file_path || input.filePath || input.filename;
  const content = input.content ?? input.new_text ?? input.command;
  return h('section', { className: 'harness-tool harness-tool-preview', 'data-testid': 'tool-preview',
    'data-preview-id': item.id, 'data-uncommitted': 'true', 'aria-label': labels.toolPreparing || 'Generating tool arguments' },
    h('div', { className: 'harness-tool-summary' },
      h('span', { className: item.streaming ? 'harness-shimmer' : '' }, item.streaming
        ? labels.toolPreparing || 'Generating tool arguments' : labels.previewStopped || 'Argument generation interrupted'),
      h('code', { className: 'harness-tool-secondary' }, path || item.name),
      h('span', { className: 'harness-tool-secondary' }, `${item.receivedChars} ${labels.charactersReceived || 'characters received'}`)),
    content ? h('pre', { style: { maxHeight: '180px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '12px' },
      'data-testid': 'tool-preview-content' }, truncateText(content, { maxLines: 12, maxChars: 3000 })) : null,
    h('small', { className: 'harness-tool-secondary' }, labels.previewUncommitted || 'Not executed; this is a model argument draft'));
}
