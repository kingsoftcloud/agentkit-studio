import { modelCatalogLimits } from './model-capabilities.mjs';
import { inputModalities } from './model-input.mjs';

/**
 * Model cards: display name, vendor, factual introduction, pricing, abilities
 * and comparative scores for catalog models.
 *
 * Shared by the Host (catalog normalization) and the browser (model settings).
 * Everything shown comes from the provider catalog, the model id, or a
 * measured score source; nothing is invented. Xingliu's `/v1/models` lists
 * prices as text in CNY per million tokens ("2.0元", or tiers keyed by input
 * length) and modalities in Chinese ("文字", "图片", ...).
 */

const VENDORS = [
  [/^deepseek/, 'DeepSeek', 'DeepSeek'],
  [/^kimi|^moonshot/, 'Kimi', '月之暗面'],
  [/^glm|^chatglm/, 'GLM', '智谱'],
  [/^qwen|^qwq|^tongyi/, 'Qwen', '阿里通义'],
  [/^mimo/, 'MiMo', '小米'],
  [/^minimax|^abab/, 'MiniMax', 'MiniMax'],
  [/^seed|^doubao|^seedream|^seedance/, 'Seed', '字节跳动'],
  [/^hunyuan/, 'Hunyuan', '腾讯混元'],
  [/^gpt-oss/, 'GPT-OSS', 'OpenAI'],
  [/^ernie/, 'ERNIE', '百度'],
  [/^kling/, 'Kling', '快手可灵'],
  [/^wan\d/, 'Wan', '阿里通义万相'],
  [/^hailuo/, 'Hailuo', 'MiniMax 海螺'],
  [/^vidu/, 'Vidu', '生数科技'],
  [/^eleven/, 'ElevenLabs', 'ElevenLabs'],
  [/^speech-/, 'Speech', 'MiniMax'],
];

const MODALITY = { 文字: 'text', 文本: 'text', 图片: 'image', 图像: 'image', 视频: 'video', 音频: 'audio', 语音: 'audio', 文件: 'file',
  text: 'text', image: 'image', video: 'video', audio: 'audio', file: 'file' };
const MODALITY_LABEL = { text: '文字', image: '图片', video: '视频', audio: '音频', file: '文件' };

/** Known variant words in model ids, read as plain naming facts. */
const VARIANTS = [
  [/(^|-)(code|coder)(-|$)/, '编程版'],
  [/(^|-)(highspeed|ultraspeed|turbo)(-|$)/, '高速版'],
  [/(^|-)(flash|lite|mini|air)(-|$)/, '轻量版'],
  [/(^|-)(max|pro|plus)(-|$)/, '旗舰版'],
  [/(^|-)preview(-|$)/, '预览版'],
];

function modalities(value) {
  const list = Array.isArray(value) ? value : [];
  const keys = list.filter(item => typeof item === 'string').map(item => item.trim().toLowerCase());
  return [...new Set(keys.filter(key => Object.hasOwn(MODALITY, key)).map(key => MODALITY[key]))];
}

/** Category of a catalog entry; only `chat` models can drive an agent. */
export function modelCategory(id, outputModalities = []) {
  const name = id.toLowerCase();
  if (/embedding|bge|reranker|rerank/.test(name)) return 'embedding';
  const out = modalities(outputModalities);
  if (out.includes('text')) return 'chat';
  if (out.includes('video') || /seedance|kling|vidu|hailuo|i2v|t2v/.test(name)) return 'video';
  if (out.includes('image') || /seedream|t2i|^mog-|^mcs-/.test(name)) return 'image';
  if (out.includes('audio') || /^speech-|^eleven|tts/.test(name)) return 'speech';
  return 'chat';
}

const CATEGORY_LABEL = { chat: '对话', embedding: '向量 / 重排', image: '图像生成', video: '视频生成', speech: '语音合成' };

const WORDS = { deepseek: 'DeepSeek', glm: 'GLM', chatglm: 'ChatGLM', mimo: 'MiMo', minimax: 'MiniMax', gpt: 'GPT', oss: 'OSS', hd: 'HD',
  kimi: 'Kimi', qwen: 'Qwen', qwq: 'QwQ', bge: 'BGE', tts: 'TTS', ernie: 'ERNIE', vl: 'VL', omni: 'Omni', o: 'O' };

/** "deepseek-v4.1-flash" -> "DeepSeek V4.1 Flash"; "qwen3.8-max" -> "Qwen3.8 Max"; "gpt-oss-120b" -> "GPT OSS 120B". */
export function modelDisplayName(id) {
  const parts = String(id || '').trim().split(/[-_]/).filter(Boolean);
  return parts.map(part => {
    const lower = part.toLowerCase();
    if (Object.hasOwn(WORDS, lower)) return WORDS[lower];
    if (/^v\d/.test(lower)) return 'V' + part.slice(1);
    if (/^\d+(\.\d+)?[bkm]$/.test(lower)) return part.toUpperCase();
    if (/^\d/.test(part)) return part;
    const match = /^([a-z]+)(\d.*)?$/i.exec(part);
    if (!match) return part;
    const key = match[1].toLowerCase();
    const word = Object.hasOwn(WORDS, key) ? WORDS[key] : match[1][0].toUpperCase() + match[1].slice(1);
    return word + (match[2] || '');
  }).join(' ');
}

