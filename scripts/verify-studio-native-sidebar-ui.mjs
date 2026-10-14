/** UI assertions shared by the real Web and Electron development Hosts. */
import assert from 'node:assert/strict';

export async function verifyStudioNativeSidebar(page, seed) {
  let phase = 'initial-history';
  try {
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
  await mode('全部对话（显示已归档）');
  for (const row of rows) await historyRow(row).waitFor({ state: 'visible', timeout: 30000 });
  await visible();
  const nativeTitles = [];
  for (const row of rows) nativeTitles.push(await historyRow(row).locator(':scope > span').nth(1).innerText());
  const checks = [{ name: 'persisted-history-flat', passed: true }];
  const choose = async name => {
    const trigger = page.getByRole('button', { name: '选择当前会话智能体', exact: true });
    // The selected native menu item also exposes its checkmark as "已选择".
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const item = page.getByRole('menuitem', { name: new RegExp(`^${escaped}(?: 已选择)?$`) });
    const deadline = Date.now() + 15000;
    while (!await item.isVisible() && Date.now() < deadline) {
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      await item.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    }
    await item.click().catch(error => { throw new Error(`select ${name}: ${error.message.split('\n')[0]}`); });
    await item.waitFor({ state: 'hidden', timeout: 10000 });
    await trigger.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('.studio-agent-trigger');
      return button && !button.disabled && button.getAttribute('aria-expanded') === 'false';
    }, null, { timeout: 30000 });
  };
  for (const row of rows) {
    phase = `select-${row.label}`;
    await choose(row.agentName);
    await page.locator('.studio-agent-trigger').filter({ hasText: row.agentName }).waitFor({ state: 'visible', timeout: 30000 }).catch(() => assert.fail(`select ${row.label}: selection did not finish`));
    const visibleAt = Date.now();
    await visible(`select-${row.label}`);
    const visibilityMs = Date.now() - visibleAt;
    assert.ok(visibilityMs < 500, 'ready Agent selection must leave the native history visible within 500 ms');
    checks.push({ name: `select-${row.label}-keeps-all-history`, passed: true, visibilityMs });
    if (row === rows[0]) {
      phase = 'workspace-clear';
      const clearWorkspace = page.getByRole('button', { name: '取消工作区', exact: true });
      assert.equal(await clearWorkspace.isVisible(), true, 'the initial native blank must have its default Workspace');
      await clearWorkspace.click();
      await clearWorkspace.waitFor({ state: 'hidden', timeout: 10000 });
      await page.locator('.studio-agent-trigger').filter({ hasText: row.agentName }).waitFor({ state: 'visible', timeout: 30000 });
      await visible('workspace-cleared');
      checks.push({ name: 'native-workspace-clear-preserves-agent-and-history', passed: true });
    }
  }
  phase = 'native-session';
  await choose('不使用 Agent');
  await page.locator('.studio-agent-trigger').filter({ hasText: '选择 Agent' }).waitFor({ state: 'visible', timeout: 30000 });
  await visible('native-session');
  checks.push({ name: 'native-session-keeps-all-history', passed: true });

  phase = 'cache-reopen';
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

  phase = 'search';
  await page.getByRole('button', { name: '搜索会话', exact: true }).click();
  const search = page.getByPlaceholder('搜索会话名称', { exact: true });
  await search.fill('SIDEBAR_');
  const results = page.getByRole('tree', { name: '搜索结果', exact: true });
  for (const title of nativeTitles) await results.getByRole('treeitem').filter({ hasText: title }).first().waitFor({ state: 'visible', timeout: 10000 });
  checks.push({ name: 'native-search', passed: true });
  await search.fill('');
  await page.keyboard.press('Escape');
  phase = 'grouped';
  await mode('按工作区');
  if (!await historyRow(rows[0]).isVisible()) await page.getByText('未分组', { exact: true }).click();
  await visible('grouped');
  checks.push({ name: 'native-grouped-history', passed: true });

  phase = 'archive';
  await mode('单列表');
  const archived = rows[1];
  const rowMenu = async row => {
    await historyRow(row).hover();
    await historyRow(row).getByRole('button', { name: /^会话.*的操作$/ }).click();
  };
  // Restore a previous interrupted verification before exercising the rule.
  if (await historyRow(archived).getAttribute('aria-description')) {
    await rowMenu(archived);
    await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  }
  await mode('隐藏已归档');
  await rowMenu(archived);
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  try {
    await historyRow(archived).waitFor({ state: 'hidden', timeout: 10000 });
    await mode('全部对话（显示已归档）');
    await visible('show-archived');
    assert.ok(await historyRow(archived).getAttribute('aria-description'), 'DSH must mark the archived history');
    checks.push({ name: 'native-archive-rules', passed: true });
  } finally {
    await mode('全部对话（显示已归档）');
    await historyRow(archived).waitFor({ state: 'visible', timeout: 10000 });
    await rowMenu(archived);
    await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  }
  await visible('unarchive');
  checks.push({ name: 'native-unarchive-history', passed: true });

  // Real browser network emulation drives DSH's native offline/online loop.
  phase = 'reconnect';
  await page.context().setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.getByRole('button', { name: '连接异常，点击立即重连', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await visible('offline-cached-history');
  await page.context().setOffline(false);
  await page.waitForFunction(() => navigator.onLine === true);
  await page.getByRole('status', { name: '连接成功', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await visible('reconnect-history');
  checks.push({ name: 'browser-offline-online-history', passed: true, fault: 'browser-network-emulation', nativeConnectionRecoveryObserved: true });

  if (seed.deletedCandidate) {
    phase = 'deleted-agent';
    const candidate = seed.deletedCandidate;
    assert.match(candidate.agentId, /^ar-local-[0-9a-f]{16}$/);
    assert.match(candidate.agentName, /^SIDEBAR_DELETED_AGENT_/);
    const result = await page.evaluate(async row => {
      const call = async (method, payload) => {
        const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, payload, rpcId: method }) });
        return (await response.json()).result;
      };
      const current = await call('agents/local-get', { agentId: row.agentId });
      if (current?.ok && current.value) {
        if (current.value.metadata?.name !== row.agentName) return { ok: false, code: 'TEST_IDENTITY_MISMATCH' };
        const removed = await call('agents/local-delete', { agentId: row.agentId });
        if (!removed?.ok) return { ok: false, code: removed?.error?.code };
      } else if (!(current?.ok && current.value === null) && current?.error?.code !== 'AGENT_NOT_FOUND') return { ok: false, code: current?.error?.code };
      const after = await call('agents/local-get', { agentId: row.agentId });
      return { ok: after?.ok === true && after.value === null || after?.ok === false && after.error?.code === 'AGENT_NOT_FOUND' };
    }, candidate);
    assert.equal(result.ok, true, `only the isolated synthetic Agent may be deleted: ${result.code || ''}`);
    await page.reload();
    await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
    await mode('单列表');
    await mode('全部对话（显示已归档）');
    await historyRow(candidate).waitFor({ state: 'visible', timeout: 10000 });
    await visible('deleted-agent-reopen');
    checks.push({ name: 'deleted-agent-history-after-reopen', passed: true });
  }
  return checks;
  } catch (error) {
    throw new Error(`${phase}: ${String(error.message).split('\n')[0]}`);
  }
}
