/** First-party DSH bundles Studio curates for the plugin market.
 *
 * The market itself is the official plugin index: DSH's `pluginMarket` service
 * reads `format: 1` documents (the bundled community index plus any source the
 * user adds), and the official Discover tab renders them. This module owns only
 * what the official format cannot express — the host-owned readiness probes
 * (`expectedEntries` / `service` / `readinessNote`) and the default enablement
 * of the three first-party bundles Studio verifies end to end.
 *
 * Trust boundary: a probe names a host service, so only rows in this file may
 * declare one. Index documents cannot, and every remote document Studio reads
 * is validated by DSH's own reader before it reaches this module.
 */

/** First-party bundles Studio curates for the DSH plugin market. */
export const DSH_CURATED_PLUGINS = Object.freeze([
  {
    id: '@deepseek-ai/dsh-experimental-agent-team-profile',
    installSpec: '@deepseek-ai/dsh-experimental-agent-team-profile',
    displayName: 'Agent Teams',
    description: '团队委派、成员会话、共享任务板与成员消息。',
    category: '协作',
    tags: ['团队', '委派', '共享任务'],
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
    tags: ['语音', '转写'],
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
    tags: ['权限', '审查'],
    featured: true,
    experimental: true,
    defaultEnabled: false,
    capabilities: ['工具风险审查', 'Auto 权限模式', '拒绝原因展示'],
    expectedEntries: ['auto-review'],
    service: { name: 'permissionPresets', methods: ['current', 'registerAuto', 'set'] },
    readinessNote: 'Host 已加载 Auto Review 权限扩展；实际审查会增加一次模型调用。',
  },
  {
    // The official plugin index: one static `format: 1` document per source
    // replaces Studio's former npm/GitHub aggregation. Closing the bundle
    // removes the service, the Discover tab and the `plugin_market` tool
    // together, which is why the market reports itself unavailable instead of
    // showing an empty shelf.
    id: '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    installSpec: '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    displayName: '自定义插件索引',
    description: '在插件页添加「发现」标签页，从插件索引中浏览和安装插件；Studio 已内置社区索引源。',
    category: '插件',
    tags: ['插件市场', '索引', '发现'],
    featured: true,
    experimental: true,
    defaultEnabled: true,
    capabilities: ['插件索引读取', '模糊搜索与分页', '版本与兼容性', '一键安装'],
    expectedEntries: ['plugin-market', 'ui-plugin-market'],
    service: { name: 'pluginMarket', methods: ['listIndexes', 'search', 'setIndexes'], probe: 'listIndexes' },
    readinessNote: 'Host 已加载官方插件索引服务；索引源属于当前 profile，可在「发现」页管理。',
    // Studio switches this bundle on for every profile on the first Host start
    // of a DSH version (see src/host/default-bundles.mjs).
  },
]);

const BUILTIN_BY_ID = new Map(DSH_CURATED_PLUGINS.map(item => [item.id, item]));

export function dshCuratedPlugin(id) {
  return BUILTIN_BY_ID.get(String(id || '').trim());
}

function cloneEntry(entry) {
  return {
    ...entry,
    ...(Array.isArray(entry.tags) ? { tags: [...entry.tags] } : {}),
    ...(Array.isArray(entry.capabilities) ? { capabilities: [...entry.capabilities] } : {}),
    ...(Array.isArray(entry.expectedEntries) ? { expectedEntries: [...entry.expectedEntries] } : {}),
    ...(entry.service ? { service: { ...entry.service, methods: [...entry.service.methods] } } : {}),
  };
}

export function dshCuratedEntries() {
  return DSH_CURATED_PLUGINS.map(cloneEntry);
}
