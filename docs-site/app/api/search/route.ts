import { createFromSource } from 'fumadocs-core/search/server';
import { createTokenizer } from '@orama/tokenizers/mandarin';
import { source } from '@/lib/source';

export const revalidate = false;

// The full corpus is ~19k lines across 130 pages. Indexing every paragraph
// verbatim produces a ~21 MB payload that the browser would have to download
// before showing a single result, so the index keeps the complete heading
// outline plus a bounded excerpt per section. Search still lands on the right
// page; the excerpt only feeds the result preview.
const MAX_SECTIONS = 12;
const MAX_EXCERPT = 240;

/**
 * Build-time search index, one per locale.
 *
 * Chinese has no word delimiters, so the default whitespace tokenizer would
 * index whole sentences and never match a query. `@orama/tokenizers/mandarin`
 * performs real word segmentation.
 */
export const { staticGET: GET } = createFromSource(source, {
  localeMap: {
    cn: {
      components: { tokenizer: createTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
    en: { language: 'english' },
  },
  buildIndex(page) {
    const raw = page.data.structuredData;
    const structured = typeof raw === 'function' ? undefined : raw;

    return {
      id: page.url,
      title: page.data.title,
      description: page.data.description,
      breadcrumbs: page.slugs,
      url: page.url,
      structuredData: {
        headings: structured?.headings ?? [],
        contents: (structured?.contents ?? []).slice(0, MAX_SECTIONS).map(section => ({
          heading: section.heading,
          content: section.content.slice(0, MAX_EXCERPT),
        })),
      },
    };
  },
});
