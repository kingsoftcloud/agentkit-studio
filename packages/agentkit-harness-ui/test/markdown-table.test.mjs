import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkdownTableText, buildCsvTableText } from '../markdown/source/table-factory.mjs';

test('table exports preserve cells while escaping Markdown and spreadsheet formulas', () => {
  const rows = [['字段', '值'], ['a|b', 'line\nbreak'], ['=SUM(A1:A2)', '"quoted",value']];
  assert.equal(buildMarkdownTableText(rows), '| 字段 | 值 |\n| --- | --- |\n| a\\|b | line<br>break |\n| =SUM(A1:A2) | "quoted",value |');
  const csv = buildCsvTableText(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("'=SUM(A1:A2)"));
  assert.ok(csv.includes('"""quoted"",value"'));
  assert.ok(csv.includes('"line\nbreak"'));
  assert.equal(buildMarkdownTableText([]), '');
});
