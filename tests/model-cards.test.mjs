import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelCard, modelDisplayName, modelPricing, modelScores, priceText, priceMultiplier, SCORE_SNAPSHOT } from '../src/model-cards.mjs';
import { HARNESS_SERVICE_MODEL_PROVIDER } from '../src/model-route.mjs';
import { createProductClient } from '../src/remote/control-client.mjs';
import { createModelRoutes } from '../src/host/routes/models.mjs';
import { createModelCatalogPicker, referenceCard } from '../src/client/pages/model-settings-catalog-picker.mjs';
import { renderModelCardDetails, renderRadar } from '../src/client/pages/model-card-view.mjs';

// Entries in the shape Xingliu's /v1/models returns them.
const flash = { id: 'deepseek-v4.1-flash', context_length: '1024k', max_completion_tokens: '384k',
  supports_tools: true, architecture: { input_modalities: ['文字', '图片'], output_modalities: ['文字'] }, pricing: { prompt: '2.0元', completion: '8.0元' } };
const kimi = { id: 'kimi-k2.7-code', context_length: '256k', max_completion_tokens: '256k',
  architecture: { input_modalities: ['文字', '图片', '视频'], output_modalities: ['文字'] }, pricing: { prompt: '6.5元', completion: '27.0元' } };
const tiered = { id: 'minimax-m3', context_length: '512k', architecture: { input_modalities: ['文字'], output_modalities: ['文字'] },
  pricing: { prompt: '输入长度 [0, 512k):4.2元/百万Token;输入长度[512k,1m):8.4元/百万Token元', completion: '输入长度 [0, 512k):16.8元/百万Token;输入长度[512k,1m):33.6元/百万Token元' } };
const embedding = { id: 'qzhou-embedding-v2', context_length: '8k', architecture: { input_modalities: ['文字'], output_modalities: ['向量'] } };
const video = { id: 'seedance-2.0-fast', architecture: { input_modalities: ['文字', '图片'], output_modalities: ['视频'] } };
const Tag = ({ children }) => createElement('span', null, children);

test('card reads use local model operations and preserve legacy catalog calls', async () => {
  const calls = [];
  const remote = createProductClient({ rpc: { async call(channel, operation, payload) {
    calls.push([channel, operation, payload]);
    return { ok: true, value: {} };
  } } }, { window: {} });
  await remote.modelCards();
  await remote.modelCatalogWithCards('routed');
  await remote.modelCatalog('routed');
  assert.deepEqual(calls, [
    ['/agentkit', 'models/cards', {}],
    ['/agentkit', 'models/catalog', { profileId: 'routed', includeCards: true }],
    ['/agentkit', 'server/action', { action: 'models/catalog', payload: { profileId: 'routed' } }],
  ]);
});

test('the Host only enriches catalog reads that opt in', async () => {
  const calls = [];
  const cards = { cards: { [flash.id]: modelCard(flash) } };
  const route = createModelRoutes({ models: {
    catalog: async (...args) => { calls.push(args); return { items: [] }; },
    cards: async () => cards,
  } });
  assert.deepEqual(await route('models/catalog', { profileId: 'routed' }), { ok: true, value: { items: [] } });
  assert.deepEqual(await route('models/catalog', { profileId: 'routed', includeCards: true }), { ok: true, value: { items: [] } });
  assert.deepEqual(await route('models/cards'), { ok: true, value: cards });
  assert.deepEqual(calls, [['routed'], ['routed', { includeCards: true }]]);
});

