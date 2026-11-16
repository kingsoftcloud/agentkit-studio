export const appName = 'AgentKit Studio';

/** Deployed site root (GitHub Pages project site). */
export const publicSiteUrl = 'https://kingsoftcloud.github.io/agentkit-studio';

/** GitHub Pages serves a project site under `/<repository>`. */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Prefix a `/public`-style asset with the deployment base path. */
export function assetPath(path: string): string {
  return `${basePath}${path}`;
}

/** Documentation route root for the default (Chinese) locale. */
export const docsRoute = '/docs';

export const gitConfig = {
  user: 'kingsoftcloud',
  repo: 'agentkit-studio',
  branch: 'main',
} as const;

/** `/docs/...` for Chinese, `/en/docs/...` for English. */
export function localizedDocsRoute(locale: string): string {
  return locale === 'en' ? '/en/docs' : '/docs';
}
