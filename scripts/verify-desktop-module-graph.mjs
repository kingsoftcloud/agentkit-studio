import asar from '@electron/asar';
import { resolve, join } from 'node:path';
import { verifyDesktopModuleGraph } from './desktop-module-graph.mjs';

const input = resolve(process.argv[2] || '');
if (input === resolve('.')) throw new Error('usage: verify-desktop-module-graph.mjs <app.asar|macOS app>');
const archive = input.endsWith('.app') ? join(input, 'Contents/Resources/app.asar') : input;
const report = await verifyDesktopModuleGraph(path => asar.extractFile(archive, path).toString('utf8'));
console.log(JSON.stringify({ archive, ...report }));
