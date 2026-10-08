/** Read-only IAM preflight using the same configuration and resolver as deployment. */
import { parseArgs } from 'node:util';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createAgentEngineDeploymentClient } from '../src/server-client.mjs';
import { createHash } from 'node:crypto';

try {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'require-subaccount': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log('Usage: node scripts/check-cloud-identity.mjs [--workspace DIRECTORY] [--require-subaccount]\nRead-only IAM check; does not create or update cloud resources.');
  else {
    const configuration = createGlobalConfiguration({ workspace: values.workspace });
    const resolved = await configuration.resolve();
    const credentialSources = { accessKey: resolved.sources.cloudAccessKey || 'missing', secretKey: resolved.sources.cloudSecretKey || 'missing' };
    const accessKeyFingerprint = resolved.values.cloudAccessKey ? createHash('sha256').update(resolved.values.cloudAccessKey).digest('hex').slice(0, 16) : null;
    console.log(JSON.stringify({ scope: 'configuration-provenance', credentialSources, accessKeyFingerprint }));
    const client = createAgentEngineDeploymentClient({ configuration });
    const identity = await client.inspectIdentity({ forceRefresh: true });
    const accepted = !values['require-subaccount'] || identity.kind === 'subaccount';
    console.log(JSON.stringify({ scope: 'iam-identity-only', verified: true, ...identity,
      ...(accepted ? {} : { code: 'CLOUD_SUBACCOUNT_REQUIRED' }),
      message: identity.kind === 'main-account'
        ? '当前配置为主账号凭证，没有子账号操作人；这不代表子账号部署验收通过'
        : '已核验当前凭证的子账号身份；尚未检查云端创建回调及数据库记录',
    }, null, 2));
    if (!accepted) process.exitCode = 2;
  }
} catch (error) {
  const known = new Set(['CLOUD_IDENTITY_UNVERIFIED', 'CLOUD_ACCOUNT_MISMATCH', 'CLOUD_CREDENTIALS_MISSING',
    'CLOUD_IDENTITY_TARGET_UNSUPPORTED', 'SERVER_URL_INVALID', 'CONFIGURATION_INVALID']);
  console.error(JSON.stringify({ scope: 'iam-identity-only', verified: false,
    code: known.has(error.code) ? error.code : 'CLOUD_IDENTITY_UNVERIFIED' }));
  process.exitCode = 1;
}
