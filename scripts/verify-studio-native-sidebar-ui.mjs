/** UI assertions shared by the real Web and Electron development Hosts. */
import assert from 'node:assert/strict';

export async function verifyStudioNativeSidebar(page, seed) {
  const rows = seed.sessions;
  const historyRow = row => page.locator(`[data-row-key="session:${row.sessionId}"]`);
  const visible = async (stage = 'history') => {
    for (const row of rows) {
      await historyRow(row).waitFor({ state: 'visible', timeout: 10000 }).catch(() => assert.fail(`${stage}: ${row.label} history is missing`));
      assert.equal(await historyRow(row).isVisible(), true, `${stage}: ${row.label} history must remain visible`);
    }
  };
  const mode = async name => {
    await page.getByRole('button', { name: '视图选项', exact: true }).click();
    await page.getByText(name, { exact: true }).click();
  };
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  await mode('单列表');
  for (const row of rows) await historyRow(row).waitFor({ state: 'visible', timeout: 30000 });
  await visible();
  const nativeTitles = [];
  for (const row of rows) nativeTitles.push(await historyRow(row).locator(':scope > span').nth(1).innerText());
  const checks = [{ name: 'persisted-history-flat', passed: true }];
  for (const row of rows) {
    await page.getByRole('button', { name: '选择当前会话智能体', exact: true }).click();
    await page.getByRole('menuitem', { name: row.agentName, exact: true }).click();
    await page.locator('.studio-agent-trigger').filter({ hasText: row.agentName }).waitFor({ state: 'visible', timeout: 30000 });
    await visible(`select-${row.label}`);
    checks.push({ name: `select-${row.label}-keeps-all-history`, passed: true });
  }
  await page.getByRole('button', { name: '选择当前会话智能体', exact: true }).click();
  await page.getByRole('menuitem', { name: '不使用 Agent', exact: true }).click();
  await page.locator('.studio-agent-trigger').filter({ hasText: '选择 Agent' }).waitFor({ state: 'visible', timeout: 30000 });
  await visible('native-session');
  checks.push({ name: 'native-session-keeps-all-history', passed: true });

  await page.evaluate(entries => {
    localStorage.clear();
    for (const row of entries) localStorage.setItem(`agentkit-studio:conversation-agent:${row.sessionId}`, JSON.stringify({ agentId: 'FORGED_AGENT_ID', updatedAt: 1 }));
  }, rows);
  await page.reload();
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  await mode('单列表');
  for (const row of rows) await historyRow(row).waitFor({ state: 'visible', timeout: 30000 });
  await visible('cache-reopen');
  checks.push({ name: 'cleared-and-forged-cache-reopen', passed: true });

  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  const search = page.getByPlaceholder('搜索会话名称', { exact: true });
  await search.fill('SIDEBAR_');
  const results = page.getByRole('tree', { name: '搜索结果', exact: true });
  for (const title of nativeTitles) await results.getByRole('treeitem').filter({ hasText: title }).first().waitFor({ state: 'visible', timeout: 10000 });
  checks.push({ name: 'native-search', passed: true });
  await search.fill('');
  await page.keyboard.press('Escape');
  await mode('按工作区');
  if (!await historyRow(rows[0]).isVisible()) await page.getByText('未分组', { exact: true }).click();
  await visible('grouped');
  checks.push({ name: 'native-grouped-history', passed: true });
  return checks;
}
