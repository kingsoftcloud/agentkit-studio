import { notFound } from 'next/navigation';
import { getLLMText, getPageMarkdownUrl, source } from '@/lib/source';

export const revalidate = false;

/**
 * Raw Markdown for one page.
 *
 * `/llms.mdx/docs/<slug>/content.md`         → Chinese
 * `/llms.mdx/en/docs/<slug>/content.md`      → English
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const locale = slug[0] === 'en' ? 'en' : 'cn';
  const rest = locale === 'en' ? slug.slice(1) : slug;
  // Drop the leading `docs` segment and the trailing `content.md` file name.
  const pageSlugs = rest.slice(1, -1);

  const page = source.getPage(pageSlugs, locale);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return ['cn', 'en'].flatMap((locale) =>
    source.getPages(locale).map((page) => ({ slug: getPageMarkdownUrl(page).segments })),
  );
}
