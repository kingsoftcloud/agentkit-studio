#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { auditTeamTemplateCatalog } from '../src/team-template-audit.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = argument('--input') || process.argv.find(value => !value.startsWith('--') && value !== process.argv[0] && value !== process.argv[1]);
if (!input) {
  console.error('用法：node scripts/verify-team-template-catalog.mjs --input <catalog.json|latest.json|URL> [--require-role-definitions] [--json]');
  process.exit(2);
}

async function loadJson(source) {
  const response = /^https?:\/\//.test(source)
    ? await fetch(source)
    : { ok: true, json: () => readFile(source, 'utf8').then(JSON.parse) };
  if (!response.ok) throw new Error(`读取目录失败：${source} (${response.status})`);
  return response.json();
}

function absoluteUrl(base, value) {
  return new URL(value, base).href;
}

async function loadPublicCatalog(source, value) {
  let manifest = value;
  if (manifest.manifest?.url) manifest = await loadJson(absoluteUrl(source, manifest.manifest.url));
  if (manifest.format !== 'agentkit.public-template-catalog/v1') return { items: manifest.items || [], definitions: manifest.definitions || {} };
  const definitionsIndex = await loadJson(absoluteUrl(source, manifest.definitions.url));
  const teams = [];
  const definitions = new Map();
  for (const [key, reference] of Object.entries(definitionsIndex)) {
    if (!key.startsWith('team/') || !reference?.url) continue;
    const wrapper = await loadJson(absoluteUrl(source, reference.url));
    const item = wrapper.item || wrapper;
    teams.push(item);
    for (const role of item.roles || []) {
      const roleKey = `agent/${role.template?.id || ''}`;
      const roleRef = definitionsIndex[roleKey];
      if (roleRef?.url && !definitions.has(roleKey)) definitions.set(roleKey, (await loadJson(absoluteUrl(source, roleRef.url))).item || await loadJson(absoluteUrl(source, roleRef.url)));
    }
  }
  return { items: teams, definitions };
}

const value = await loadJson(input);
const catalog = await loadPublicCatalog(input, value);
const report = auditTeamTemplateCatalog({
  ...catalog,
  requireRoleDefinitions: process.argv.includes('--require-role-definitions'),
});
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Team 模板：${report.teamCount} 个；错误：${report.errors.length}；警告：${report.warnings.length}`);
  for (const row of [...report.errors, ...report.warnings]) console.log(`${report.errors.includes(row) ? 'ERROR' : 'WARN '} ${row.code}: ${row.message}${row.path ? ` (${row.path})` : ''}`);
}
process.exitCode = report.ok ? 0 : 1;

