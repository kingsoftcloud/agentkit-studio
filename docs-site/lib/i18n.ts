import { defineI18n } from 'fumadocs-core/i18n';

/**
 * Single site, two languages.
 *
 * - Chinese is the default language and has **no URL prefix** (`/docs/...`),
 *   which keeps every existing `…/docs/<page>` link working.
 * - English is served under `/en/docs/...`.
 *
 * `fallbackLanguage: null` is load-bearing: an English URL must never render
 * Chinese content. Combined with `tests/docs-site-i18n.test.mjs` it turns a
 * missing translation into a build failure instead of a silent half-translated
 * page.
 */
export const i18n = defineI18n({
  defaultLanguage: 'cn',
  languages: ['cn', 'en'],
  hideLocale: 'default-locale',
  fallbackLanguage: null,
});
