import { i18nProvider } from 'fumadocs-ui/i18n';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import SearchDialog from '@/components/search';
import { translations } from '@/lib/i18n-ui';
import { publicSiteUrl } from '@/lib/shared';
import '../global.css';

export const metadata: Metadata = {
  metadataBase: new URL(`${publicSiteUrl}/`),
  alternates: {
    canonical: `${publicSiteUrl}/docs/`,
    languages: {
      'zh-CN': `${publicSiteUrl}/docs/`,
      en: `${publicSiteUrl}/en/docs/`,
      'x-default': `${publicSiteUrl}/docs/`,
    },
  },
};

export default function ChineseRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider i18n={i18nProvider(translations, 'cn')} search={{ SearchDialog }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
