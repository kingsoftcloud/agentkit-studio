import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// GitHub Pages project site: https://kingsoftcloud.github.io/agentkit-studio/
// Set at build time; empty for local development so the site serves from `/`.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Static export (GitHub Pages) is opt-in: `output: 'export'` cannot include
// dynamic route handlers, and the docs site only needs the static build.
const staticExport = process.env.NEXT_STATIC_EXPORT === '1';

/** @type {import('next').NextConfig} */
const config = {
  ...(staticExport ? { output: 'export' } : {}),
  reactStrictMode: true,
  trailingSlash: true,
  allowedDevOrigins: ['127.0.0.1'],
  turbopack: {
    root: import.meta.dirname,
  },
  images: {
    unoptimized: true,
  },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default withMDX(config);
