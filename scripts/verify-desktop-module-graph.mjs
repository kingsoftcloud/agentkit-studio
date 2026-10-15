import asar from '@electron/asar';
import { resolve, join, normalize } from 'node:path';
import { verifyDesktopArchiveEntries, verifyDesktopModuleGraph, DESKTOP_HOST_ENTRIES, STUDIO_DESKTOP_ENTRIES } from './desktop-module-graph.mjs';

const input = resolve(process.argv[2] || '');
if (input === resolve('.')) throw new Error('usage: verify-desktop-module-graph.mjs <app.asar|macOS app> [--studio]');
const archive = input.endsWith('.app') ? join(input, 'Contents/Resources/app.asar') : input;
const metadata = verifyDesktopArchiveEntries(asar.listPackage(archive));
const entries = process.argv.includes('--studio') ? [...DESKTOP_HOST_ENTRIES, ...STUDIO_DESKTOP_ENTRIES] : DESKTOP_HOST_ENTRIES;
const report = await verifyDesktopModuleGraph(path => asar.extractFile(archive, normalize(path)).toString('utf8'), entries);
console.log(JSON.stringify({ archive, ...report, ...metadata }));
