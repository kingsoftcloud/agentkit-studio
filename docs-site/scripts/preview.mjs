// Local preview that mirrors GitHub Pages project-site serving.
//
// The production build carries `basePath: /agentkit-studio`, so serving `out/`
// at the domain root would 404 every `_next/` asset. This server mounts `out/`
// under `/agentkit-studio/` exactly like the deployed site.
//
// Usage: node scripts/preview.mjs [port]

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const BASE = '/agentkit-studio';
const outDir = resolve(process.cwd(), 'out');
const port = Number(process.argv[2] || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0]));
  // Reject traversal per path segment: bundler chunk names legitimately contain
  // `..` (e.g. `0ph9f_jx~zcf..js`), so a substring check breaks real assets.
  if (clean.split('/').includes('..')) return null;

  const relative = clean.startsWith(BASE) ? clean.slice(BASE.length) : clean;
  const target = join(outDir, relative);
  const candidates = [
    target,
    join(target, 'index.html'),
    `${target}.html`,
  ];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

createServer((request, response) => {
  const urlPath = request.url ?? '/';

  if (urlPath === '/' || urlPath === BASE) {
    response.writeHead(302, { Location: `${BASE}/` });
    response.end();
    return;
  }

  const file = resolveFile(urlPath);
  if (!file) {
    const notFound = join(outDir, '404.html');
    response.writeHead(404, { 'Content-Type': TYPES['.html'] });
    createReadStream(notFound).pipe(response);
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`docs preview: http://127.0.0.1:${port}${BASE}/`);
});
