/** Publish a reviewed selection to a local catalog file; does not upload or install resources. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReviewedCatalog } from '../../packages/expert-catalog/src/release.mjs';
export function prepareRelease(reviewed, downloads) {
  validateReviewedCatalog(reviewed);
  const sourceByDigest = new Map(downloads.bundles.filter(row => row.status === 'downloaded').map(row => [row.sha256, row]));
  for (const item of reviewed.items) {
    const receipt = sourceByDigest.get(item.origin.sourceSha256);
    if (item.origin.type !== 'imported' || !receipt || item.id !== `imported-${receipt.plugin}` || item.origin.source !== receipt.url) throw new Error(`模板与锁定下载来源不匹配：${item.id}`);
  }
  return structuredClone(reviewed);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
  if (!['--review', '--downloads', '--output'].every(flag => args.includes(flag))) throw new Error('Usage: node scripts/workbuddy/release.mjs --review reviewed-catalog.json --downloads downloads.json --output release.json');
  const source = prepareRelease(JSON.parse(await readFile(value('--review'), 'utf8')), JSON.parse(await readFile(value('--downloads'), 'utf8')));
  const output = resolve(value('--output')); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(source, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ templates: source.items.length, revision: source.revision, output, uploaded: false }));
}
