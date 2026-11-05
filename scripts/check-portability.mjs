import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const forbidden = [/\/Users\//, /\/home\/[^/]+\//, /file:\/\/\/Users\//];
// The runtime image runs as `node`, so its fixed home is a container constant
// rather than a developer path. Mask exactly that literal before scanning; any
// other home or user path still fails. Assembled so this guard does not match
// its own text.
const containerHome = ['', 'home', 'node'].join('/');
const violations = [];
for (const file of files) {
  let source;
  try { source = await readFile(file, 'utf8'); } catch { continue; }
  if (forbidden.some(pattern => pattern.test(source.split(containerHome).join('/<container-home>')))) violations.push(file);
}
if (violations.length) {
  console.error(`发现不可分发的个人路径或 file URL：\n${violations.map(file => `- ${file}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`portability: ${files.length} tracked files checked`);
}
