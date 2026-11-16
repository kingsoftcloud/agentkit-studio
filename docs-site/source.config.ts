import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { visit } from 'unist-util-visit';
import { z } from 'zod';

/**
 * Public documentation collection.
 *
 * Chinese is the default language and uses plain file names (`page.mdx`).
 * English uses the `.en.mdx` suffix. `meta.json` / `meta.en.json` define the
 * sidebar for each locale, and `tests/docs-site-i18n.test.mjs` fails the build
 * when the two locales drift apart.
 */
export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // `status` renders a sidebar badge (`new` / `beta` / `deprecated`), which is
    // how we mark capability maturity in a product that ships experimental
    // surfaces.
    schema: pageSchema.extend({ status: z.string().optional() }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// GitHub Pages serves under a base path (/agentkit-studio). Next prefixes
// `_next/` assets and next/link hrefs automatically, but not raw <img src>
// from markdown, so prepend the base path at build time.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

function rehypeBasePathImages() {
  // biome-ignore lint/suspicious/noExplicitAny: hast tree nodes
  return (tree: any) => {
    if (!BASE_PATH) return;
    // biome-ignore lint/suspicious/noExplicitAny: hast element node
    visit(tree, 'element', (node: any) => {
      const src = node.properties?.src;
      if (
        node.tagName === 'img' &&
        typeof src === 'string' &&
        src.startsWith('/') &&
        !src.startsWith(`${BASE_PATH}/`)
      ) {
        node.properties.src = `${BASE_PATH}${src}`;
      }
    });
  };
}

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (v) => [...v, remarkMdxMermaid],
    rehypePlugins: (v) => [...v, rehypeBasePathImages],
  },
});
