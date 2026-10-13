/** Verify the Studio adapter in the real public DSH LLM registry. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { CODEX_PROVIDER, createCodexModelAdapter, createCodexModelCatalog } from '../src/providers/codex-models.mjs';

const dshRoot = resolve(process.env.AGENTKIT_DSH_ROOT || fileURLToPath(new URL('../../../deepseek-harness', import.meta.url)));
const require = createRequire(join(dshRoot, 'packages/llm/llm/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const { default: LlmRuntime, LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
const ctx = new Context();
await ctx.plugin(LlmRuntime);
const runtime = createDshRuntimeAdapter({ AdapterBase: LlmAdapter });
const live = process.argv.includes('--codex');
const catalog = live ? createCodexModelCatalog() : { list: async () => ({ items: [{ resourceId: 'contract-model', displayName: 'Contract model' }] }) };
const unregister = ctx.llm.registerAdapter([CODEX_PROVIDER], createCodexModelAdapter({ catalog, runtime }));
try {
  const models = await ctx.llm.listModels(CODEX_PROVIDER);
  assert.ok(models.length > 0);
  const model = await ctx.llm.resolveModelInfo(CODEX_PROVIDER, models[0].id);
  assert.equal(model.id, models[0].id);
  assert.equal(model.provider, CODEX_PROVIDER);
  console.log(JSON.stringify({ registry: 'official-dsh', catalog: live ? 'live-codex-app-server' : 'synthetic-contract', modelCount: models.length, resolvedModel: model.id }));
} finally { unregister(); }
assert.equal(ctx.llm.listProviders().some(item => item.id === CODEX_PROVIDER), false);
