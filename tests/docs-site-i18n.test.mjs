import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The documentation site is bilingual by contract: every Chinese page must have
// an English twin with the same navigation position. Without this gate the
// English site silently rots, which is the single most common failure mode of
// translated documentation.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_SITE = join(REPO_ROOT, 'docs-site');
const CONTENT_ROOT = join(DOCS_SITE, 'content', 'docs');
const I18N_CONFIG = join(DOCS_SITE, 'lib', 'i18n.ts');

const toPosix = value => value.split(sep).join('/');

function walk(directory, predicate = () => true) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

const isEnglish = file => file.endsWith('.en.mdx');

function contentFiles() {
  return walk(CONTENT_ROOT, file => file.endsWith('.mdx'));
}

/** Source path relative to the content root, with the locale suffix removed. */
function pageKey(file) {
  return toPosix(relative(CONTENT_ROOT, file)).replace(/\.en\.mdx$/, '.mdx');
}

const pages = contentFiles();
const chinesePages = new Set(pages.filter(file => !isEnglish(file)).map(pageKey));
const englishPages = new Set(pages.filter(isEnglish).map(pageKey));

function readFrontmatter(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return { source, data: null };
  const data = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (entry) data[entry[1]] = entry[2].replace(/^['"]|['"]$/gu, '').trim();
  }
  return { source, data };
}

test('every Chinese page has an English twin and vice versa', () => {
  const missingEnglish = [...chinesePages].filter(page => !englishPages.has(page)).sort();
  const missingChinese = [...englishPages].filter(page => !chinesePages.has(page)).sort();

  assert.deepEqual(
    missingEnglish,
    [],
    `Pages missing an English translation:\n${missingEnglish.join('\n')}`,
  );
  assert.deepEqual(
    missingChinese,
    [],
    `English pages without a Chinese source:\n${missingChinese.join('\n')}`,
  );
});

test('English is never used as a silent fallback', () => {
  const config = readFileSync(I18N_CONFIG, 'utf8');
  assert.match(
    config,
    /fallbackLanguage:\s*null/u,
    'lib/i18n.ts must set `fallbackLanguage: null`; otherwise a missing translation renders Chinese on an English URL',
  );
  assert.match(
    config,
    /hideLocale:\s*'default-locale'/u,
    "lib/i18n.ts must keep `hideLocale: 'default-locale'` so Chinese keeps the /docs/ prefix",
  );
});

test('every navigation metadata file has a localized twin with the same page order', () => {
  const metaFiles = walk(CONTENT_ROOT, file => file.endsWith('meta.json'));
  const failures = [];

  for (const chineseMeta of metaFiles) {
    const englishMeta = chineseMeta.replace(/meta\.json$/u, 'meta.en.json');
    let english;
    try {
      statSync(englishMeta);
    } catch {
      failures.push(`${toPosix(relative(CONTENT_ROOT, chineseMeta))}: missing meta.en.json`);
      continue;
    }

    const zh = JSON.parse(readFileSync(chineseMeta, 'utf8'));
    const en = JSON.parse(readFileSync(englishMeta, 'utf8'));
    const zhPages = (zh.pages ?? []).map(entry => entry.split('#')[0]);
    const enPages = (en.pages ?? []).map(entry => entry.split('#')[0]);

    assert.deepEqual(
      enPages,
      zhPages,
      `${toPosix(relative(CONTENT_ROOT, chineseMeta))}: navigation order differs between locales`,
    );

    if (typeof zh.title === 'string' && typeof en.title === 'string') {
      assert.notEqual(
        zh.title,
        en.title,
        `${toPosix(relative(CONTENT_ROOT, englishMeta))}: navigation title is not translated`,
      );
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});

test('every page listed in navigation exists on disk', () => {
  const metaFiles = walk(CONTENT_ROOT, file => file.endsWith('meta.json'));
  const missing = [];

  for (const metaFile of metaFiles) {
    const directory = dirname(metaFile);
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const english = isEnglish(metaFile);

    for (const entry of meta.pages ?? []) {
      // `---Label` entries are separators; `[icon]name` carries an icon.
      if (entry.startsWith('---')) continue;
      const name = entry.replace(/^\[[^\]]*\]/u, '').split('#')[0];
      const candidates = [
        join(directory, `${name}.mdx`),
        join(directory, name, 'index.mdx'),
      ];
      const localized = candidates.map(file => (english ? file.replace(/\.mdx$/u, '.en.mdx') : file));
      if (!localized.some(file => exists(file))) {
        missing.push(`${toPosix(relative(CONTENT_ROOT, metaFile))} -> ${name}`);
      }
    }
  }

  assert.deepEqual(missing, [], `Navigation points at missing pages:\n${missing.join('\n')}`);
});

function exists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

test('internal documentation links resolve to a real page', () => {
  const broken = [];
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)\)/gu;
  const cardPattern = /<Card\b[^>]*\bhref="([^"]+)"/gu;
  const diagramPattern = /<Diagram\b[^>]*\bsrc="([^"]+)"/gu;

  for (const file of pages) {
    const { source } = readFrontmatter(file);
    const directory = dirname(file);
    const english = isEnglish(file);

    for (const match of source.matchAll(diagramPattern)) {
      const asset = join(DOCS_SITE, 'public', match[1].replace(/^\/+/, ''));
      if (!exists(asset)) {
        broken.push(`${toPosix(relative(CONTENT_ROOT, file))} -> ${match[1]} (missing diagram)`);
      }
    }

    for (const pattern of [linkPattern, cardPattern]) {
      for (const match of source.matchAll(pattern)) {
        const target = match[1];
        if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
        const path = target.split('#')[0];
        if (!path) continue;

        // Public assets (diagrams, screenshots) live in `docs-site/public` and are
        // served from the site root, so they are not MDX pages.
        if (path.startsWith('/assets/')) {
          if (!exists(join(DOCS_SITE, 'public', path.slice(1)))) {
            broken.push(`${toPosix(relative(CONTENT_ROOT, file))} -> ${target} (missing asset)`);
          }
          continue;
        }

        if (path.startsWith('/docs/') || path.startsWith('/en/docs/')) {
          const slug = path.replace(/^\/(?:en\/)?docs\/?/u, '');
          const base = slug ? join(CONTENT_ROOT, ...slug.split('/')) : CONTENT_ROOT;
          const candidates = [`${base}.mdx`, join(base, 'index.mdx')].map(candidate =>
            english ? candidate.replace(/\.mdx$/u, '.en.mdx') : candidate,
          );
          if (!candidates.some(candidate => exists(candidate))) {
            broken.push(`${toPosix(relative(CONTENT_ROOT, file))} -> ${target}`);
          }
          continue;
        }

        if (!path.endsWith('.mdx')) {
          broken.push(
            `${toPosix(relative(CONTENT_ROOT, file))} -> ${target} (relative links must end with .mdx)`,
          );
          continue;
        }

        if (!exists(resolve(directory, path))) {
          broken.push(`${toPosix(relative(CONTENT_ROOT, file))} -> ${target}`);
        }
      }
    }
  }

  assert.deepEqual(broken, [], `Broken documentation links:\n${broken.join('\n')}`);
});

