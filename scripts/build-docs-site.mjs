#!/usr/bin/env node

// Renders the Committed Markdown guides in docs/ into a small static site.
// GitHub Pages publishes the generated .artifacts/docs-site tree, so the landing
// page keeps working while every guide becomes navigable HTML instead of a raw .md
// download. The output stays out of docs/ so plugin tarballs never pick it up.
//
// Deterministic by construction: sources are sorted, links are rewritten from
// the file layout only, and no network access or clock is involved.

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, Renderer } from 'marked';

export const REPOSITORY_URL = 'https://github.com/kingsoftcloud/agentkit-studio';
const REPOSITORY_BRANCH = 'main';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_ROOT = join(REPO_ROOT, 'docs');
const DEFAULT_OUTPUT = join(REPO_ROOT, '.artifacts', 'docs-site');
export const DOCS_INDEX_LABEL = '文档总览';

// Used only if the landing page stops exposing its :root palette.
const FALLBACK_THEME = [
  '--bg:#07080c; --card:#0f1219;',
  '--line:rgba(255,255,255,.08); --line-strong:rgba(255,255,255,.14);',
  '--ink:#eef1f7; --muted:#98a1b3; --dim:#6b7488;',
  '--blue:#4d7cff; --cyan:#7ee7f2; --violet:#9d8bff;',
  '--grad:linear-gradient(100deg,#9fb6ff 0%,#7ee7f2 48%,#9d8bff 100%);',
  '--radius:20px; --wrap:1180px;',
  '--ease:cubic-bezier(.16,.8,.32,1);',
  '--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
].join('\n  ');

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%234d7cff'/%3E%3Ccircle cx='32' cy='32' r='11' fill='white'/%3E%3C/svg%3E";
const MARK_SVG = '<svg viewBox="0 0 64 64" fill="none"><path d="M32 18v10M26 36l-9 5M38 36l9 5" stroke="#06101f" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="32" r="8" fill="#06101f"/><circle cx="17" cy="42" r="4" fill="#06101f"/><circle cx="47" cy="42" r="4" fill="#06101f"/></svg>';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const toPosix = value => value.split(sep).join('/');

// Output path for a Markdown source, relative to the site root.
function markdownOutput(sourceRel) {
  if (sourceRel === 'README.md') return 'docs/index.html';
  if (!sourceRel.endsWith('.md')) throw new Error(`not a Markdown source: ${sourceRel}`);
  return `docs/${sourceRel.slice(0, -'.md'.length)}.html`;
}

// Relative href between two output paths; both are site-root relative.
function outputHref(fromOut, toOut) {
  return posix.relative(posix.dirname(fromOut), toOut);
}

async function findMarkdownSources(root, prefix = '') {
  const directory = prefix ? join(root, ...prefix.split('/')) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.name === '_site') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) sources.push(...await findMarkdownSources(root, rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) sources.push(rel);
  }
  return sources;
}

function stripInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

function documentTitle(source, fallback) {
  let fenced = false;
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return stripInlineMarkdown(match[1]);
  }
  return fallback;
}

