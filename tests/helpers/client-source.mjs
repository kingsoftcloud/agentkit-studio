import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Static source constraints only. Behavior tests import the actual modules. */
export async function readClientSource() {
  const root = resolve(import.meta.dirname, '../../src');
  const files = [resolve(root, 'client.js'), resolve(root, 'remote/control-client.mjs'), resolve(root, 'remote/compatibility-methods.mjs')];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.(mjs|js)$/.test(entry.name)) files.push(path);
    }
  }
  await collect(resolve(root, 'client'));
  return (await Promise.all(files.sort().map(path => readFile(path, 'utf8')))).join('\n');
}
