/** Product overview inside the same DSH bundle detail shell as other plugins. */
export function routeMindOverview(h, BRAND) {
  const card = { padding: 'clamp(18px, 4vw, 36px)', borderRadius: '12px',
    maxWidth: '860px', background: '#eef7f4', color: '#123833', display: 'grid', gap: '16px' };
  const tags = { display: 'flex', flexWrap: 'wrap', gap: '8px' };
  const tag = { padding: '5px 10px', borderRadius: '6px', background: '#d4eae4', color: '#15463e' };
  return h('section', { 'aria-label': 'RouteMind 功能介绍', 'data-studio-routemind-overview': true },
    h('div', { style: card },
      h('h4', { style: { margin: 0, fontSize: 'clamp(20px, 4vw, 30px)' } }, '给每个任务选择合适的模型'),
      h('p', { style: { margin: 0, lineHeight: 1.6 } }, '在对话中选择 Auto，RouteMind 会通过网关根据任务选择模型。'),
      h('div', { style: tags }, ...['价格优先', '均衡', '质量优先'].map(label => h('span', { key: label, style: tag }, label)))),
    h('p', { style: { color: BRAND.inkMuted, lineHeight: 1.6 } },
      '开启后可在模型菜单与模型配置中查看有数据的评分和价格。自动路由需要可用的 RouteMind 网关。'));
}
