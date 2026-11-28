import { modelScores, SCORE_DIMENSIONS } from './model-cards.mjs';

const benchmarkDimensions = [
  ['toolUse', '工具执行'],
  ['toolAssistedReasoning', '带工具推理'],
  ['workflowAutomation', '自动化'],
  ['repositoryCoding', '代码工程'],
];

// Per-axis means of the ten priced, scored models in RouteMind's
// examples/catalog.json (starflow-cn-2026-11-24-v6, RouteMind 151d40b).
const STARFLOW_AUTO_REFERENCE = Object.freeze({
  dimensions: benchmarkDimensions,
  values: { toolUse: 69.4125, toolAssistedReasoning: 56.75, workflowAutomation: 42.15, repositoryCoding: 60.55 },
  source: '内置星流评测参考（2026-11-24） · 10 个模型，各维度按已有成绩取均值',
});

export function routeMindAutoPreview(scores) {
  return {
    displayName: 'Auto', routeMindAuto: true, scores: scores ?? STARFLOW_AUTO_REFERENCE,
    intro: 'RouteMind 根据任务要求自动选模。实际使用的模型和费用随任务而变。',
  };
}

const validScore = value => Number.isFinite(value) && value >= 0 && value <= 100;

function summarize(rows, dimensions, source) {
  const keys = dimensions.map(([key]) => key);
  const scored = rows.filter(row => keys.some(key => validScore(row?.[key])));
  if (!scored.length) return null;
  const values = Object.fromEntries(keys.map(key => {
    const available = scored.map(row => row[key]).filter(validScore);
    return [key, available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null];
  }));
  return { dimensions, values, source: `${source} · ${scored.length} 个模型，各维度按已有成绩取均值` };
}

/** A score supplied for Auto itself takes priority over directory averages. */
export function autoScoresFromModelDirectory(directory) {
  const auto = modelScores('auto', directory.get('auto'));
  if (auto?.live) return { values: auto.values, source: 'RouteMind 服务提供的 Auto 评分' };
  const models = [...directory].filter(([id]) => !/^auto(?:-|$)/i.test(id));
  return summarize(models.map(([, model]) => model?.scores), SCORE_DIMENSIONS, 'RouteMind 目录参考');
}

/** Reference-only benchmark entries and missing axes do not affect averages. */
export function autoScoresFromBenchmarkCatalog(catalog) {
  if (!Array.isArray(catalog?.models)
    || !benchmarkDimensions.every(([key]) => typeof catalog.dimensions?.[key]?.benchmark === 'string')) return null;
  const priced = new Map(catalog.models.filter(model => typeof model?.id === 'string'
    && Number.isSafeInteger(model.price?.inputMicrosPerMillion) && model.price.inputMicrosPerMillion >= 0
    && Number.isSafeInteger(model.price?.outputMicrosPerMillion) && model.price.outputMicrosPerMillion >= 0)
    .map(model => [model.id, model.scores]));
  const source = /^starflow-/i.test(catalog.version ?? '') ? '星流模型评测目录' : 'RouteMind 评测目录';
  return summarize([...priced.values()], benchmarkDimensions, source);
}