function headingSlug(text) {
  const slug = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

function tokenText(tokens) {
  let text = '';
  for (const token of tokens ?? []) {
    if (token.type === 'br') text += ' ';
    else if (token.type === 'text' || token.type === 'codespan' || token.type === 'escape') text += token.text ?? '';
    else if (token.type === 'image') text += token.text ?? '';
    else if (Array.isArray(token.tokens)) text += tokenText(token.tokens);
    else text += token.text ?? '';
  }
  return text;
}

function themeVariables(landing) {
  const match = /:root\s*\{([\s\S]*?)\}/.exec(landing);
  const variables = match?.[1]?.trim();
  return variables ? variables : FALLBACK_THEME;
}

// One renderer instance per page; it rewrites every relative link from the
// Markdown file layout to the published HTML layout.
function createRenderer(context) {
  class DocsRenderer extends Renderer {
    heading(token) {
      const text = token.tokens ? tokenText(token.tokens) : token.text;
      const base = headingSlug(text || token.text);
      const seen = context.slugs.get(base) ?? 0;
      context.slugs.set(base, seen + 1);
      const id = seen ? `${base}-${seen}` : base;
      const inner = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`;
    }

    link(token) {
      const resolved = rewriteLink(token.href, context);
      const attributes = [`href="${escapeHtml(resolved.href)}"`];
      if (resolved.external) attributes.push('target="_blank"', 'rel="noopener"');
      if (token.title) attributes.push(`title="${escapeHtml(token.title)}"`);
      return `<a ${attributes.join(' ')}>${token.text}</a>`;
    }

    table(token) {
      return `<div class="table-wrap">${super.table(token)}</div>\n`;
    }
  }
  return new DocsRenderer();
}

function rewriteLink(href, context) {
  if (!href) return { href: '', external: false };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { href, external: true };
  if (href.startsWith('#')) return { href, external: false };
  const hashAt = href.indexOf('#');
  const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  if (!rawPath) return { href, external: false };
  if (rawPath.startsWith('/')) return { href, external: true };

  const targetAbs = resolve(dirname(context.sourceAbs), rawPath);
  const docsRoot = context.docsRoot;
  if (targetAbs === docsRoot || targetAbs.startsWith(docsRoot + sep)) {
    const targetRel = toPosix(relative(docsRoot, targetAbs));
    if (targetRel.endsWith('.md')) {
      return { href: outputHref(context.outRel, markdownOutput(targetRel)) + hash, external: false };
    }
    if (targetRel === 'index.html') {
      return { href: outputHref(context.outRel, 'index.html') + hash, external: false };
    }
    context.assets.add(targetRel);
    return { href: outputHref(context.outRel, `docs/${targetRel}`) + hash, external: false };
  }

  const repoRoot = context.repoRoot;
  if (targetAbs === repoRoot || targetAbs.startsWith(repoRoot + sep)) {
    const repoRel = toPosix(relative(repoRoot, targetAbs));
    return { href: `${REPOSITORY_URL}/blob/${REPOSITORY_BRANCH}/${repoRel}${hash}`, external: true };
  }
  return { href, external: true };
}

function renderSidebar(entries, currentOut, homeHref) {
  const links = entries.map(entry => {
    const active = entry.outRel === currentOut ? ' class="active"' : '';
    const href = outputHref(currentOut, entry.outRel);
    return `<a${active} href="${escapeHtml(href)}"><span>${escapeHtml(entry.title)}</span></a>`;
  }).join('\n        ');
  // CSS-only disclosure: wide screens always show the left navigation, while
  // phones start with the guide list collapsed behind one tap.
  return `<aside class="sidebar">
      <a class="back-home" href="${escapeHtml(homeHref)}">← 返回站点首页</a>
      <p class="sidebar-title">文档目录</p>
      <input class="nav-toggle" type="checkbox" id="docs-nav-toggle" aria-controls="docs-nav-list" />
      <label class="nav-toggle-label" for="docs-nav-toggle">文档目录（${entries.length}）</label>
      <nav class="doc-list" id="docs-nav-list" aria-label="文档目录">
        ${links}
      </nav>
    </aside>`;
}

function pageHtml({ title, content, entries, outputRel, homeHref, docsHref, theme }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${escapeHtml(title)} · AgentKit Studio 公开文档" />
<meta name="theme-color" content="#07080c" />
<title>${escapeHtml(title)} · AgentKit Studio 文档</title>
<link rel="icon" href="${FAVICON}" />
<style>
:root{
  ${theme}
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:#9fe9f2;text-decoration:none}
a:hover{text-decoration:underline}
code,pre{font-family:var(--mono)}
.doc-header{position:sticky;top:0;z-index:60;display:flex;align-items:center;justify-content:space-between;gap:18px;height:60px;padding:0 clamp(18px,4vw,44px);background:rgba(7,8,12,.86);backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);border-bottom:1px solid var(--line)}
.doc-header .brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.02em;font-size:15px;color:var(--ink)}
.doc-header .brand:hover{text-decoration:none}
.mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(150deg,#2f6bff,#7ee7f2);display:grid;place-items:center;box-shadow:0 8px 22px rgba(77,124,255,.4);flex:none}
.mark svg{width:20px;height:20px}
.brand-sub{color:var(--dim);font-weight:600;font-size:12.5px;padding-left:10px;border-left:1px solid var(--line-strong)}
.doc-nav{display:flex;align-items:center;gap:18px;font-size:14px;color:var(--muted)}
.doc-nav a{color:var(--muted)}
.doc-nav a:hover{color:var(--ink);text-decoration:none}
.layout{display:grid;grid-template-columns:264px minmax(0,1fr);max-width:1280px;margin:0 auto;min-height:calc(100vh - 60px)}
.sidebar{position:sticky;top:60px;align-self:start;max-height:calc(100vh - 60px);overflow:auto;padding:26px 18px 48px 22px;border-right:1px solid var(--line)}
.back-home{display:inline-flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;padding:7px 11px;border:1px solid var(--line);border-radius:9px;transition:.2s var(--ease)}
.back-home:hover{color:var(--ink);border-color:var(--line-strong);background:rgba(255,255,255,.04);text-decoration:none}
.sidebar-title{margin:26px 0 10px;color:var(--dim);font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.nav-toggle{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.nav-toggle-label{display:none;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;color:var(--muted);font-size:13px;cursor:pointer;user-select:none}
.nav-toggle-label::after{content:"▾";font-size:10px;color:var(--dim);transition:transform .2s var(--ease)}
.nav-toggle:checked ~ .doc-list{margin-top:10px}
.nav-toggle:checked ~ .nav-toggle-label::after{transform:rotate(180deg)}
.nav-toggle:focus-visible ~ .nav-toggle-label{outline:2px solid var(--cyan);outline-offset:2px}
.doc-list{display:flex;flex-direction:column;gap:2px;margin-top:10px}
.doc-list a{display:block;padding:7px 10px 7px 11px;border-radius:8px;border-left:2px solid transparent;color:var(--muted);font-size:13px;line-height:1.45;transition:.2s var(--ease)}
.doc-list a:hover{color:var(--ink);background:rgba(255,255,255,.04);text-decoration:none}
.doc-list a.active{color:#cfe0ff;background:rgba(77,124,255,.14);border-left-color:var(--blue)}
.content{min-width:0;padding:42px clamp(20px,4vw,56px) 64px;max-width:1000px}
.doc{max-width:860px}
.doc h1{margin:0 0 22px;padding-bottom:14px;border-bottom:1px solid var(--line);font-size:clamp(29px,3.2vw,38px);line-height:1.2;letter-spacing:-.035em;font-weight:640;color:var(--ink)}
.doc h2{margin:42px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line);font-size:clamp(22px,2.2vw,27px);line-height:1.3;letter-spacing:-.02em;font-weight:620}
.doc h3{margin:30px 0 10px;font-size:20px;line-height:1.4;letter-spacing:-.01em;font-weight:620;color:#dfe6f5}
.doc h4{margin:24px 0 8px;font-size:16.5px;font-weight:620;color:#d6deee}
.doc p{margin:14px 0;color:#c9d3e6}
.doc li{color:#c9d3e6}
.doc strong{color:var(--ink);font-weight:640}
.doc ul,.doc ol{margin:14px 0;padding-left:24px}
.doc li{margin:6px 0}
.doc li::marker{color:var(--cyan)}
.doc code{padding:2px 6px;border:1px solid rgba(126,231,242,.16);border-radius:5px;background:rgba(126,231,242,.08);color:#a9f0f7;font-size:12.5px;overflow-wrap:anywhere}
.doc pre{margin:18px 0;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:#0a0c12;overflow-x:auto;font-size:13px;line-height:1.7}
.doc pre code{padding:0;border:0;background:none;color:#c9d3e6;font-size:13px;white-space:pre;overflow-wrap:normal}
.table-wrap{margin:18px 0;overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.015)}
.doc table{width:100%;border-collapse:collapse;font-size:14px}
.doc th{background:rgba(255,255,255,.04);color:var(--ink);font-weight:620;text-align:left}
.doc th,.doc td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
.doc tbody tr:last-child td{border-bottom:0}
.doc blockquote{margin:18px 0;padding:12px 18px;border-left:2px solid var(--cyan);border-radius:0 10px 10px 0;background:rgba(126,231,242,.05);color:var(--muted)}
.doc blockquote p{margin:0;color:var(--muted)}
.doc hr{margin:34px 0;border:0;border-top:1px solid var(--line)}
.doc img{max-width:100%;height:auto;border-radius:12px}
.doc-footer{display:flex;flex-wrap:wrap;gap:10px;align-items:center;max-width:860px;margin-top:52px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.doc-footer a{color:var(--muted)}
.doc-footer a:hover{color:var(--ink)}
::selection{background:rgba(77,124,255,.35);color:#fff}
@media(max-width:900px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line);padding:20px clamp(18px,4vw,44px) 22px}
  .sidebar-title{display:none}
  .nav-toggle-label{display:flex;margin-top:18px}
  .doc-list{display:none}
  .nav-toggle:checked ~ .doc-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:2px}
  .content{padding-top:30px}
}
@media(max-width:560px){
  .brand-sub{display:none}
  .doc-nav{gap:12px}
  .doc th,.doc td{padding:8px 10px}
}
</style>
</head>
<body>
<header class="doc-header">
  <a class="brand" href="${escapeHtml(homeHref)}">
    <span class="mark" aria-hidden="true">${MARK_SVG}</span>
    <span>AgentKit Studio</span><span class="brand-sub">文档</span>
  </a>
  <nav class="doc-nav" aria-label="站点导航">
    <a href="${escapeHtml(docsHref)}">文档目录</a>
    <a href="${REPOSITORY_URL}" target="_blank" rel="noopener">GitHub ↗</a>
  </nav>
</header>
<div class="layout">
  ${renderSidebar(entries, outputRel, homeHref)}
  <main class="content">
    <article class="doc">
${content.trimEnd()}
    </article>
    <footer class="doc-footer">
      <a href="${escapeHtml(homeHref)}">AgentKit Studio 首页</a>
      <span>·</span>
      <a href="${escapeHtml(docsHref)}">文档目录</a>
      <span>·</span>
      <a href="${REPOSITORY_URL}" target="_blank" rel="noopener">GitHub</a>
    </footer>
  </main>
</div>
</body>
</html>
`;
}

function normalizeOutput(value) {
  if (!value) throw new Error('--output requires a directory');
  return resolve(process.cwd(), value);
}

function parseArgs(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      index += 1;
      output = normalizeOutput(argv[index]);
    } else if (argument === '--help' || argument === '-h') {
      console.log('usage: node scripts/build-docs-site.mjs [--output <directory>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { output: output ?? DEFAULT_OUTPUT };
}

export async function buildDocsSite({ output = DEFAULT_OUTPUT, docsRoot = DOCS_ROOT } = {}) {
  const landing = await readFile(join(docsRoot, 'index.html'), 'utf8');
  const theme = themeVariables(landing);
  const sources = await findMarkdownSources(docsRoot);
  if (!sources.length) throw new Error('no Markdown guides found under docs/');

  const entries = [];
  const contents = new Map();
  for (const sourceRel of sources) {
    const source = await readFile(join(docsRoot, ...sourceRel.split('/')), 'utf8');
    contents.set(sourceRel, source);
    const fallback = sourceRel.replace(/\.md$/, '').split('/').pop();
    const title = sourceRel === 'README.md'
      ? DOCS_INDEX_LABEL
      : documentTitle(source, fallback);
    entries.push({ sourceRel, title, outRel: markdownOutput(sourceRel) });
  }
  entries.sort((left, right) => {
    if (left.sourceRel === 'README.md') return -1;
    if (right.sourceRel === 'README.md') return 1;
    return left.sourceRel.localeCompare(right.sourceRel);
  });

  const repoRoot = resolve(docsRoot, '..');
  const assets = new Set();
  const pages = new Map();
  for (const entry of entries) {
    const context = {
      docsRoot,
      repoRoot,
      sourceAbs: join(docsRoot, ...entry.sourceRel.split('/')),
      outRel: entry.outRel,
      slugs: new Map(),
      assets,
    };
    const body = marked.parse(contents.get(entry.sourceRel), {
      gfm: true,
      async: false,
      renderer: createRenderer(context),
    });
    const homeHref = outputHref(entry.outRel, 'index.html');
    const docsHref = outputHref(entry.outRel, 'docs/index.html');
    pages.set(entry.outRel, pageHtml({
      title: entry.title,
      content: body,
      entries,
      outputRel: entry.outRel,
      homeHref,
      docsHref,
      theme,
    }));
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // The landing page is published verbatim; only the docs tree is generated.
  await writeFile(join(output, 'index.html'), landing);
  for (const sourceRel of sources) {
    const entry = entries.find(candidate => candidate.sourceRel === sourceRel);
    const destination = join(output, ...entry.outRel.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, pages.get(entry.outRel));
  }

  let copiedAssets = 0;
  for (const assetRel of [...assets].sort()) {
    const source = join(docsRoot, ...assetRel.split('/'));
    let info;
    try { info = await stat(source); } catch { continue; }
    if (!info.isFile()) continue;
    const destination = join(output, 'docs', ...assetRel.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    copiedAssets += 1;
  }

  return { output, pages: entries.length, assets: copiedAssets };
}

async function main() {
  try {
    const { output } = parseArgs(process.argv.slice(2));
    const result = await buildDocsSite({ output });
    const shown = toPosix(relative(process.cwd(), result.output)) || '.';
    console.log(`docs site: wrote ${result.pages} pages (${result.assets} assets) to ${shown}`);
  } catch (error) {
    console.error(`docs site build failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
