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
// Windows selects the native tray bitmap for each display scale.
if (process.argv.includes('--windows-tray')) {
  const sizes = [16, 20, 24, 32, 40, 48, 64];
  const pngs = sizes.map(size => execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size), asset('agentkit-studio.svg')]));
  const directory = Buffer.alloc(6 + 16 * sizes.length);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  pngs.forEach((png, index) => {
    const at = 6 + index * 16;
    directory[at] = sizes[index]; directory[at + 1] = sizes[index];
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  await writeFile(asset('agentkit-studio-tray.ico'), Buffer.concat([directory, ...pngs]));
}
