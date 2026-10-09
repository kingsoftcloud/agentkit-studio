import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const forbiddenTrackedPaths = [
  /^AGENTS\.md$/,
  /^docs\/contracts\//,
  /^docs\/server-api-client-mapping\.md$/,
  /^docs\/studio-/,
  /^\.artifacts\//,
  /^\.zread\//,
];
const publicTextPaths = /^(README\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|docs\/brand\/|\.github\/)/;
const forbiddenText = [
  /INTERNAL[-]ONLY/i,
  /ezone\.ksyun\.com/i,
  /(?:^|[^a-z])(?:\/Users\/|\/home\/[^/]+\/)/i,
  /真实账[号]|客户信[息]|内部工作[区]|内部主[干]|仅内[部]/i,
];
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const pathHits = files.filter(file => forbiddenTrackedPaths.some(pattern => pattern.test(file)));
const textHits = [];
for (const file of files.filter(file => publicTextPaths.test(file))) {
  const source = await readFile(file, 'utf8');
  for (const pattern of forbiddenText) {
    if (pattern.test(source)) textHits.push(file + ': ' + pattern);
  }
}
if (pathHits.length || textHits.length) {
  console.error([...pathHits.map(file => 'forbidden public path: ' + file), ...textHits].join('\n'));
  process.exitCode = 1;
} else {
  console.log('public surface audit passed');
}