test('display names keep versions and known spellings', () => {
  assert.equal(modelDisplayName('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(modelDisplayName('qwen3.8-max'), 'Qwen3.8 Max');
  assert.equal(modelDisplayName('gpt-oss-120b'), 'GPT OSS 120B');
  assert.equal(modelDisplayName('mimo-v2.6-pro'), 'MiMo V2.6 Pro');
});

test('Xingliu prices: flat, tiered by input length, and per-token USD', () => {
  assert.deepEqual(modelPricing(flash.pricing), { currency: 'CNY', unit: '1M tokens', input: 2, output: 8, cachedInput: null, tiered: false });
  const tier = modelPricing(tiered.pricing);
  assert.equal(tier.input, 4.2); assert.equal(tier.output, 16.8); assert.equal(tier.tiered, true); assert.match(tier.note, /512k/);
  const usd = modelPricing({ prompt: '0.0000003', completion: '0.0000012' });
  assert.equal(usd.currency, 'USD'); assert.equal(usd.input, 0.3); assert.equal(Math.round(usd.output * 100) / 100, 1.2);
  assert.equal(modelPricing(undefined), null);
  assert.equal(modelPricing({ prompt: 'Infinity', completion: false }), null);
  assert.equal(modelPricing({ prompt: '-2元', completion: -1 }), null);
});

test('cards state catalog facts only', () => {
  const card = modelCard(flash, { reasoningLevels: ['low', 'high'] });
  assert.equal(card.displayName, 'DeepSeek V4.1 Flash');
  assert.equal(card.category, 'chat');
  assert.equal(card.contextWindow, 1024 * 1024);
  assert.deepEqual(card.abilities, ['tools', 'reasoning', 'vision']);
  assert.equal(card.intro, 'DeepSeek 系列的轻量版对话模型。上下文 1M tokens，最大输出 384K，输入：文字、图片，可调推理档位。');
  assert.match(modelCard(kimi).intro, /^月之暗面 Kimi 系列的编程版对话模型/);
  assert.match(modelCard(tiered).intro, /价格按输入长度分档/);
  assert.equal(modelCard(embedding).category, 'embedding');
  assert.equal(modelCard(video).category, 'video');
  assert.deepEqual(modelCard(video).abilities, []);
  assert.ok(!modelCard(kimi).abilities.includes('tools'));
  const named = modelCard({ id: 'image-understanding', name: '视觉助理', output_modalities: ['text'], input: ['constructor', 'image'] });
  assert.equal(named.displayName, '视觉助理');
  assert.equal(named.category, 'chat');
  assert.deepEqual(named.inputModalities, ['image']);
});

test('catalog prices preserve decimals and only compare matching currencies', () => {
  assert.equal(priceText(modelCard(flash)), '¥2/¥8');
  assert.equal(priceText(modelCard(tiered)), '¥4.2/¥16.8起');
  assert.equal(priceText(modelCard(embedding)), '');
  assert.equal(priceMultiplier(modelCard(kimi), modelCard(flash)), 3.27);
  assert.equal(priceMultiplier(modelCard(embedding), modelCard(flash)), null);
});

test('live RouteMind scores win over the snapshot; unknown models have none', () => {
  const live = { scores: { agentic: 80, speed: 40, cost: null, cache: 100, stability: 100, intelligence: null }, cost_multiplier: 1.4 };
  const card = modelCard(flash, { live });
  assert.equal(card.scores.live, true); assert.equal(card.scores.values.agentic, 80); assert.equal(card.scores.values.cost, null);
  assert.equal(card.measuredCostMultiplier, 1.4);
  assert.equal(modelScores('not-measured-model', undefined), null);
  assert.equal(modelScores('__proto__', { scores: { speed: 120, latency: 60, agentic: Infinity } }), null);
  for (const [id, scores] of Object.entries(SCORE_SNAPSHOT.models)) {
    for (const value of Object.values(scores)) assert.ok(value === null || (value >= 0 && value <= 100), `${id} score out of range`);
  }
});

test('catalog rows render bars, price and multiplier; details render a labelled radar', () => {
  const unmeasured = { id: 'glm-5.3-flash', architecture: { input_modalities: ['文字'], output_modalities: ['文字'] }, pricing: { prompt: '0.8元', completion: '2.8元' } };
  const items = [flash, kimi, embedding, unmeasured].map(raw => ({ id: raw.id, name: raw.id, input: ['text'], card: modelCard(raw) }));
  assert.equal(referenceCard(items, { defaultModel: 'deepseek-v4.1-flash' }).id, 'deepseek-v4.1-flash');
  const DisclosureRow = ({ title, open }) => createElement('button', { 'aria-expanded': open }, title);
  const Picker = createModelCatalogPicker({ h: createElement, useState, DisclosureRow, Tag, InfoIcon: 'i' });
  const html = renderToStaticMarkup(Picker({ items, picks: new Map(), existing: new Set(), connection: { defaultModel: 'deepseek-v4.1-flash' },
    onPick() {}, manualIds: new Set(), probing: false, reportFor: () => null }));
  assert.match(html, /¥6\.5\/¥27/);
  assert.match(html, /3\.27x/);
  assert.match(html, /aria-label="编程 Agent 20"/);  // measured in the built-in snapshot
  const unmeasuredRow = html.slice(html.indexOf('aria-label="glm-5.3-flash"'));
  assert.doesNotMatch(unmeasuredRow.slice(0, unmeasuredRow.indexOf('</label>')), /data-studio-model-score-bars/);
  assert.match(html, /模型详情/);
  assert.match(html, /向量 \/ 重排/);
  assert.match(renderToStaticMarkup(renderModelCardDetails(createElement, modelCard(unmeasured))), /暂无评分数据/);
  const radar = renderToStaticMarkup(renderRadar(createElement, { agentic: 95, speed: 45, cost: 53, cache: null, stability: 60, intelligence: 38 }));
  assert.match(radar, /aria-label="编程 Agent 95，速度 45，性价比 53，缓存友好 暂无数据，稳定性 60，综合能力 38"/);
  assert.doesNotMatch(radar, /<polygon[^>]+ms-card-radar-shape/);
});

test('chat selector label: name, price and measured scores; trigger stays name-only', async () => {
  const { createModelCardIndex, modelLabel } = await import('../src/client/dsh/model-label.mjs');
  let loads = 0;
  const provider = 'agentkit-studio-fixture';
  const index = createModelCardIndex(async () => {
    loads += 1;
    return { enabled: true, cardsByProvider: { [provider]: { [flash.id]: modelCard(flash) } } };
  });
  await Promise.all([index.refresh(), index.refresh()]);
  assert.equal(loads, 1);
  const option = renderToStaticMarkup(modelLabel(createElement, Tag, index.card(provider, flash.id), { id: flash.id, name: flash.id }, 'option'));
  assert.match(option, /DeepSeek V4\.1 Flash/);
  assert.match(option, /¥2\/¥8/);
  assert.match(option, /data-studio-model-score-bars="true".*编程 60.*速度 80/);
  const live = modelCard(flash, { live: { scores: { agentic: 95, speed: 87, cost: 72, cache: 62, stability: 91, intelligence: 80 } } });
  const scoredOption = renderToStaticMarkup(modelLabel(createElement, Tag, live, { id: flash.id }, 'option'));
  assert.match(scoredOption, /编程 95.*速度 87.*性价比 72.*缓存友好 62.*稳定性 91.*综合能力 80/);
  const trigger = renderToStaticMarkup(modelLabel(createElement, Tag, index.card(provider, flash.id), { id: flash.id, name: flash.id }, 'trigger'));
  assert.match(trigger, /DeepSeek V4\.1 Flash/);
  assert.doesNotMatch(trigger, /¥|model-score-bars/);
  assert.equal(index.card('codex', flash.id).pricing, undefined);
  assert.equal(index.card(HARNESS_SERVICE_MODEL_PROVIDER, flash.id).pricing, undefined);
  const other = renderToStaticMarkup(modelLabel(createElement, Tag, index.card('codex', 'kimi-k2.7-code'), { id: 'kimi-k2.7-code' }, 'option'));
  assert.match(other, /Kimi K2\.7 Code/); assert.match(other, /编程 20/); assert.doesNotMatch(other, /¥/);
  const unknown = renderToStaticMarkup(modelLabel(createElement, Tag, index.card('codex', 'gpt-5.4'), { id: 'gpt-5.4', name: 'GPT-5.4' }, 'option'));
  assert.doesNotMatch(unknown, /编程|¥/);
});

test('radar and price comparisons omit invalid values instead of rendering them', () => {
  const radar = renderToStaticMarkup(renderRadar(createElement, { agentic: NaN, speed: 150, cost: -25 }));
  assert.match(radar, /编程 Agent 暂无数据，速度 100，性价比 0/);
  assert.doesNotMatch(radar, /NaN|Infinity/);
  const price = (input, output) => ({ pricing: { currency: 'USD', input, output } });
  assert.equal(priceMultiplier(price(1, 1), price(0, 0)), null);
  assert.equal(priceMultiplier(price(1, 1), price(Number.MIN_VALUE, Number.MIN_VALUE)), null);
  assert.equal(priceMultiplier(price(2, 2), price(1, 1)), 2);
});

test('the trigger observes the menu name without holding open stale price eligibility', async () => {
  const { createModelCardIndex } = await import('../src/client/dsh/model-label.mjs');
  const provider = 'agentkit-studio-fixture';
  const card = { ...modelCard(flash), displayName: 'Verified Display Name' };
  let calls = 0;
  const index = createModelCardIndex(async () => { calls++; return { enabled: true, cardsByProvider: { [provider]: { [flash.id]: card } } }; });
  let triggerUpdates = 0;
  const closeTrigger = index.subscribe(() => { triggerUpdates++; }, { menu: false });
  assert.equal(calls, 0);
  const closeMenu = index.subscribe(() => {});
  await index.refresh();
  assert.equal(triggerUpdates, 1);
  assert.equal(index.card(provider, flash.id), card);
  closeMenu();
  assert.equal(index.card(provider, flash.id), null);
  assert.equal(index.card(provider, flash.id, { allowCached: true }), card);
  closeTrigger();
});

test('model labels show scores only during an enabled plugin generation', async () => {
  const { createModelCardIndex } = await import('../src/client/dsh/model-label.mjs');
  const card = modelCard(flash);
  const provider = 'agentkit-studio-fixture';
  let enabled = false;
  const index = createModelCardIndex(async () => ({ enabled, cardsByProvider: { [provider]: { [flash.id]: card } } }));
  const first = index.subscribe(() => {});
  await index.refresh();
  assert.equal(index.card(provider, flash.id), null);
  assert.equal(index.card('codex', flash.id), null, 'reference scores also follow plugin enablement');
  first();
  enabled = true;
  const reopen = index.subscribe(() => {});
  await index.refresh();
  assert.equal(index.card(provider, flash.id), card);
  const active = index.subscribe(() => {});
  reopen();
  assert.equal(index.card(provider, flash.id), card);
  active();
  assert.equal(index.card(provider, flash.id), null, 'a re-opened menu must await the next activation check');
  enabled = false;
  await index.refresh();
  assert.equal(index.card(provider, flash.id), null);
});
