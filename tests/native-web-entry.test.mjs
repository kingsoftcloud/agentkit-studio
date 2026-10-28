import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writtenNativeWebEntry } from '../src/providers/native-web-entry.mjs';
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-web-entry-')), root = join(directory, 'workspace'); mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (path, content = '') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const entry = (paths, observed, extra = {}) => writtenNativeWebEntry({ workspaceModifiedPaths: paths,
    lastBrowserObservation: observed ? { entryPath: observed } : null, ...extra }, root);
  return { directory, root, write, entry };
}
test('entry selection uses actual changes and canonical observation, without parsing model text', t => {
  const { write, entry } = workspace(t); write('index.html'); write('app/home.html'); write('app/app.js');
  assert.equal(entry([], 'index.html', { finalText: 'Delivered app/home.html' }), null);
  assert.equal(entry(['app/app.js'], 'app/home.html'), 'app/home.html');
  assert.throws(() => entry(['app/app.js'], null, { messages: [{ role: 'assistant', content: 'index.html' }] }), /no page is bound/);
  assert.equal(entry(['app/home.html']), 'app/home.html');
});
test('nested assets select the nearest local entry and cannot borrow an unrelated root page', t => {
  const { write, entry } = workspace(t); write('index.html'); write('app/scripts/game.js');
  assert.throws(() => entry(['app/scripts/game.js'], 'index.html'), /no page is bound/);
  write('app/index.html'); assert.equal(entry(['app/scripts/game.js'], 'index.html'), 'app/index.html');
});
test('root fallback for a nested asset requires an explicit parsed local reference', t => {
  const { write, entry } = workspace(t); write('assets/main.js');
  for (const html of ['<!-- <script src="assets/main.js"></script> -->', '<script>"<script src=assets/main.js>"</script>',
    '<base href="/"><script src="assets/main.js"></script>', '<script src="https://remote.test/assets/main.js"></script>',
    '<script src="http://studio.invalid/assets/main.js"></script>',
    '<script src="other.js" src="assets/main.js"></script>']) {
    write('index.html', html); assert.throws(() => entry(['assets/main.js']), /no page is bound/);
  }
  write('index.html', '<SCRIPT src="/assets/main.js?v=1&amp;x=2"></SCRIPT>');
  assert.equal(entry(['assets/main.js']), 'index.html');
});
test('local references decode entities and URL encoding while keeping script and style paths scoped', t => {
  const { write, entry } = workspace(t); write('assets/a b&c.css');
  write('index.html', '<link rel="stylesheet" href="assets/a%20b&amp;c.css?version=1">');
  assert.equal(entry(['assets/a b&c.css']), 'index.html');
});
test('ambiguous projects or unavailable changed HTML are Host blockers', t => {
  const { write, entry } = workspace(t); write('a/index.html'); write('b/index.html');
  assert.throws(() => entry(['a/index.html', 'b/index.html']), /multiple pages/);
  assert.throws(() => entry(['deleted.html']), /changed page is unavailable/);
  assert.equal(entry(['a/index.html', 'a/index.html']), 'a/index.html');
});
test('changed paths and symlinks cannot leave the workspace', t => {
  const { directory, root, write, entry } = workspace(t); write('index.html');
  writeFileSync(join(directory, 'outside.html'), 'outside'); symlinkSync(join(directory, 'outside.html'), join(root, 'linked.html'));
  for (const path of ['../outside.html', join(directory, 'outside.html'), 'linked.html']) {
    assert.throws(() => entry([path]), /changed files leave the workspace/);
  }
  assert.throws(() => entry([undefined]), /invalid committed workspace paths/);
});
test('internal aliases are resolved and source-equivalent non-web suffixes do not invent a page', t => {
  const { root, write, entry } = workspace(t); write('app/index.html');
  symlinkSync(join(root, 'app/index.html'), join(root, 'alias.html'));
  assert.equal(entry(['alias.html']), 'app/index.html');
  assert.equal(entry(['server.py', 'app/source.tsx', 'README.md']), null);
});
