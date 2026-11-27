import { ROUTEMIND_INTRODUCTION_PATH } from '../../star-harness-detail.mjs';

/** Product overview inside the DSH plugin detail shell. */
export function routeMindOverview(h, BRAND, document) {
  const image = new URL(ROUTEMIND_INTRODUCTION_PATH.slice(1), document.baseURI).href;
  const figure = { maxWidth: '860px', margin: 0, overflow: 'hidden', borderRadius: '12px',
    background: '#f2f3fa', color: '#22293e' };
  return h('section', { 'aria-label': 'RouteMind 功能介绍', 'data-studio-routemind-overview': true },
    h('figure', { style: figure },
      h('div', { style: { padding: 'clamp(18px, 3.5vw, 32px) clamp(18px, 4vw, 38px) 0' } },
        h('h3', { style: { margin: 0, fontSize: 'clamp(20px, 4vw, 30px)', fontWeight: 600 } }, '为任务选择最有性价比的模型'),
        h('p', { style: { margin: '8px 0 0', color: '#515b72', lineHeight: 1.6 } },
          'RouteMind 根据任务要求选择模型。在保证结果质量的前提下，优先选择响应更快、成本更低的模型。')),
      h('img', { src: image, alt: '', width: 1500, height: 500,
        style: { display: 'block', width: '100%', height: 'auto' } }),
      h('figcaption', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        textAlign: 'center', padding: '0 14px 20px', fontSize: 'clamp(11px, 1.5vw, 14px)', fontWeight: 550 } },
        h('span', null, '对话任务'), h('span', null, 'RouteMind 评估与路由'), h('span', null, '选中的模型'))),
    h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.6 } },
      '启用插件后，在对话的模型菜单选择 Auto。也可悬停在具体模型上，查看已有的能力数据、评分和价格。'));
}
