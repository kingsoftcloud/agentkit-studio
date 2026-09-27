#!/usr/bin/env node

/**
 * Project a snapshot exported from the real KsADK RuntimeEvent store through
 * the Studio adapter.  This is intentionally a small, dependency-free bridge
 * used by the cross-language integration probe; it does not own persistence.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { CanonicalDshSessionAdapter } from '../src/session-adapter.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: project-live-session.mjs <canonical-snapshot.json> <dsh-wire.json>');
}

const snapshot = JSON.parse(await readFile(inputPath, 'utf8'));
const adapter = new CanonicalDshSessionAdapter();
const projected = adapter.projectSnapshot(snapshot);
const wire = projected.events.map(event => adapter.wireEvent(event));
await writeFile(outputPath, JSON.stringify(wire, null, 2) + '\n');

console.log(JSON.stringify({
  session_id: projected.session_id,
  watermark: projected.watermark,
  event_count: wire.length,
  native_user_messages: wire.filter(event => event.type === 'user/message').length,
}));
