import { ROUTEMIND_INTRODUCTION_PATH } from '../../star-harness-detail.mjs';
import overviewStyles from '../styles/routemind-detail.css.mjs';

/** Product overview inside the DSH plugin detail shell. */
export function routeMindOverview(h, document) {
  const image = new URL(ROUTEMIND_INTRODUCTION_PATH.slice(1), document.baseURI).href;
  return h('section', { 'aria-label': 'RouteMind 功能介绍', 'data-studio-routemind-overview': true },
    h('style', null, overviewStyles),
    h('figure', { className: 'rm-figure' },
      h('figcaption', { className: 'rm-caption' },
        h('h3', null, '让任务决定用哪个模型'),
        h('p', null, '在 Studio 选 Auto，RouteMind 会根据任务需要，从可用的星流模型中选出能力达标、预估费用更低的模型。轻量任务有机会更快完成，复杂任务优先满足能力要求。'),
        h('p', null, '在 AgentKit 中也可接入同一套选模策略。')),
      h('img', { className: 'rm-illustration', src: image,
        alt: 'Studio 模型菜单中的 Auto 和星流模型能力参考图示意', width: 1180, height: 840 })),
    h('p', { className: 'rm-note' },
      '悬停 Auto 可查看路由能力参考，悬停具体模型可查看已有的评分和价格。'));
}
