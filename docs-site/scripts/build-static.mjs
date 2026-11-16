// Static export build for GitHub Pages.
//
// `next build` with `output: 'export'` emits the site into `out/`. Two things
// the framework cannot do for us are handled here:
//
//   1. The hand-written landing page lives at `docs-site/landing/index.html` (it
//      is the marketing/download page, outside the documentation routes). It is
//      copied verbatim to the site root so `/` keeps its current design.
//   2. GitHub Pages needs `.nojekyll` (so `_next/` is served) and a `404.html`
//      that sends readers back to the documentation index.
//
// Usage:
//   NEXT_PUBLIC_BASE_PATH=/agentkit-studio pnpm build:static

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'out');
const repoRoot = resolve(root, '..');
const landingPage = join(root, 'landing', 'index.html');

execSync('next build', {
  stdio: 'inherit',
  env: { ...process.env, NEXT_STATIC_EXPORT: '1' },
});

mkdirSync(outDir, { recursive: true });

// GitHub Pages: disable Jekyll so the `_next/` folder is served.
writeFileSync(join(outDir, '.nojekyll'), '');

// Keep the existing landing page at `/` (out of scope for the docs rewrite).
//
// Version strings are injected from the single source of truth rather than
// hand-edited, so the marketing page can never advertise a DSH baseline the
// repository does not pin. `scripts/check-dsh-pin.mjs` fails the build if the
// placeholder is removed.
if (existsSync(landingPage)) {
  const dshPin = JSON.parse(readFileSync(join(repoRoot, 'dsh-pin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

  const landing = readFileSync(landingPage, 'utf8')
    .replaceAll('{{DSH_VERSION}}', dshPin.version)
    .replaceAll('{{PLUGIN_VERSION}}', pkg.version);

  const unresolved = landing.match(/\{\{[A-Z_]+\}\}/gu);
  if (unresolved) throw new Error(`unresolved landing page placeholders: ${[...new Set(unresolved)].join(', ')}`);

  writeFileSync(join(outDir, 'index.html'), landing);
  console.log(`[build:static] copied docs-site/landing/index.html (DSH ${dshPin.version}, plugin ${pkg.version})`);
} else {
  console.warn(`[build:static] WARNING: landing page not found at ${landingPage}`);
}

// Next's static export writes a React Server Component payload per route, but
// the *root* payload is only emitted when the root route has a page. The docs
// app deliberately owns no page at `/` (the landing page is a static file), so
// client-side prefetch asks for `/__next._tree.txt` and 404s. Mirror the
// Chinese root payload to the site root to keep the router quiet; each locale
// still loads its own payload under `/docs/` or `/en/docs/`.
// Both locale trees emit their own segment payload names (`!KHpoKQ` for
// Chinese, `!KGVuKQ` for English), so copying both sets is safe.
for (const localeDir of ['docs', join('en', 'docs')]) {
  const directory = join(outDir, localeDir);
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith('__next.')) continue;
    copyFileSync(join(directory, name), join(outDir, name));
  }
}

// GitHub Pages serves `404.html` for unknown paths; send readers to the docs
// index instead of a dead end.
writeFileSync(
  join(outDir, '404.html'),
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>页面不存在 · AgentKit Studio 文档</title>
<meta name="robots" content="noindex" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #07080c; color: #eef1f7;
         font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 2rem; margin: 0 0 .5rem; letter-spacing: -.02em; }
  p { color: #98a1b3; margin: 0 0 1.75rem; }
  a { display: inline-block; padding: .65rem 1.25rem; border-radius: 10px;
      text-decoration: none; font-weight: 600; color: #06101f;
      background: linear-gradient(100deg, #9fb6ff 0%, #7ee7f2 48%, #9d8bff 100%); }
  a + a { margin-left: .75rem; background: none; color: #eef1f7; border: 1px solid rgba(255,255,255,.14); }
</style>
</head>
<body>
<main>
  <h1>404</h1>
  <p>这个页面不存在，或者已经移动到新的文档结构中。</p>
  <a href="/agentkit-studio/docs/">返回文档</a>
  <a href="/agentkit-studio/">返回首页</a>
</main>
</body>
</html>
`,
);

console.log('[build:static] wrote out/.nojekyll and out/404.html');
