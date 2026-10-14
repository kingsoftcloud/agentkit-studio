import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createDomainPage({ ui }) {
  const { React, DisabledAction, EmptyState, Pill, SectionHeading, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h } = React;
  function DomainPage({ page }) {
    const content = {
      agents: ['Agent', '创建、配置和版本化可运行的 Agent。', '✦', 'Agent Catalog 与 Revision 接通后，这里会成为 Agent 的工作台。'],
      runtime: ['运行时', '选择执行目标，查看能力和运行状态。', '⌁', '当前 Agent 运行目标为 DSH Native、AgentKit Harness 和 Codex；不绑定 Agent 时使用 DSH 原生会话。资源绑定会在运行能力未就绪时明确阻止构建。'],
      resources: ['资源', '管理模型、工具、MCP 与 Skill 的目录生命周期。', '◈', '资源目录只负责发现、导入、探测、查看、刷新和删除；Agent 绑定在创建或编辑页完成。'],
      delivery: ['构建与部署', '从 Revision 到 Build、Deploy 和回滚。', '↗', '云端 API gap 完成核对后，这里接入真实异步 operation 和部署状态。'],
    }[page];
    return h('section', { style: { border: '1px solid ' + BRAND.border, borderRadius: '16px', padding: '22px', background: BRAND.surface } },
      h(SectionHeading, { eyebrow: 'Studio domain', title: content[0], detail: content[1], action: h(Pill, { tone: 'signal' }, 'Host 待接入') }),
      h(EmptyState, { icon: content[2], title: content[0] + '正在准备', detail: content[3], action: h(DisabledAction, null, '等待 Host 能力') }));
  }
  return { DomainPage };
}
