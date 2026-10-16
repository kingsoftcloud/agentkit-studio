import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { seed } from './seed.mjs';
import { createExpertCatalog, validateCatalog } from './catalog.mjs';

/** An explicit, reviewed local release. Never scans another application's account or data. */
export function validateReviewedCatalog(source, { personalLocal = false } = {}) {
  validateCatalog(source);
  if (!source.items.length) throw new Error('发布目录不能为空');
  for (const item of source.items) {
    if (!['definition-reviewed', ...(personalLocal ? ['compatibility-checked'] : [])].includes(item.validation?.state) || !item.validation?.notes?.trim()) throw new Error(`模板尚未完成内容评审：${item.id}`);
    if (item.origin.type === 'imported' && (!item.origin.sourceSha256 || !item.origin.license || (!personalLocal && /unconfirmed|see-source-license|unknown/i.test(item.origin.license))
      || item.validation.reviewedSourceSha256 !== item.origin.sourceSha256)) throw new Error(`模板来源或许可尚未核对：${item.id}`);
    if (!Array.isArray(item.validation.verifiedRuntimes) || item.validation.verifiedRuntimes.some(type => !item.runtimes.includes(type))) throw new Error(`运行验证记录无效：${item.id}`);
  }
  return source;
}
export async function loadExpertCatalog(file, { optional = false, personalLocal = false } = {}) {
  if (!file) return createExpertCatalog();
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (optional && error.code === 'ENOENT') return createExpertCatalog(); throw error; }
  const source = validateReviewedCatalog(JSON.parse(text), { personalLocal });
  if (source.distribution === 'personal-local' && !personalLocal) throw new Error('个人导入目录不能作为公共目录发布');
  const categoryIds = new Set(seed.categories.map(category => category.id));
  if (source.categories.some(category => categoryIds.has(category.id))) throw new Error('导入目录分类 ID 与内置目录冲突，请在整理时重新命名');
  return createExpertCatalog({ schemaVersion: 1, revision: `${seed.revision}+${source.revision}`,
    categories: [...seed.categories, ...source.categories], items: [...seed.items, ...source.items], resources: source.resources || [], packages: source.packages || {} }, { assetRoot: dirname(file) });
}
