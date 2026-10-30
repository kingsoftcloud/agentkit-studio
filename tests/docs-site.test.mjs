import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SCRIPT = join(ROOT, 'scripts', 'build-docs-site.mjs');

function build(output) {
  return spawnSync(process.execPath, [SCRIPT, '--output', output], { cwd: ROOT, encoding: 'utf8' });
}

function buildOrFail(output) {
  const result = build(output);
  assert.equal(result.status, 0, `build failed:\n${result.stderr}`);
  return result;
}

async function walkFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, ...prefix.split('/')), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walkFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

async function markdownSources(prefix = '') {
  const sources = [];
  const entries = await readdir(join(DOCS, ...prefix.split('/')), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === '_site') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sources.push(...await markdownSources(rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) sources.push(rel);
  }
  return sources;
}

function outputForKey(sourceRel) {
  return sourceRel === 'README.md' ? 'docs/index.html' : `docs/${sourceRel.slice(0, -'.md'.length)}.html`;
}

let workspace;
let site;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'studio-docs-site-'));
  site = join(workspace, 'site');
  buildOrFail(site);
});

after(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test('every docs/*.md guide has a rendered HTML output', async () => {
  const sources = await markdownSources();
  assert.ok(sources.length > 20, `expected the documented guides, found ${sources.length}`);
  for (const sourceRel of sources) {
    const outputRel = outputForKey(sourceRel);
    const html = await readFile(join(site, ...outputRel.split('/')), 'utf8');
    assert.match(html, /<article class="doc">/, `${outputRel} is not a rendered document`);
    assert.match(html, /<h1[ >]/, `${outputRel} has no first-level heading`);
    assert.match(html, /返回站点首页/, `${outputRel} has no navigation back to the site`);
  }

  const nested = await readFile(join(site, 'docs', 'brand', 'visual-system.html'), 'utf8');
  assert.match(nested, /href="\.\.\/\.\.\/index\.html"/);
});

test('the site root serves the landing page verbatim', async () => {
  assert.equal(await readFile(join(site, 'index.html'), 'utf8'), await readFile(join(DOCS, 'index.html'), 'utf8'));
});

test('generated pages have no internal links left pointing at Markdown files', async () => {
  const files = (await walkFiles(site)).filter(file => file.endsWith('.html'));
  const offenders = [];
  for (const file of files) {
    const html = await readFile(join(site, ...file.split('/')), 'utf8');
    for (const match of html.matchAll(/href="([^"]*)"/g)) {
      const href = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) continue;
      if (/\.md(?:[?#]|$)/.test(href)) offenders.push(`${file} -> ${href}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('every rendered document links back to the site home page', async () => {
  const files = (await walkFiles(site)).filter(file => file.startsWith('docs/') && file.endsWith('.html'));
  for (const file of files) {
    const html = await readFile(join(site, ...file.split('/')), 'utf8');
    const depth = file.split('/').length - 1;
    const prefix = '../'.repeat(depth);
    assert.ok(html.includes(`href="${prefix}index.html"`), `${file} is missing a link to the site home page`);
    assert.ok(html.includes('返回站点首页'), `${file} is missing the home-page navigation label`);
  }
});

test('the documentation index reuses the README guide list', async () => {
  const readme = await readFile(join(DOCS, 'README.md'), 'utf8');
  const index = await readFile(join(site, 'docs', 'index.html'), 'utf8');
  const links = [...readme.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)]
    .map(match => match[1])
    .filter(target => !target.startsWith('..') && !/^[a-z][a-z0-9+.-]*:/i.test(target));
  assert.ok(links.length >= 15, `expected the README guide list, found ${links.length} entries`);
  for (const target of links) {
    const htmlTarget = outputForKey(target).replace(/^docs\//, '');
    assert.ok(index.includes(`href="${htmlTarget}"`), `docs index is missing ${htmlTarget}`);
  }
});

test('the landing page links to the rendered documentation site', async () => {
  const landing = await readFile(join(DOCS, 'index.html'), 'utf8');
  assert.match(landing, /<nav class="links" aria-label="主导航">[\s\S]*?<a href="docs\/">文档<\/a>[\s\S]*?<\/nav>/);
  assert.match(landing, /<footer>[\s\S]*?<a href="docs\/">文档<\/a>[\s\S]*?<\/footer>/);
});

test('out-of-docs Markdown links point at the published repository', async () => {
  const html = await readFile(join(site, 'docs', 'index.html'), 'utf8');
  assert.match(html, /https:\/\/github\.com\/kingsoftcloud\/agentkit-studio\/blob\/main\/CONTRIBUTING\.md/);
  assert.match(html, /target="_blank" rel="noopener"/);
});

test('the build is deterministic and fails loudly on invalid input', async () => {
  const first = join(workspace, 'deterministic-a');
  const second = join(workspace, 'deterministic-b');
  buildOrFail(first);
  buildOrFail(second);
  const firstFiles = await walkFiles(first);
  assert.deepEqual(firstFiles, await walkFiles(second));
  for (const file of firstFiles) {
    assert.equal(
      await readFile(join(first, ...file.split('/')), 'utf8'),
      await readFile(join(second, ...file.split('/')), 'utf8'),
      `${file} differs between builds`,
    );
  }

  const badArgument = spawnSync(process.execPath, [SCRIPT, '--not-an-option'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(badArgument.status, 1);
  assert.match(badArgument.stderr, /docs site build failed/);

  const missingValue = spawnSync(process.execPath, [SCRIPT, '--output'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--output requires a directory/);
});

test('a build that cannot write its output fails with a non-zero exit', async () => {
  const blocker = join(workspace, 'blocked-output');
  await mkdir(join(blocker, 'parent'), { recursive: true });
  await writeFile(join(blocker, 'parent', 'file.txt'), 'occupied\n');
  const result = build(join(blocker, 'parent', 'file.txt', 'nested'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docs site build failed/);
});
