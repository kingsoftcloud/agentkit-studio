/** Exercise catalog pages on the same installed Web/Electron surface as the assistant. */
import assert from 'node:assert/strict';
export async function verifyStudioCatalogUi(page) {
  const checks = [];
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '模板广场', exact: true }).click();
  await page.getByRole('tab', { name: '专家', exact: true }).click();
  await page.getByLabel('专家模板目录', { exact: true }).waitFor();
  await page.getByLabel('搜索专家', { exact: true }).fill('研究');
  await page.getByRole('button', { name: /^查看/ }).first().waitFor();
  checks.push('expert-catalog-renders-and-searches');
  await page.getByLabel('搜索专家', { exact: true }).fill('');
  await page.getByRole('button', { name: /^查看/ }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('expert-detail-opens-and-closes');
  await page.getByRole('tab', { name: '专家团', exact: true }).click();
  await page.getByLabel('本地专家团', { exact: true }).waitFor();
  await page.getByRole('button', { name: /自定义专家团/ }).click();
  await page.getByRole('dialog', { name: '编辑专家团', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  checks.push('native-team-editor-opens-and-closes');
  for (const name of ['技能', '连接器']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.getByRole('searchbox').first().waitFor();
    checks.push(`${name}-catalog-renders`);
  }
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByRole('button', { name: '从专家模板创建', exact: true }).waitFor();
  checks.push('ordinary-agent-list-remains-accessible');
  assert.equal(checks.length, 6);
  return { passed: true, checks };
}
