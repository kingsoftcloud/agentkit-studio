/**
 * Model card rendering for model settings: a compact summary for catalog rows
 * (agentic and speed bars, list price, price multiplier) and an expandable
 * detail (introduction, score radar, context, abilities, pricing).
 *
 * Pure render helpers over `card` objects built by ../../model-cards.mjs.
 */
import { formatPrice, formatTokens, priceText, SCORE_DIMENSIONS } from '../../model-cards.mjs';

const ABILITY_LABELS = { tools: '工具调用', reasoning: '推理', vision: '图片理解', video: '视频理解' };
const ABILITY_HINTS = { tools: '可在 Agent 中调用工具', reasoning: '目录声明了可调的推理档位', vision: '接受图片输入', video: '接受视频输入' };

/** The same non-interactive score bars fit the DSH model menu and catalog. */
export function renderModelScoreBars(h, scores, dimensions = SCORE_DIMENSIONS.slice(0, 2)) {
  const values = dimensions.filter(([key]) => Number.isFinite(scores?.values?.[key]));
  if (!values.length) return null;
  return h('span', { 'data-studio-model-score-bars': true, title: scores.source,
    style: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px',
      color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', fontVariantNumeric: 'tabular-nums' } },
  values.map(([key, accessibleLabel]) => {
    const value = scores.values[key];
    const label = key === 'agentic' ? '编程' : accessibleLabel;
    return h('span', { key, role: 'img', 'aria-label': `${accessibleLabel} ${Math.round(value)}`,
      style: { display: 'inline-flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' } },
    h('span', { 'aria-hidden': true }, `${label} ${Math.round(value)}`),
    h('span', { 'aria-hidden': true, style: { display: 'inline-block', inlineSize: '24px', blockSize: '4px',
      borderRadius: '2px', overflow: 'hidden', background: 'var(--dsw-alias-border-l3)' } },
    h('span', { style: { display: 'block', inlineSize: `${value}%`, blockSize: '100%',
      background: 'var(--dsw-alias-state-business-primary)' } })));
  }));
}

/** Inline summary for a catalog row. */
export function renderModelCardSummary(h, Tag, card, multiplier) {
  if (!card) return null;
  const price = priceText(card);
  return h('span', { className: 'ms-card-summary' },
    card.category !== 'chat' ? h(Tag, { tone: 'neutral' }, card.categoryLabel) : renderModelScoreBars(h, card.scores),
    price ? h('span', { title: `每百万 tokens 输入 / 输出（${card.pricing.currency}）` }, h(Tag, { tone: 'neutral' }, price)) : null,
    typeof multiplier === 'number' ? h('span', { title: '按标价估算的相对价格（输入:输出 = 20:1）' },
      h(Tag, { tone: 'quiet' }, `${multiplier}x`)) : null);
}

/** Missing axes stay unplotted so the chart distinguishes missing from zero. */
export function renderRadar(h, values) {
  const width = 320, height = 230, cx = 160, cy = 118, r = 72;
  const axes = SCORE_DIMENSIONS.map(([key, label], index) => {
    const angle = -Math.PI / 2 + index * (2 * Math.PI / SCORE_DIMENSIONS.length);
    const score = values?.[key];
    return { key, label, angle, value: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null };
  });
  const point = (angle, radius) => [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  const ring = level => axes.map(axis => point(axis.angle, r * level).join(',')).join(' ');
  const plotted = axes.map(axis => axis.value === null ? null : point(axis.angle, r * axis.value / 100));
  const complete = plotted.every(Boolean);
  return h('svg', { className: 'ms-card-radar', viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': axes.map(axis => `${axis.label} ${axis.value === null ? '暂无数据' : Math.round(axis.value)}`).join('，') },
    [0.25, 0.5, 0.75, 1].map(level => h('polygon', { key: level, points: ring(level), className: 'ms-card-radar-grid' })),
    axes.map(axis => {
      const [x, y] = point(axis.angle, r);
      return h('line', { key: axis.key, x1: cx, y1: cy, x2: x, y2: y, className: 'ms-card-radar-grid' });
    }),
    complete ? h('polygon', { points: plotted.map(coords => coords.join(',')).join(' '), className: 'ms-card-radar-shape' })
      : plotted.map((coords, index) => {
        const next = plotted[(index + 1) % plotted.length];
        return coords && next ? h('line', { key: index, x1: coords[0], y1: coords[1], x2: next[0], y2: next[1], className: 'ms-card-radar-shape' }) : null;
      }),
    plotted.map((coords, index) => coords && h('circle', { key: index, cx: coords[0], cy: coords[1], r: 2.5, className: 'ms-card-radar-dot' })),
    axes.map(axis => {
      const [x, y] = point(axis.angle, r + 20);
      const anchor = Math.abs(Math.cos(axis.angle)) < 0.2 ? 'middle' : Math.cos(axis.angle) > 0 ? 'start' : 'end';
      return h('text', { key: axis.key, x, y: y + 4, textAnchor: anchor, className: 'ms-card-radar-label' },
        `${axis.label} `, h('tspan', { className: 'ms-card-radar-value' }, axis.value === null ? '—' : Math.round(axis.value)));
    }));
}

export function renderProfileScores(h, card) {
  if (!card?.scores) return null;
  return h('section', { className: 'ms-card-scores', 'aria-label': '模型维度评分' },
    renderRadar(h, card.scores.values),
    h('p', { className: 'ms-card-note' }, card.scores.source));
}

function section(h, title, ...children) {
  return h('section', { className: 'ms-card-section' }, h('h4', { className: 'ms-card-heading' }, title), ...children);
}

function row(h, label, value) {
  return h('div', { className: 'ms-card-row', key: label }, h('dt', null, label), h('dd', { className: 'ms-card-value' }, value));
}

/** Content for the DSH disclosure in a catalog row. */
export function renderModelCardDetails(h, card, multiplier) {
  if (!card) return null;
  const pricing = card.pricing;
  const scores = card.scores;
  return h('div', { className: 'ms-card-body' },
      h('p', { className: 'ms-card-intro' }, card.intro),
      card.category === 'chat' ? section(h, '评分',
        scores ? h('div', { className: 'ms-card-scores' },
          renderRadar(h, scores.values),
          h('p', { className: 'ms-card-note' },
            `${scores.source}${scores.measuredAt ? `，${scores.measuredAt}` : ''}。${scores.live ? '显示网关返回的评分（0–100）。' : '分数表示模型在这组参考样本中的相对位置（0–100）。'}`),
        ) : h('p', { className: 'ms-card-note' }, '暂无评分数据。')) : null,
      card.contextWindow || card.maxOutputTokens ? section(h, '上下文', h('dl', { className: 'ms-card-facts' },
        card.contextWindow ? row(h, '上下文长度', `${formatTokens(card.contextWindow)} tokens`) : null,
        card.maxOutputTokens ? row(h, '最大输出', `${formatTokens(card.maxOutputTokens)} tokens`) : null)) : null,
      card.abilities.length ? section(h, '能力', h('dl', { className: 'ms-card-facts' },
        card.abilities.map(ability => row(h, ABILITY_LABELS[ability], ABILITY_HINTS[ability])))) : null,
      pricing ? section(h, `价格（每百万 tokens，${pricing.currency === 'CNY' ? '人民币' : '美元'}）`,
        h('dl', { className: 'ms-card-facts' },
          row(h, pricing.tiered ? '输入起价' : '输入', formatPrice(pricing.input, pricing.currency)),
          row(h, pricing.tiered ? '输出起价' : '输出', formatPrice(pricing.output, pricing.currency)),
          pricing.cachedInput !== null ? row(h, '输入（缓存命中）', formatPrice(pricing.cachedInput, pricing.currency)) : null,
          typeof multiplier === 'number' ? row(h, '相对价格（标价估算）', `${multiplier}x`) : null,
          typeof card.measuredCostMultiplier === 'number' ? row(h, '网关相对成本', `${card.measuredCostMultiplier}x`) : null),
        pricing.tiered && pricing.note ? h('p', { className: 'ms-card-note' }, pricing.note) : null) : null);
}
