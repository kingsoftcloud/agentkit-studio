import { installTaskTimeline as install } from '@kingsoftcloud/agentkit-harness-ui/host/task-timeline';
import { agentFromSessionPreset } from '../state/conversation-agent.mjs';

/** Native owns task interaction; Studio supplies its product preset identity. */
export function installTaskTimeline(ctx, options) {
  return install(ctx, { ...options, resolveAgentFromPreset: (presetId, agents) => {
    const id = agentFromSessionPreset(presetId, agents);
    if (!id && typeof presetId === 'string' && presetId.startsWith('agentkit-studio-agent-'))
      throw Error('当前会话的智能体配置暂不可用，请重试读取');
    return id;
  } });
}