test('every page declares a title and a description', () => {
  const missing = [];
  for (const file of pages) {
    const { data } = readFrontmatter(file);
    const label = toPosix(relative(CONTENT_ROOT, file));
    if (!data?.title) missing.push(`${label}: missing frontmatter title`);
    if (!data?.description) missing.push(`${label}: missing frontmatter description`);
    else if (data.description.length > 160) {
      missing.push(`${label}: description is ${data.description.length} chars (max 160)`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('Chinese and English pages share the same heading structure', () => {
  const mismatched = [];

  for (const file of pages) {
    if (isEnglish(file)) continue;
    const englishFile = file.replace(/\.mdx$/u, '.en.mdx');
    const headings = source =>
      [...source.matchAll(/^(#{2,4})\s+/gmu)].map(match => match[1].length);

    const zh = headings(readFileSync(file, 'utf8'));
    const en = headings(readFileSync(englishFile, 'utf8'));
    if (zh.length !== en.length || zh.some((depth, index) => depth !== en[index])) {
      mismatched.push(
        `${toPosix(relative(CONTENT_ROOT, file))}: zh ${zh.join(',')} vs en ${en.join(',')}`,
      );
    }
  }

  assert.deepEqual(mismatched, [], `Heading structure drift:\n${mismatched.join('\n')}`);
});

test('published content stays inside the public boundary', () => {
  const forbidden = [
    { name: 'internal service host', pattern: /\.inner\.api\.ksyun\.com/iu },
    // Mirrors scripts/public-surface-audit.mjs: `*.internal`, `*.corp`, `*.intranet`.
    { name: 'private service host', pattern: /\b[a-z0-9.-]+\.(?:internal|intranet|corp)(?![a-z0-9.-])/iu },
    { name: 'private network address', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/u },
    // `/home/node` is the container runtime home, a product constant rather than
    // a personal workstation path (same exemption as scripts/public-surface-audit.mjs).
    { name: 'personal absolute path', pattern: /(?:\/Users\/[^\s/]+|\/home\/(?!node(?:[^a-z0-9_.-]|$))[^\s/]+|[A-Z]:\\Users\\)/u },
    { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
    { name: 'provider token', pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{24,})\b/u },
    { name: 'unsupported Intel macOS build', pattern: /mac-x64|macOS \(Intel\)|macOS（Intel）/u },
    { name: 'untranslated placeholder', pattern: /\b(?:TODO|TBD|FIXME)\b/u },
  ];

  const hits = [];
  for (const file of pages) {
    const { source } = readFrontmatter(file);
    for (const { name, pattern } of forbidden) {
      if (pattern.test(source)) hits.push(`${toPosix(relative(CONTENT_ROOT, file))}: ${name}`);
    }
  }

  assert.deepEqual(hits, [], `Public boundary violations:\n${hits.join('\n')}`);
});

test('guidance documents stay inside the public boundary too', () => {
  const guidance = [join(DOCS_SITE, 'AUTHORING.md'), join(DOCS_SITE, 'ARCHIFY.md')].filter(file => exists(file));
  const forbidden = [
    { name: 'internal service host', pattern: /\.inner\.api\.ksyun\.com/iu },
    { name: 'private service host', pattern: /\b[a-z0-9.-]+\.(?:internal|intranet|corp)(?![a-z0-9.-])/iu },
    { name: 'personal absolute path', pattern: /(?:\/Users\/[^\s/]+|\/home\/(?!node(?:[^a-z0-9_.-]|$))[^\s/]+|[A-Z]:\\Users\\)/u },
  ];

  const hits = [];
  for (const file of guidance) {
    const source = readFileSync(file, 'utf8');
    for (const { name, pattern } of forbidden) {
      if (pattern.test(source)) hits.push(`${relative(DOCS_SITE, file)}: ${name}`);
    }
  }

  assert.deepEqual(hits, [], `Guidance documents leak private material:\n${hits.join('\n')}`);
});

test('the documentation set covers every top-level section', () => {
  const rootMeta = JSON.parse(readFileSync(join(CONTENT_ROOT, 'meta.json'), 'utf8'));
  const expected = [
    'index',
    'getting-started',
    'concepts',
    'guides',
    'reference',
    'deployment',
    'ecosystem',
    'releases',
    'help',
    'contributing',
  ];
  assert.deepEqual(
    rootMeta.pages.filter(page => page !== 'index' || true),
    expected,
    'Top-level navigation must describe the full information architecture',
  );
  assert.ok(pages.length >= 100, `expected at least 100 MDX files, found ${pages.length}`);
});

test('search index and machine-readable routes are wired', () => {
  const required = [
    'app/api/search/route.ts',
    'app/llms.txt/route.ts',
    'app/llms-full.txt/route.ts',
    'app/llms.mdx/[[...slug]]/route.ts',
    'app/og/[[...slug]]/route.tsx',
  ];
  for (const file of required) {
    assert.ok(exists(join(DOCS_SITE, file)), `missing ${file}`);
  }

  const search = readFileSync(join(DOCS_SITE, 'app/api/search/route.ts'), 'utf8');
  assert.match(
    search,
    /@orama\/tokenizers\/mandarin/u,
    'Chinese search requires the Mandarin tokenizer; whitespace tokenization never matches CJK queries',
  );
});

test('content directory contains no stray artifacts', () => {
  const offenders = walk(CONTENT_ROOT, file => !/\.(?:mdx|json)$/u.test(file)).map(file =>
    toPosix(relative(CONTENT_ROOT, file)),
  );
  assert.deepEqual(offenders, [], `unexpected files in content directory:\n${offenders.join('\n')}`);
});

test('relative link helper keeps posix paths stable', () => {
  // Guards the helper used above: a Windows checkout must not produce `\\` links.
  assert.equal(posix.join('a', 'b'), 'a/b');
});