function priceNumber(text) {
  const match = typeof text === 'string' ? /(-?\d+(?:\.\d+)?)\s*元/.exec(text) : null;
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse catalog pricing. Xingliu: CNY per million tokens as text, sometimes
 * tiered by input length (the first tier is used for comparisons and the full
 * text is kept). OpenRouter-style numeric prices: USD per token.
 */
export function modelPricing(raw) {
  const pricing = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!pricing) return null;
  const prompt = pricing.prompt ?? pricing.input, completion = pricing.completion ?? pricing.output;
  const cached = pricing.input_cache_read ?? pricing.cached_input ?? pricing.cache_read;
  if ([prompt, completion].some(value => typeof value === 'string' && /元/.test(value))) {
    const tiered = [prompt, completion].some(value => /[;；]|\[/.test(String(value ?? '')));
    const input = priceNumber(prompt), output = priceNumber(completion), cachedInput = cached === undefined ? null : priceNumber(cached);
    if (input === null && output === null) return null;
    return { currency: 'CNY', unit: '1M tokens', input, output, cachedInput, tiered,
      ...(tiered ? { note: [prompt, completion].filter(Boolean).map(String).join('；') } : {}) };
  }
  // OpenRouter-style lists use a decimal string or number in USD per token.
  const perToken = value => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const amount = Number(value) * 1e6;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  };
  const input = perToken(prompt), output = perToken(completion);
  if (input === null && output === null) return null;
  return { currency: 'USD', unit: '1M tokens', input, output, cachedInput: perToken(cached), tiered: false };
}

/** RouteMind prices are already in USD per million tokens. */
function routeMindPricing(prices) {
  const rate = value => Number.isFinite(value) && value >= 0 ? value : null;
  const input = rate(prices?.input), output = rate(prices?.output);
  if (input === null && output === null) return null;
  return { currency: 'USD', unit: '1M tokens', input, output, cachedInput: rate(prices?.cached_input), tiered: false };
}

/** Price used for comparisons: agent work is input-heavy, so input:output is weighted 20:1. */
export function blendedPrice(pricing) {
  if (!pricing || pricing.input === null || pricing.output === null) return null;
  return (20 * pricing.input + pricing.output) / 21;
}

export function formatPrice(value, currency = 'CNY') {
  if (!Number.isFinite(value) || value < 0) return '—';
  const symbol = currency === 'CNY' ? '¥' : '$';
  return symbol + (value > 0 && value < 0.000001 ? '<0.000001' : String(Number(value.toFixed(6))));
}

export function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_048_576) return `${Math.round(value / 1_048_576 * 10) / 10}M`;
  if (value >= 1024) return `${Math.round(value / 1024 * 10) / 10}K`;
  return String(value);
}

/**
 * Comparative scores measured with Studio + Star Harness (ksadk-harness) on a
 * 5-task hard coding set (Python / JavaScript / Go, hidden tests) through
 * Xingliu, one run per model and task, 15-minute limit per task.
 *   agentic: share of tasks solved
 *   speed:   mean time per solved task (a model that gives up early is not fast)
 *   cost:    list-price spend per solved task, cached input billed at full price
 *   cache:   cached share of input tokens
 * Each is a 0-100 percentile among the measured models, not an absolute rating.
 * stability and intelligence were not measured. Small sample: indicative only.
 * Live RouteMind data replaces this when a gateway is configured.
 */
export const SCORE_SNAPSHOT = Object.freeze({
  source: 'Studio + Star Harness 参考样本（5 道编程题，每题单次运行。速度和性价比按做对的题计算）',
  measuredAt: '2026-11-25',
  models: Object.freeze({
    'mimo-v2.6-pro': Object.freeze({ agentic: 100.0, speed: 40.0, cost: 80.0, cache: 20.0, stability: null, intelligence: null }),
    'deepseek-v4.1-flash': Object.freeze({ agentic: 60.0, speed: 80.0, cost: 100.0, cache: 80.0, stability: null, intelligence: null }),
    'minimax-m3': Object.freeze({ agentic: 60.0, speed: 60.0, cost: 20.0, cache: 100.0, stability: null, intelligence: null }),
    'kimi-k2.7-code': Object.freeze({ agentic: 20.0, speed: 0.0, cost: 40.0, cache: 60.0, stability: null, intelligence: null }),
    'glm-5.3': Object.freeze({ agentic: 20.0, speed: 20.0, cost: 0.0, cache: 40.0, stability: null, intelligence: null }),
    'qwen3.8-max': Object.freeze({ agentic: 0.0, speed: 100.0, cost: 60.0, cache: 0.0, stability: null, intelligence: null }),
  }),
});

