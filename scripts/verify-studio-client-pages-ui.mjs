import assert from 'node:assert/strict';

/** Synthetic Agent only, exercised through the actual installed product UI. */
export async function verifyStudioClientPages(page) {
  let phase = 'create';
  try {
    const suffix = Date.now().toString(36);
    const name = `UI_REFACTOR_AGENT_${suffix}`;
    await page.getByText('Agents', { exact: true }).click();
    await page.getByRole('button', { name: '手动配置', exact: true }).click();
    await page.getByLabel('Agent ID', { exact: true }).fill(`ui-refactor-${suffix}`);
    await page.getByLabel('名称', { exact: true }).fill(name);
    await page.getByLabel('运行时').selectOption('harness');
    await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true }).fill('Synthetic UI refactoring verification.');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    const model = page.getByLabel('默认模型');
    await model.locator('option[value]:not([value=""])').first().waitFor({ state: 'attached', timeout: 20000 });
    const modelIds = await model.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
    assert.ok(modelIds.length >= 2, 'the real catalog must offer two models to verify a binding edit');
    await model.selectOption(modelIds[0]);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: name });
    await row.waitFor({ state: 'visible', timeout: 30000 });
    const local = await page.evaluate(async query => {
      const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agents/list', payload: { query, source: 'local', page: 1, limit: 10 }, rpcId: 'ui-list' }) });
      const result = (await response.json()).result;
      return result?.ok ? result.value?.items?.map(item => ({ id: item.metadata?.id, name: item.metadata?.name })) : [];
    }, name);
    assert.equal(local.length, 1); assert.equal(local[0].name, name);
    assert.match(local[0].id, /^ar-local-[0-9a-f]{16}$/);
    const checks = [{ name: 'create-agent-via-migrated-form', passed: true }];

    phase = 'edit-bindings';
    await row.getByRole('button', { name: '编辑 Agent', exact: true }).click();
    await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true }).fill('Synthetic updated prompt.');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await model.selectOption(modelIds[1]);
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
    await row.waitFor({ state: 'visible', timeout: 30000 });
    const saved = await page.evaluate(async agentId => {
      const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'agents/local-get', payload: { agentId }, rpcId: 'ui-read' }) });
      const result = (await response.json()).result;
      const agent = result?.value;
      return { ok: result?.ok, id: agent?.metadata?.id, revision: agent?.metadata?.revision, prompt: agent?.spec?.instructions?.system, model: agent?.spec?.bindings?.modelProfileId };
    }, local[0].id);
    assert.equal(saved.ok, true); assert.equal(saved.id, local[0].id);
    assert.ok(saved.revision >= 2); assert.equal(saved.prompt, 'Synthetic updated prompt.'); assert.equal(saved.model, modelIds[1]);
    checks.push({ name: 'edit-prompt-and-model-binding-durable-revision', passed: true });

    phase = 'native-binding';
    await row.getByRole('button', { name: '绑定到新会话', exact: true }).click();
    await page.locator('.studio-agent-trigger').filter({ hasText: name }).waitFor({ state: 'visible', timeout: 30000 });
    checks.push({ name: 'created-agent-opens-official-native-session', passed: true, sentToModel: false });

    phase = 'settings';
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'AgentKit Studio', exact: true }).click();
      await dialog.locator('[data-studio-settings]').waitFor({ state: 'visible', timeout: 10000 });
      await dialog.getByText('已连接', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    }
    checks.push({ name: 'migrated-settings-reopen-host-ready', passed: true, cycles: 2 });
    return checks;
  } catch (error) { throw new Error(`${phase}: ${String(error.message).split('\n')[0]}`); }
}
