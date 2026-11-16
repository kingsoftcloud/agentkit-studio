import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig, localizedDocsRoute } from './shared';

export function baseOptions(locale: string): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-bold ak-studio-gradient">{appName}</span>
      ),
      url: localizedDocsRoute(locale),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        text: locale === 'en' ? 'Home' : '官网',
        url: '/',
        external: false,
      },
    ],
  };
}
