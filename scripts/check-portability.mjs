import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const forbidden = [/\/Users\//, /\/home\/[^/]+\//, /file:\/\/\/Users\//];
const violations = [];
for (const file of files) {
  let source;
  try { source = await readFile(file, 'utf8'); } catch { continue; }
  if (forbidden.some(pattern => pattern.test(source))) violations.push(file);
}
if (violations.length) {
  console.error(`发现不可分发的个人路径或 file URL：\n${violations.map(file => `- ${file}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`portability: ${files.length} tracked files checked`);
}
