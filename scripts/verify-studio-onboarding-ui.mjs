/** Exercise the actual installed Studio guide with a local, non-billable model endpoint. */
import {createServer} from 'node:http';
import {expect} from '@playwright/test';

export async function verifyStudioOnboarding(page, screenshotPath) {
  const requests=[];
  const server=createServer((request,response)=>{
    requests.push(request.url); request.resume();
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({object:'list',data:[{id:'onboarding-proof',object:'model',architecture:{input_modalities:['text','image']}}]}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try {
    const guide=page.locator('.agentkit-credential-onboarding-content');
    await expect(guide).toBeVisible({timeout:120000});
    await expect(page.locator('[data-desktop-onboarding]')).toHaveCount(0);
    await expect(page.getByText('欢迎使用 DeepSeek Harness',{exact:true})).toHaveCount(0);
    await expect(guide.getByRole('heading',{name:'让第一个 Agent 跑起来'})).toBeVisible();
    await guide.getByRole('button',{name:'开始设置',exact:true}).click();
    const model=guide.locator('[data-onboarding-mode=model]');
    await expect(model).toBeVisible();
    await model.getByLabel('提供商',{exact:true}).selectOption('custom');
    await model.getByLabel('模型名称',{exact:true}).fill('onboarding-proof');
    const base=`http://127.0.0.1:${server.address().port}/v1`;
    const endpoint=model.getByLabel('API 地址',{exact:true});
    await endpoint.fill(base.replace('http://','')+'/chat/completions');
    await endpoint.press('Tab');
    await expect(endpoint).toHaveValue(base);
    const key=model.getByLabel('API Key',{exact:true});
    await key.fill('onboarding-local-fixture');
    await expect(key).toHaveAttribute('type','password');
    await model.getByRole('button',{name:'显示 API Key',exact:true}).click();
    await expect(key).toHaveAttribute('type','text');
    await model.getByRole('button',{name:'隐藏 API Key',exact:true}).click();
    await expect(key).toHaveAttribute('type','password');
    await page.screenshot({path:screenshotPath,fullPage:true});
    await model.getByRole('button',{name:'保存并继续',exact:true}).click();
    await expect(guide.locator('[data-onboarding-mode=cloud]')).toBeVisible({timeout:90000});
    await expect(guide.getByRole('heading',{name:'云端配置，可以跳过'})).toBeVisible();
    await guide.getByRole('button',{name:'跳过，开始对话',exact:true}).click();
    await expect(guide).toBeHidden();
    await expect(page.locator('[data-desktop-onboarding]')).toHaveCount(0);
    if(!requests.includes('/v1/models')) throw new Error('Configured endpoint did not reach the actual model directory');
    return {officialWelcomeAbsent:true,officialRechargeAbsent:true,fullscreenModelSetupVerified:true,
      apiKeyVisibilityVerified:true,endpointCompletionVerified:true,cloudSetupSkipped:true,modelDirectoryReached:true};
  } finally { server.closeAllConnections(); await new Promise(done=>server.close(done)); }
}