const DIMENSIONS = [
  ['agentic', '编程 Agent'],
  ['speed', '速度'],
  ['cost', '性价比'],
  ['cache', '缓存友好'],
  ['stability', '稳定性'],
  ['intelligence', '综合能力'],
];

/** Scores for one model: live RouteMind first, then the built-in snapshot. */
export function modelScores(id, live) {
  const fromLive = live?.scores;
  const values = Object.fromEntries(DIMENSIONS.map(([key]) => {
    const value = fromLive?.[key];
    return [key, Number.isFinite(value) && value >= 0 && value <= 100 ? value : null];
  }));
  if (Object.values(values).some(value => value !== null)) {
    return { source: 'RouteMind 网关实测', measuredAt: null, live: true,
      values };
  }
  const snapshot = Object.hasOwn(SCORE_SNAPSHOT.models, id) ? SCORE_SNAPSHOT.models[id] : null;
  if (!snapshot) return null;
  return { source: SCORE_SNAPSHOT.source, measuredAt: SCORE_SNAPSHOT.measuredAt, live: false,
    values: Object.fromEntries(DIMENSIONS.map(([key]) => [key, typeof snapshot[key] === 'number' ? snapshot[key] : null])) };
}

export const SCORE_DIMENSIONS = DIMENSIONS;

/**
 * Build the card for one raw catalog entry (`/v1/models` item) plus optional
 * live RouteMind data for the same id.
 */
export function modelCard(raw = {}, { live, reasoningLevels } = {}) {
  const id = String(raw.id || '').trim();
  const lower = id.toLowerCase();
  const vendor = VENDORS.find(([pattern]) => pattern.test(lower));
  const architecture = raw.architecture && typeof raw.architecture === 'object' ? raw.architecture : {};
  const displayName = typeof raw.name === 'string' && raw.name.trim() && raw.name !== id ? raw.name.trim() : modelDisplayName(id);
  const input = modalities(inputModalities(raw));
  const output = modalities(raw.output_modalities ?? architecture.output_modalities);
  const category = modelCategory(id, output);
  const { contextWindow: context = null, maxOutputTokens: maxOutput = null } = modelCatalogLimits(raw);
  const variant = VARIANTS.filter(([pattern]) => pattern.test(lower)).map(([, label]) => label);
  const pricing = modelPricing(raw.pricing) ?? routeMindPricing(live?.pricing_per_mtok);
  const reasoning = Array.isArray(reasoningLevels) && reasoningLevels.length > 0;
  // Abilities describe what an agent model can do; generation and embedding models have none here.
  const abilities = category !== 'chat' ? [] : [
    ...(raw.supports_tools === true || raw.capabilities?.tools === true ||
      (Array.isArray(raw.supported_parameters) && raw.supported_parameters.includes('tools')) ? ['tools'] : []),
    ...(reasoning ? ['reasoning'] : []),
    ...(input.includes('image') ? ['vision'] : []),
    ...(input.includes('video') ? ['video'] : []),
  ];
  const facts = [
    context ? `上下文 ${formatTokens(context)} tokens` : null,
    maxOutput ? `最大输出 ${formatTokens(maxOutput)}` : null,
    input.length ? `输入：${input.map(item => MODALITY_LABEL[item]).join('、')}` : null,
    reasoning ? '可调推理档位' : null,
  ].filter(Boolean);
  const intro = [
    `${vendor && vendor[2] !== vendor[1] ? vendor[2] + ' ' : ''}${vendor ? vendor[1] : modelDisplayName(id)} 系列${variant.length ? '的' + variant.join('、') : ''}${CATEGORY_LABEL[category]}模型。`,
    facts.length ? facts.join('，') + '。' : '',
    pricing?.tiered ? '价格按输入长度分档。' : '',
  ].join('');
  return {
    id,
    displayName,
    vendor: vendor ? { name: vendor[1], company: vendor[2] } : null,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    intro,
    contextWindow: context,
    maxOutputTokens: maxOutput,
    inputModalities: input,
    abilities,
    pricing,
    scores: modelScores(id, live),
    ...(Number.isFinite(live?.cost_multiplier) && live.cost_multiplier >= 0 ? { measuredCostMultiplier: live.cost_multiplier } : {}),
  };
}

/** Price multiplier of each card against a reference card (list prices, input:output weighted 20:1). */
export function priceMultiplier(card, reference) {
  const own = blendedPrice(card?.pricing), base = blendedPrice(reference?.pricing);
  if (own === null || !base || card.pricing.currency !== reference.pricing.currency) return null;
  const multiplier = Math.round(own / base * 100) / 100;
  return Number.isFinite(multiplier) ? multiplier : null;
}

/** List price as "¥2/¥8" (input/output per 1M tokens), "起" for tiered prices; '' when unknown. */
export function priceText(card) {
  const pricing = card?.pricing;
  if (!pricing || pricing.input === null || pricing.output === null) return '';
  return `${formatPrice(pricing.input, pricing.currency)}/${formatPrice(pricing.output, pricing.currency)}${pricing.tiered ? '起' : ''}`;
}
