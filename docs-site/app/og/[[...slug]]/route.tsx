import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { notFound } from 'next/navigation';
import { appName } from '@/lib/shared';
import { getPageImage, source } from '@/lib/source';

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const locale = slug[0] === 'en' ? 'en' : 'cn';
  const rest = locale === 'en' ? slug.slice(1) : slug;
  const pageSlugs = rest.slice(1, -1);

  const page = source.getPage(pageSlugs, locale);
  if (!page) notFound();

  return new ImageResponse(
    <DefaultImage
      title={page.data.title}
      description={page.data.description}
      site={appName}
    />,
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return ['cn', 'en'].flatMap((locale) =>
    source.getPages(locale).map((page) => ({ slug: getPageImage(page).segments })),
  );
}
