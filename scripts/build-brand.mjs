import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';

const asset = name => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
for (const name of ['agentkit-studio.svg', 'agentkit-studio-mark.svg']) {
  await writeFile(asset(name), AGENTKIT_STUDIO_MARK_SVG + '\n');
}
// Development-only converter; the distributable PNG is checked in for CI.
if (process.argv.includes('--macos')) {
  execFileSync('rsvg-convert', ['--width', '1024', '--height', '1024', '--output', asset('agentkit-studio-macos.png'), asset('agentkit-studio.svg')]);
}
