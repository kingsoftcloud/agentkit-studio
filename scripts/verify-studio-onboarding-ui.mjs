/** Exercise the actual installed Studio guide with a local, non-billable model endpoint. */
import {createServer} from 'node:http';
import {expect} from '@playwright/test';

/**
 * First use walks the shipped five-step model form:
 * provider → API address → 1. API Key → 2. choose a model (catalog select or
 * manual name) → save and continue. The form is driven through its accessible
 * names so the check fails when a control loses its label, not only when the
 * visible layout changes.
 */
export async function verifyStudioOnboarding(page, screenshotPath) {
  const requests=[];
  const server=createServer((request,response)=>{
    requests.push(request.url); request.resume();
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({object:'list',data:[
      {id:'onboarding-proof',object:'model',architecture:{input_modalities:['text','image']}},
      {id:'onboarding-proof-secondary',object:'model',architecture:{input_modalities:['text']}},
    ]}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try {
    const guide=page.locator('.agentkit-credential-onboarding-content');
    await expect(guide).toBeVisible({timeout:120000});
    // The product bundle suppresses the official DeepSeek first-use surface
    // (needsWelcome=false in patch 009). [data-desktop-onboarding] is still
    // shipped by dsh-client-ui-settings-account and wraps both its welcome and
    // credit/recharge steps, so this keeps the publication flags honest.
    await expect(page.locator('[data-desktop-onboarding]')).toHaveCount(0);
    await expect(guide.getByRole('heading',{name:'让第一个 Agent 跑起来'})).toBeVisible();
    await guide.getByRole('button',{name:'开始设置',exact:true}).click();
    const model=guide.locator('[data-onboarding-mode=model]');
    await expect(model).toBeVisible();
    const save=model.getByRole('button',{name:'保存并继续',exact:true});
    await expect(save).toBeEnabled({timeout:90000});

    // 1. Provider, then 2. the API address it reveals for custom providers.
    const provider=model.getByRole('combobox',{name:'提供商',exact:true});
    await expect(provider).toBeVisible();
    await provider.selectOption('custom');
    await expect(provider).toHaveValue('custom');
    const base=`http://127.0.0.1:${server.address().port}/v1`;
    const endpoint=model.getByLabel('API 地址',{exact:true});
    await endpoint.fill(base.replace('http://','')+'/chat/completions');
    await endpoint.press('Tab');
    await expect(endpoint).toHaveValue(base);

    // 3. Reading the catalog needs the API key; the probe reports the missing
    // key inline instead of submitting the form.
    const manual=model.getByLabel('模型名称',{exact:true});
    await expect(manual).toBeVisible();
    await model.getByRole('button',{name:'读取模型',exact:true}).click();
    await expect(model.getByText('请先填写 API Key',{exact:true})).toBeVisible();
    const key=model.getByLabel('API Key',{exact:true});
    await key.fill('onboarding-local-fixture');
    await expect(key).toHaveAttribute('type','password');
    await model.getByRole('button',{name:'显示 API Key',exact:true}).click();
    await expect(key).toHaveAttribute('type','text');
    await model.getByRole('button',{name:'隐藏 API Key',exact:true}).click();
    await expect(key).toHaveAttribute('type','password');

    // 4. Read the real catalog from the fixture endpoint and choose a model.
    await model.getByRole('button',{name:'读取模型',exact:true}).click();
    await expect(model.getByText('已读取 2 个模型',{exact:true})).toBeVisible({timeout:60000});
    const select=model.getByRole('combobox',{name:'选择模型',exact:true});
    await expect(select).toBeVisible();
    await expect(select.locator('option[value="onboarding-proof"]')).toHaveCount(1);
    // Reading the catalog must not silently replace a model that is absent from
    // it; the manual field keeps its value until a pick is made.
    await expect(select).toHaveValue('__custom__');
    await expect(manual).not.toHaveValue('');

    // Selecting a catalog model writes the value into the model field.
    await select.selectOption('onboarding-proof');
    await expect(select).toHaveValue('onboarding-proof');
    await expect(manual).toHaveCount(0);
    const card=model.locator('[data-model-profile-card]').first();
    await expect(card.locator('strong').first()).toHaveText('onboarding-proof');
    await select.selectOption('onboarding-proof-secondary');
    await expect(select).toHaveValue('onboarding-proof-secondary');
    await expect(card.locator('strong').first()).toHaveText('onboarding-proof-secondary');

    // 5. The manual branch stays available for models outside the catalog.
    await select.selectOption('__custom__');
    await expect(manual).toBeVisible();
    await expect(manual).toHaveValue('');
    await manual.fill('onboarding-proof-manual');
    await expect(manual).toHaveValue('onboarding-proof-manual');
    await expect(select).toHaveValue('__custom__');
    await select.selectOption('onboarding-proof');
    await expect(select).toHaveValue('onboarding-proof');
    await expect(manual).toHaveCount(0);
    await page.screenshot({path:screenshotPath,fullPage:true});

    // A missing model name blocks the step instead of advancing it.
    await select.selectOption('__custom__');
    await expect(manual).toHaveValue('');
    await save.click();
    await expect(model.getByRole('alert')).toHaveText('每个模型配置都需要填写模型名称');
    await expect(guide.locator('[data-onboarding-mode=cloud]')).toHaveCount(0);
    await select.selectOption('onboarding-proof');
    await expect(select).toHaveValue('onboarding-proof');
    await save.click();

    // Saving advances to the optional cloud step.
    const cloud=guide.locator('[data-onboarding-mode=cloud]');
    await expect(cloud).toBeVisible({timeout:90000});
    await expect(model).toHaveCount(0);
    await expect(guide.getByRole('heading',{name:'云端配置，可以跳过'})).toBeVisible();
    await expect(cloud.getByLabel('Access Key',{exact:true})).toBeVisible();
    await expect(cloud.getByLabel('Secret Key',{exact:true})).toBeVisible();
    await cloud.getByText('高级云端设置',{exact:true}).click();
    for(const label of ['Account ID','区域','控制面地址','对象存储桶']) {
      await expect(cloud.getByLabel(label,{exact:true})).toBeVisible();
    }
    await page.screenshot({path:screenshotPath.replace(/\.png$/,'-cloud.png'),fullPage:true});
    await guide.getByRole('button',{name:'跳过，开始对话',exact:true}).click();
    await expect(guide).toBeHidden();
    if(!requests.includes('/v1/models')) throw new Error('Configured endpoint did not reach the actual model directory');
    return {officialWelcomeAbsent:true,officialRechargeAbsent:true,fullscreenModelSetupVerified:true,
      modelProviderSelected:true,endpointCompletionVerified:true,apiKeyRequirementVerified:true,
      apiKeyVisibilityVerified:true,requiredValidationVerified:true,modelCatalogReadVerified:true,
      modelSelectionVerified:true,manualModelNameVerified:true,cloudAdvancedSettingsVerified:true,
      cloudSetupSkipped:true,modelDirectoryReached:true};
  } finally { server.closeAllConnections(); await new Promise(done=>server.close(done)); }
}
