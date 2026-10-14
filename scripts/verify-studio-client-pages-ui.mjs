import assert from 'node:assert/strict';

/** Synthetic Agent only, exercised through the actual installed product UI. */
export async function verifyStudioClientPages(page) {
  let phase = 'create';
  const checks = [];
  let createdTask;
  let syntheticTask;
  const rpc = (method, payload) => page.evaluate(async ({ method, payload }) => {
    const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, payload, rpcId: 'ui-acceptance' }) });
    const result = (await response.json()).result;
    if (!result?.ok) throw new Error(result?.error?.code || 'RPC_READ_FAILED');
    return result.value;
  }, { method, payload });
  try {
    phase = 'model-catalog-preflight';
    const catalog = await rpc('resources/list', { kind: 'model' });
    assert.ok(catalog.items?.length >= 2, 'the isolated acceptance profile needs two available models before the binding-edit flow');
    phase = 'create';
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
    // Runtime changes keep the previous options while the new catalog loads.
    // Wait for the required alternatives and the displayed loading state to
    // settle before reading the actual Host resource identities.
    await model.locator('option[value]:not([value=""])').nth(1).waitFor({ state: 'attached', timeout: 20000 });
    await model.locator('option[value=""]').filter({ hasText: '请选择模型' }).waitFor({ state: 'attached', timeout: 20000 });
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
    checks.push({ name: 'create-agent-via-migrated-form', passed: true });

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
      return { ok: result?.ok, id: agent?.metadata?.id, revision: agent?.metadata?.revision, prompt: agent?.spec?.instructions?.system, model: agent?.spec?.bindings?.modelProfileId, models: agent?.spec?.bindings?.modelProfileIds };
    }, local[0].id);
    assert.equal(saved.ok, true); assert.equal(saved.id, local[0].id);
    assert.ok(saved.revision >= 2); assert.equal(saved.prompt, 'Synthetic updated prompt.'); assert.equal(saved.model, modelIds[1]);
    assert.ok(saved.models.includes(modelIds[0]) && saved.models.includes(modelIds[1]), 'editing the primary model must preserve the resource allowlist');
    checks.push({ name: 'edit-prompt-and-model-binding-durable-revision', passed: true });

    phase = 'native-binding';
    await row.getByRole('button', { name: '绑定到新会话', exact: true }).click();
    await page.locator('.studio-agent-trigger').filter({ hasText: name }).waitFor({ state: 'visible', timeout: 30000 });
    checks.push({ name: 'created-agent-opens-official-native-session', passed: true, sentToModel: false });

    phase = 'native-model-selection';
    const modelTrigger = page.getByRole('button', { name: /^选择模型，当前 / });
    await modelTrigger.click();
    await page.getByRole('menuitem').filter({ has: page.getByText('模型', { exact: true }) }).click();
    const alternative = page.getByRole('menuitemradio', { checked: false }).first();
    await alternative.waitFor({ state: 'visible', timeout: 20000 });
    const chosenModel = (await alternative.textContent()).trim();
    await alternative.click();
    await modelTrigger.filter({ hasText: chosenModel }).waitFor({ state: 'visible', timeout: 20000 });
    await modelTrigger.click();
    await page.getByRole('menuitem').filter({ has: page.getByText('模型', { exact: true }) }).click();
    await page.getByRole('menuitemradio', { checked: true }).filter({ hasText: chosenModel }).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    checks.push({ name: 'official-native-model-picker-switch-and-reopen', passed: true, sentToModel: false });

    phase = 'resources';
    await page.getByText('资源库', { exact: true }).click();
    await page.getByLabel('搜索资源', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
    await page.getByRole('tablist', { name: '资源类型', exact: true }).getByRole('tab', { name: 'MCP', exact: true }).click();
    await page.getByRole('button', { name: '添加 MCP', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('tablist', { name: '资源类型', exact: true }).getByRole('tab', { name: 'Skill', exact: true }).click();
    await page.getByLabel('Skill 来源', { exact: true }).selectOption('local');
    await page.getByLabel('搜索资源', { exact: true }).fill(`NO_RESOURCE_${suffix}`);
    await page.getByText('暂无Skill', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    checks.push({ name: 'resource-tabs-source-search-and-empty-state', passed: true });

    phase = 'build-and-deployment-view';
    await page.getByText('运行中心', { exact: true }).click();
    await page.getByLabel('目标 Agent', { exact: true }).selectOption(local[0].id);
    await page.getByRole('button', { name: '构建当前版本', exact: true }).click();
    await page.getByText('构建完成，已选中新版本，可以检查部署。', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    const buildId = await page.getByLabel('构建版本', { exact: true }).inputValue();
    const builds = await rpc('builds/list', { agentId: local[0].id });
    const build = builds.items.find(item => item.id === buildId);
    assert.ok(buildId && build); assert.equal(build.revision, saved.revision); assert.equal(build.status, 'SUCCEEDED');
    await page.getByRole('region', { name: '云端部署', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('region', { name: '部署记录', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    checks.push({ name: 'create-real-local-build-and-view-deployment', passed: true, revision: build.revision, cloudMutation: false });

    phase = 'automation-crud';
    await page.getByRole('button', { name: '自动化', exact: true }).click();
    await page.getByRole('button', { name: '新建自动化', exact: true }).click();
    let editor = page.getByRole('dialog');
    const taskName = `UI_REFACTOR_TASK_${suffix}`;
    syntheticTask = { agentId: local[0].id, taskName };
    await editor.getByLabel('绑定 Agent').selectOption(local[0].id);
    phase = 'automation-create';
    await editor.getByLabel('任务名称', { exact: true }).fill(taskName);
    await editor.getByLabel('到期时发送给 Agent 的提示词').fill('Synthetic scheduled prompt; acceptance only.');
    await editor.getByLabel('触发方式').selectOption('once');
    await editor.getByRole('button', { name: '创建', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: '请选择未来的执行时间。' }).waitFor({ state: 'visible', timeout: 10000 });
    await editor.getByLabel('触发方式').selectOption('interval');
    // One week avoids running a model during this UI acceptance.
    await editor.getByLabel('间隔秒数（最少 60）', { exact: true }).fill('604800');
    await editor.getByRole('button', { name: '创建', exact: true }).click();
    await editor.waitFor({ state: 'hidden', timeout: 10000 });
    const schedules = await rpc('schedules/list', { agentId: local[0].id, scope: 'local' });
    const task = schedules.items.find(item => item.displayName === taskName);
    assert.ok(task); assert.equal(task.target.agentId, local[0].id); assert.equal(task.schedule.everySeconds, 604800);
    createdTask = { taskId: task.taskId, agentId: local[0].id, taskName };
    const taskCard = page.getByText(taskName, { exact: true }).locator('xpath=ancestor::section[1]');
    await taskCard.waitFor({ state: 'visible', timeout: 10000 });
    phase = 'automation-edit';
    await taskCard.getByRole('button', { name: '编辑', exact: true }).click();
    editor = page.getByRole('dialog');
    await editor.getByLabel('到期时发送给 Agent 的提示词').fill('Synthetic updated scheduled prompt.');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await editor.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal((await rpc('schedules/get', { taskId: task.taskId })).command.payload.content, 'Synthetic updated scheduled prompt.');
    phase = 'automation-pause-enable';
    await taskCard.getByRole('button', { name: '暂停', exact: true }).click();
    await taskCard.getByRole('button', { name: '启用', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await rpc('schedules/get', { taskId: task.taskId })).enabled, false);
    await taskCard.getByRole('button', { name: '启用', exact: true }).click();
    await taskCard.getByRole('button', { name: '暂停', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await rpc('schedules/get', { taskId: task.taskId })).enabled, true);
    phase = 'automation-delete';
    await taskCard.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').filter({ has: page.getByText('删除自动化', { exact: true }) }).getByRole('button', { name: '删除', exact: true }).click();
    await taskCard.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal((await rpc('schedules/list', { agentId: local[0].id, scope: 'local' })).items.some(item => item.taskId === task.taskId), false);
    createdTask = undefined;
    syntheticTask = undefined;
    checks.push({ name: 'real-local-automation-create-edit-pause-enable-delete-and-invalid-once', passed: true, executed: false });

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

    phase = 'credential-guide';
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', { name: 'AgentKit Studio', exact: true }).click();
    await settings.getByRole('button', { name: '重新打开凭证引导', exact: true }).click();
    const guide = page.getByRole('dialog').filter({ has: page.locator('[data-studio-onboarding-stage]') });
    await guide.getByText('可以开始对话了', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await guide.getByRole('button', { name: '更换模型', exact: true }).click();
    await guide.locator('[data-studio-onboarding-stage="model"]').waitFor({ state: 'visible', timeout: 10000 });
    const secretValues = await guide.locator('input[type="password"]').evaluateAll(inputs => inputs.map(input => input.value));
    assert.ok(secretValues.length > 0); assert.ok(secretValues.every(value => value === ''));
    await guide.getByRole('button', { name: '稍后设置', exact: true }).click();
    await guide.waitFor({ state: 'hidden', timeout: 10000 });
    await page.keyboard.press('Escape');
    checks.push({ name: 'credential-guide-reopen-configured-state-and-no-secret-readback', passed: true, credentialsWritten: false });
    return checks;
  } catch (error) {
    const failure = new Error(`${phase}: ${String(error.message).split('\n')[0]}`);
    failure.pageProgress = checks;
    throw failure;
  } finally {
    if (syntheticTask) {
      // Remove only this run's synthetic task if a later UI assertion failed.
      const tasks = (await rpc('schedules/list', { agentId: syntheticTask.agentId, scope: 'local' })).items;
      for (const task of tasks.filter(item => item.displayName === syntheticTask.taskName)) {
        assert.equal(task.target.agentId, syntheticTask.agentId);
        if (createdTask) assert.equal(task.taskId, createdTask.taskId);
        await rpc('schedules/delete', { taskId: task.taskId });
      }
    }
  }
}
