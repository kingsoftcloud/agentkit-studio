import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';

const asset = name => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
for (const name of ['agentkit-studio.svg', 'agentkit-studio-mark.svg']) {
  await writeFile(asset(name), AGENTKIT_STUDIO_MARK_SVG + '\n');
}
// Development-only converter; the distributable PNGs are checked in for CI.
if (process.argv.includes('--macos')) {
  const inner = AGENTKIT_STUDIO_MARK_SVG.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="10" result="b"/><feOffset in="b" dx="0" dy="10" result="o"/><feFlood flood-color="#000" flood-opacity="0.3" result="c"/><feComposite in="c" in2="o" operator="in" result="shadow"/><feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#s)"><g transform="translate(100 100) scale(12.875)">${inner}</g></g></svg>`;
  execFileSync('rsvg-convert', ['--width', '1024', '--height', '1024', '--output', asset('agentkit-studio-macos.png')], { input: svg });
}
if (process.argv.includes('--windows')) {
  execFileSync('rsvg-convert', ['--width', '1024', '--height', '1024', '--output', asset('agentkit-studio-windows.png'), asset('agentkit-studio.svg')]);
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
