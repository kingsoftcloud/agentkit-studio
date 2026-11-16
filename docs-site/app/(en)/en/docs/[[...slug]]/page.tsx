import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import { gitConfig, publicSiteUrl } from '@/lib/shared';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug, 'en');
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const suffix = page.slugs.length > 0 ? `${page.slugs.join('/')}/` : '';

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} footer={{ enabled: false }}>
      <div className="flex flex-col items-start justify-between gap-4 border-b pb-4 sm:flex-row sm:items-center">
        <div className="flex flex-col gap-2">
          <DocsTitle className="mb-0">{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
        </div>
        <div className="flex shrink-0 flex-row items-center gap-2">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/docs-site/content/docs/${page.path}`}
          />
        </div>
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.getPages('en').map((page) => ({ slug: page.slugs }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug, 'en');
  if (!page) notFound();

  const suffix = page.slugs.length > 0 ? `${page.slugs.join('/')}/` : '';
  const localizedUrl = (locale: string) =>
    locale === 'en' ? `${publicSiteUrl}/en/docs/${suffix}` : `${publicSiteUrl}/docs/${suffix}`;

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: localizedUrl('en'),
      languages: {
        'zh-CN': localizedUrl('cn'),
        en: localizedUrl('en'),
        'x-default': localizedUrl('cn'),
      },
    },
    openGraph: {
      url: localizedUrl('en'),
      locale: 'en_US',
      images: `${publicSiteUrl}${getPageImage(page).url}`,
    },
  };
}
