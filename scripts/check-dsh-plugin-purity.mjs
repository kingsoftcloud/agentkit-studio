#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const forbidden = [
  /personal-assistant/iu,
  /PersonalAssistant/u,
  /studioPersonalAssistant/u,
  /@kingsoftcloud\/agentkit-personal-assistant/u,
  /createPersonalAssistantRuntime/u,
  /assistant-(?:desktop|permission-model|cloud-|native-|workspace-|approval|history|schedule)/u,
  /ASSISTANT_(?:NATIVE|BROWSER|CODE_EXECUTION|MANAGED_PERMISSION|SCHEDULE|ATTACHMENT)/u,
];
const ignored = new Set([
  'CHANGELOG.md',
  'docs/architecture/dsh-plugin-purity.md',
  'scripts/check-dsh-plugin-purity.mjs',
]);

const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root });
const files = stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  .filter(file => !ignored.has(file))
  .filter(file => /^(?:src|tests|scripts|package\.json|studio\.plugin\.json|README\.md)/u.test(file));
const failures = [];
for (const file of files) {
  let text;
  try { text = await readFile(resolve(root, file), 'utf8'); } catch { continue; }
  for (const pattern of forbidden) {
    if (pattern.test(text)) failures.push({ file, pattern: String(pattern) });
  }
}
if (failures.length) {
  console.error(JSON.stringify({ event: 'studio.dsh-purity', passed: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ event: 'studio.dsh-purity', passed: true, files: files.length }));
}
