import { createElement } from 'react';
import { icons } from 'lucide-react';
import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
import { statusBadgesPlugin } from 'fumadocs-core/source/plugins/status-badges';
import { i18n } from './i18n';
import { docsRoute } from './shared';

type Page = ReturnType<typeof source.getPages>[number];

export const source = loader({
  baseUrl: docsRoute,
  i18n,
  // Resolve `icon` strings in meta.json (root tabs, groups) to lucide icons.
  icon(name) {
    if (name && name in icons) {
      return createElement(icons[name as keyof typeof icons]);
    }
  },
  source: docs.toFumadocsSource(),
  // Renders a sidebar badge for pages whose frontmatter sets `status`
  // (`new` / `beta` / `deprecated`), so capability maturity is visible in
  // navigation instead of buried in prose.
  plugins: [
    statusBadgesPlugin({
      renderBadge: (status: string) =>
        createElement(
          'span',
          {
            className:
              'ms-auto shrink-0 rounded-full bg-fd-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fd-primary',
          },
          status,
        ),
    }),
  ],
});

/** Open Graph image URL for a page: `/og/docs/<slug>/image.png`. */
export function getPageImage(page: Page) {
  const segments = page.locale === 'en'
    ? ['en', 'docs', ...page.slugs, 'image.png']
    : ['docs', ...page.slugs, 'image.png'];

  return { segments, url: `/og/${segments.join('/')}` };
}

/** Raw Markdown URL for a page: `/llms.mdx/docs/<slug>/content.md`. */
export function getPageMarkdownUrl(page: Page) {
  const segments = page.locale === 'en'
    ? ['en', 'docs', ...page.slugs, 'content.md']
    : ['docs', ...page.slugs, 'content.md'];

  return {
    segments,
    // GitHub Pages serves under `/<repository>`, so the markdown URL used by
    // the copy/view buttons must carry the base path too.
    url: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/llms.mdx/${segments.join('/')}`,
  };
}

export async function getLLMText(page: Page): Promise<string> {
  const processed = await page.data.getText('processed');
  return `# ${page.data.title}\n\n${page.data.description ? `${page.data.description}\n\n` : ''}${processed}`;
}
