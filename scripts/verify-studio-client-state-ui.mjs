import assert from 'node:assert/strict';

/** Exercise the migrated state through DSH's real navigation and composer. */
export async function verifyStudioClientState(page) {
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await composer.filter({ hasText: '我想通过对话创建一个 Agent' }).waitFor({ state: 'visible', timeout: 20000 });
  const draft = await composer.innerText();
  assert.equal(draft.split('我想通过对话创建一个 Agent').length - 1, 1, 'the native draft must be seeded once');
  assert.match(draft, /我明确确认草稿后再创建/);
  assert.equal(await page.getByRole('button', { name: '取消工作区', exact: true }).isVisible(), false, 'authoring starts without a filesystem Workspace');
  return [{ name: 'scoped-authoring-native-composer-seeded-once', passed: true, sentToModel: false }];
}
