import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The public documentation states a runtime count in prose. Prose drifts: when a
// runtime is added to or removed from STUDIO_RUNTIME_TYPES, every hardcoded
// "three runtimes" rots silently and the site starts contradicting the product.
//
// This gate makes the count executable. The source is the single authority; the
// docs must agree with it, and the internal experimental runtime must never leak
// into public pages.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_ROOT = join(REPO_ROOT, 'docs-site', 'content', 'docs');
const CONTRACT_FILE = join(REPO_ROOT, 'src', 'runtime-contract.mjs');

const toPosix = value => value.split(sep).join('/');

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.name.endsWith('.mdx')) files.push(absolute);
  }
  return files.sort();
}

async function contract() {
  const module = await import(CONTRACT_FILE);
  return {
    runtimes: [...module.STUDIO_RUNTIME_TYPES],
    experimental: [...module.STUDIO_EXPERIMENTAL_RUNTIME_TYPES],
  };
}

/**
 * Only *total* claims are gated. Pages legitimately say things like "managed
 * deployment accepts two runtimes" or "only one runtime supports resume"; those
 * describe a subset and stay valid when the total changes. The patterns below
 * therefore require an explicit totality marker (a heading, 共, "there are",
 * "exactly") so a subset sentence is never mistaken for a stale count.
 */
const CHINESE_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ENGLISH_DIGITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ZH = '[一二两三四五六七八九十]';
const EN = 'one|two|three|four|five|six|seven|eight|nine|ten';

const toCount = (raw) =>
  /^\d+$/.test(raw) ? Number(raw) : (CHINESE_DIGITS[raw] ?? ENGLISH_DIGITS[raw.toLowerCase()]);

const TOTAL_PATTERNS = [
  // A heading that names the count, e.g. "## 三种运行时" / "## 三个正式运行时".
  { pattern: new RegExp(`^#{1,6}\\s*(?:${ZH}|\\d+)\\s*[个种]\\s*(?:正式|公开|官方|public\\s+|official\\s+)?(?:\`runtime\\.type\`\\s*)?运行时`, 'gm'), group: 0 },
  // "共 N 种运行时" — the 共 marks the total explicitly.
  { pattern: new RegExp(`共\\s*(${ZH}|\\d+)\\s*[个种]运行时`, 'g'), group: 1 },
  // "there are N public runtimes" / "there are exactly N runtimes".
  { pattern: new RegExp(`there (?:are|is)\\s+(?:exactly\\s+)?(\\d+|${EN})\\s+(?:public\\s+|official\\s+|supported\\s+)?runtimes?`, 'gi'), group: 1 },
  // "exactly N runtimes".
  { pattern: new RegExp(`exactly\\s+(\\d+|${EN})\\s+(?:public\\s+|official\\s+|supported\\s+)?runtimes?`, 'gi'), group: 1 },
];

function totalClaims(text) {
  const claims = [];
  for (const { pattern, group } of TOTAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // A heading match carries the number at the start of the matched text.
      const raw = group === 0 ? (/([一二两三四五六七八九十]|\d+)/.exec(match[0])?.[1] ?? '') : match[group];
      const count = toCount(String(raw));
      if (Number.isFinite(count)) claims.push({ count, text: match[0].trim(), index: match.index });
    }
  }
  return claims;
}

test('every total runtime count in the docs matches STUDIO_RUNTIME_TYPES', async () => {
  const { runtimes } = await contract();
  const expected = runtimes.length;
  const mismatches = [];
  let claims = 0;
  for (const file of walk(CONTENT_ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const claim of totalClaims(text)) {
      claims++;
      if (claim.count === expected) continue;
      const line = text.slice(0, claim.index).split('\n').length;
      mismatches.push(
        `${toPosix(relative(REPO_ROOT, file))}:${line} states "${claim.text}" but the contract has ${expected} (${runtimes.join(', ')})`,
      );
    }
  }
  assert.ok(claims > 0, 'No total runtime count was found in the docs; the pattern is out of date.');
  assert.deepEqual(
    mismatches,
    [],
    `Documentation states a stale runtime count. Source of truth: ${runtimes.join(', ')}.\n${mismatches.join('\n')}`,
  );
});

test('the internal experimental runtime never appears in public pages', async () => {
  const { experimental } = await contract();
  const leaks = [];
  for (const file of walk(CONTENT_ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const type of experimental) {
      if (!text.includes(type)) continue;
      // A CI job name and real error codes are identifiers, not runtime claims.
      // Only flag it when the page actually presents it as a runtime value.
      const presentsAsRuntime = new RegExp(
        `(\`${type}\`[^\\n]{0,80}(运行时|runtime)|(运行时|runtime)[^\\n]{0,80}\`${type}\`)`,
        'i',
      ).test(text);
      if (!presentsAsRuntime) continue;
      const line = text.slice(0, text.indexOf(type)).split('\n').length;
      leaks.push(`${toPosix(relative(REPO_ROOT, file))}:${line} presents "${type}" as a runtime`);
    }
  }
  assert.deepEqual(
    leaks,
    [],
    `An experimental runtime leaked into public documentation. Public runtimes are the only ones a reader may act on.\n${leaks.join('\n')}`,
  );
});

test('every runtime in the contract has a UI label', async () => {
  const { runtimes, experimental } = await contract();
  const theme = readFileSync(join(REPO_ROOT, 'src', 'client', 'theme.mjs'), 'utf8');
  const missing = [...runtimes, ...experimental].filter((type) => !new RegExp(`['"]?${type}['"]?\\s*:`).test(theme));
  assert.deepEqual(
    missing,
    [],
    `RUNTIME_LABELS is missing an entry for: ${missing.join(', ')}. Adding a runtime means adding its label in src/client/theme.mjs.`,
  );
});
