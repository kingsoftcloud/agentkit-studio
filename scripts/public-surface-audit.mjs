import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN_PATHS = [
  /(^|\/)AGENTS\.md$/,
  /^docs\/contracts\//,
  /^docs\/server-api-client-mapping\.md$/,
  /^docs\/studio-/,
  /^\.artifacts\//,
  /^\.playwright-cli\//,
  /^\.zread\//,
  /(^|\/)(?:node_modules|\.scratch|\.dsh|\.agentkit|\.codex|\.ssh|profiles)\//,
  /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:p12|pfx|p8|key)|.*(?:credentials?|secrets?|tokens?)\.(?:json|ya?ml|toml|ini|env)|.*private[-_]?key.*)$/i,
];

// These patterns intentionally target high-confidence private material. Public
// Public service endpoints and short test placeholders are allowed; Gitleaks remains
// the entropy-aware secret scanner for provider-specific credentials.
const PRIVATE_MARKERS = [
  ['INTERNAL', '-ONLY'].join(''),
  ['真实', '账号'].join(''),
  ['客户', '信息'].join(''),
  ['内部', '工作区'].join(''),
  ['内部', '主干'].join(''),
  ['仅', '内部'].join(''),
];

export const SENSITIVE_TEXT_PATTERNS = [
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i },
  { name: 'internal-forge-host', pattern: /(?:^|[^a-z0-9])(?:[a-z0-9-]+\.)*ezone\.ksyun\.com(?:[^a-z0-9]|$)/i },
  { name: 'internal-service-host', pattern: /\b(?:[a-z0-9-]+\.)*(?:inner|internal)\.api\.ksyun\.com\b|\b[a-z0-9.-]+\.(?:internal|intranet|corp)(?![a-z0-9.-])/i },
  { name: 'private-network-address', pattern: /(?:^|[^0-9])(?:10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3}\.)[0-9]{1,3})(?:[^0-9]|$)/ },
  { name: 'embedded-url-credential', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: 'personal-absolute-path', pattern: /(?:^|[^a-z0-9])(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|[A-Z]:\\Users\\[^\\\s]+)/i },
  { name: 'github-token', pattern: /\b(?:gh[ps]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'provider-api-key', pattern: /\b(?:sk-[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{30,})\b/ },
  { name: 'private-classification-marker', pattern: new RegExp(PRIVATE_MARKERS.join('|'), 'i') },
];

export function auditPath(file) {
  return FORBIDDEN_PATHS
    .filter(pattern => pattern.test(file))
    .map(() => ({ file, kind: 'forbidden public path' }));
}

export function auditText(file, source) {
  // Scan byte content too: NUL bytes must not provide a scanner bypass.
  const text = source[0] === 0xff && source[1] === 0xfe
    ? source.subarray(2).toString('utf16le') : source.toString('utf8');
  const hits = [];
  for (const { name, pattern } of SENSITIVE_TEXT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    hits.push({ file, kind: name, line });
  }
  return hits;
}

export async function auditFiles(files, read = readFile) {
  const hits = [];
  for (const file of files) {
    const pathHits = auditPath(file);
    hits.push(...pathHits);
    if (pathHits.length) continue;
    hits.push(...auditText(file, await read(file)));
  }
  return hits;
}

async function readRegularFile(file) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('non-regular-file');
  return readFile(file);
}

export function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export async function run() {
  const hits = await auditFiles(trackedFiles(), async file => {
    try { return await readRegularFile(file); }
    catch { throw new Error(`public audit could not safely read ${file}`); }
  });
  if (hits.length) {
    for (const hit of hits) {
      const location = hit.line ? `${hit.file}:${hit.line}` : hit.file;
      console.error(`${location}: ${hit.kind}`);
    }
    process.exitCode = 1;
    return hits;
  }
  console.log('public surface audit passed: all tracked and non-ignored text files and paths checked');
  return [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await run();
