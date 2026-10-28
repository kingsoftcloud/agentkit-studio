import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilePreviewComponents } from '../src/file-preview.mjs';

const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
const { FilePreviewPane } = createFilePreviewComponents(React);
const page = (extra = {}) => ({ contract: 'agentkit.native-child-file/v1', workspace: 'child', readOnly: true,
  path: 'source.txt', offset: 0, nextOffset: null, totalBytes: 10, text: '<b>源</b>', pageDigest: 'sha256:' + 'a'.repeat(64), ...extra });
function find(tree, id) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.props['data-testid'] === id) return tree;
  return tree.children.map(child => find(child, id)).find(Boolean) ?? null;
}
const text = tree => !tree ? '' : typeof tree === 'string' ? tree : typeof tree === 'number' ? String(tree)
  : tree.children.map(text).join('');

test('actual page text is plain content, replaced between pages, with real bytes and no invented line numbering', () => {
  const first = FilePreviewPane({ page: page() });
  assert.equal(text(find(first, 'file-preview-text')), '<b>源</b>');
  assert.equal(text(find(first, 'file-preview-range')), '0–10 / 10 bytes');
  assert.equal(Object.hasOwn(find(first, 'file-preview-text').props, 'dangerouslySetInnerHTML'), false);
  const next = FilePreviewPane({ page: page({ text: 'next', totalBytes: 14, offset: 10 }) });
  assert.equal(text(find(next, 'file-preview-text')), 'next'); assert.equal(text(next).includes('<b>源</b>'), false);
});

test('loading, errors and invalid observations never expose an old page as the current result', () => {
  for (const props of [{ loading: true }, { error: 'Unable to read' }, { page: page({ contract: 'other' }) },
    { page: page({ readOnly: false }) }, { page: page({ path: '../escape' }) }, { page: page({ offset: -1 }) },
    { page: page({ nextOffset: 3 }) }, { page: page({ totalBytes: 11 }) }]) {
    const tree = FilePreviewPane({ page: page(), ...props });
    assert.equal(find(tree, 'file-preview-text'), null);
    assert.equal(text(tree).includes('completed'), false);
  }
  assert.equal(text(find(FilePreviewPane({ page: page({ text: '', totalBytes: 0 }) }), 'file-preview-text')), '');
});

test('copy preserves exact text; navigation uses only valid Host byte cursors', () => {
  let copied, cursor, previous = 0;
  const props = { onCopy: value => { copied = value; }, onNext: value => { cursor = value; }, onPrevious: () => previous++ };
  const tree = FilePreviewPane({ ...props, page: page({ totalBytes: 20, nextOffset: 10 }) });
  find(tree, 'file-preview-copy').props.onClick(); assert.equal(copied, '<b>源</b>');
  find(tree, 'file-preview-next').props.onClick(); assert.equal(cursor, 10);
  find(tree, 'file-preview-previous').props.onClick(); assert.equal(previous, 1);
  const ended = FilePreviewPane({ ...props, page: page() }); assert.equal(find(ended, 'file-preview-next').props.disabled, true);
  const loading = FilePreviewPane({ ...props, page: page(), loading: true });
  assert.equal(find(loading, 'file-preview-next').props.disabled, true); assert.equal(find(loading, 'file-preview-copy').props.disabled, true);
  cursor = null; find(loading, 'file-preview-next').props.onClick(); assert.equal(cursor, null);
});
