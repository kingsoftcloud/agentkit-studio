/** Curated first-party DSH bundles shown by the Studio plugin center.
 *
 * This is a discovery and verification manifest only. Installation, profile
 * writes, compatibility checks, approvals, and runtime loading stay owned by
 * the official DSH plugin manager.
 */
export const DSH_CURATED_PLUGINS = Object.freeze([
  {
    id: '@deepseek-ai/dsh-experimental-agent-team-profile',
    installSpec: '@deepseek-ai/dsh-experimental-agent-team-profile',
    displayName: 'Agent Teams',
    description: '团队委派、成员会话、共享任务板与成员消息。',
    category: '协作',
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['spawn_teammate', 'list_agents', 'team_task', '成员会话'],
    expectedEntries: ['agent-team', 'tool-agent-team', 'ui-agent-team'],
    service: { name: 'agentTeams', methods: ['listMembers', 'spawnTeammate', 'createTask'] },
    readinessNote: 'Host 已加载 Agent Teams 服务、工具和 Web 界面。',
  },
  {
    id: '@deepseek-ai/dsh-experimental-voice-input-bundle',
    installSpec: '@deepseek-ai/dsh-experimental-voice-input-bundle',
    displayName: '语音输入',
    description: '本地语音识别、麦克风录音与可编辑草稿插入。',
    category: '输入',
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['麦克风录音', 'SenseVoice 转写', '草稿插入'],
    expectedEntries: ['speech-to-text', 'speech-to-text-sensevoice', 'api-speech-to-text', 'ui-voice-input'],
    service: { name: 'speechToText', methods: ['snapshot', 'prepare', 'transcribe'], probe: 'snapshot' },
    readinessNote: 'Host 已加载语音服务；首次使用仍需准备本地识别模型并获得麦克风权限。',
  },
  {
    id: '@deepseek-ai/dsh-experimental-auto-review',
    installSpec: '@deepseek-ai/dsh-experimental-auto-review',
    displayName: 'Auto Review',
    description: '在工具调用执行前使用当前模型进行风险审查和授权决策。',
    category: '权限',
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['工具风险审查', 'Auto 权限模式', '拒绝原因展示'],
    expectedEntries: ['auto-review'],
    service: { name: 'permissionPresets', methods: ['current', 'registerAuto', 'set'] },
    readinessNote: 'Host 已加载 Auto Review 权限扩展；实际审查会增加一次模型调用。',
  },
]);

const BY_ID = new Map(DSH_CURATED_PLUGINS.map(item => [item.id, item]));

export function dshCuratedPlugin(id) {
  return BY_ID.get(String(id || '').trim());
}

export function dshCuratedEntries() {
  return DSH_CURATED_PLUGINS.map(item => ({ ...item, capabilities: [...item.capabilities], expectedEntries: [...item.expectedEntries], service: { ...item.service, methods: [...item.service.methods] } }));
}
