#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { importPortableBundle } from '../src/portable-bundle.mjs';

const [archive, flag, destination, ...extra] = process.argv.slice(2);
if (!archive || flag !== '--home' || !destination || extra.length) {
  console.error('Usage: node scripts/import-agent-bundle.mjs portable.zip --home NEW_DIRECTORY');
  process.exitCode = 2;
} else {
  try {
    const info = await stat(archive);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw Object.assign(new Error('运行包必须是大小不超过 20 MiB 的文件'), { code: 'PORTABLE_ARCHIVE_SIZE_INVALID' });
    console.log(JSON.stringify(await importPortableBundle(await readFile(archive), destination), null, 2));
  }
  catch (error) { console.error(JSON.stringify({ error: error.code || 'PORTABLE_IMPORT_FAILED', message: error.code?.startsWith('PORTABLE_') ? error.message : '运行包导入失败' })); process.exitCode = 1; }
}
