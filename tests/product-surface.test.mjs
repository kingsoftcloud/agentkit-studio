import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const fragmentDir = resolve(import.meta.dirname, '../src/client-fragments');
const clientSource = (await Promise.all((await readdir(fragmentDir)).filter(name => name.endsWith('.js')).sort().map(name => readFile(resolve(fragmentDir, name), 'utf8')))).join('\n');

test('Studio mounts the official plugin navigation provider required by optional DSH UI bundles', async () => {
  const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8');
  assert.ok(packageJson.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-plugin-manager'));
  assert.doesNotMatch(patch, /- id: ui-plugin-manager\s*\n\s*disabled: true/);
});

test('Studio conversation surface does not ship the legacy DSH hero copy', () => {
  assert.doesNotMatch(clientSource, /探索未至之境|预览版/);
});

test('Agent context selector uses the DSH Connection catalog and official session admission seam', () => {
  assert.match(clientSource, /connection\.rpc\.call\('\/agentkit', 'agents\/list'/);
  assert.match(clientSource, /不使用 Agent/);
  assert.match(clientSource, /connection\.rpc\.call\('\/agentkit', 'agents\/ensure-preset'/);
  assert.match(clientSource, /agentPresets\.select\(sessionId, admission\.presetId\)/);
  assert.match(clientSource, /typeof selectedPreset === 'object' && selectedPreset\.ok === false/);
  assert.match(clientSource, /conversation\.hero\.agentPreset/);
  assert.match(clientSource, /会话已开始，Agent 已锁定/);
  assert.match(clientSource, /__AGENTKIT_STUDIO_BIND_AGENT__/);
  assert.match(clientSource, /绑定到新会话/);
  assert.match(clientSource, /uiWorkspace\.openSession\(sessionId\)/);
  assert.match(clientSource, /h\(Menu, /);
  assert.match(clientSource, /conversationAgentStorageKey\(sessionId\)/);
});

test('Agent authoring reuses the native composer and starts a fresh session from Agents', () => {
  // Keep authoring in the native conversation, with entries in the fresh
  // conversation hero and the Agents page rather than a second composer.
  assert.doesNotMatch(clientSource, /conversation\.input\.left/);
  assert.match(clientSource, /function NativeAuthoringButton/);
  assert.match(clientSource, /openAgentAuthoring/);
  assert.match(clientSource, /持续更新草稿/);
  assert.match(clientSource, /我明确确认草稿后再创建/);
  assert.match(clientSource, /agentkit-studio:seed-authoring/);
  assert.doesNotMatch(clientSource, /function ConversationalAgentCreatePage/);
});

test('model settings keep multiple providers and profiles independently configurable', () => {
  assert.match(clientSource, /modelProfiles/);
  assert.match(clientSource, /添加提供商或模型/);
  assert.match(clientSource, /modelProfileKeys/);
  assert.match(clientSource, /ksp\.console\.ksyun\.com\/#\/apiKey/);
  assert.match(clientSource, /applyProfiles/);
  assert.match(clientSource, /input: profile\.input \|\| \[\'text\'\]/);
});

test('bound Agents use the official DSH native conversation surface', () => {
  assert.doesNotMatch(clientSource, /function BoundAgentConversationPage/);
  assert.doesNotMatch(clientSource, /onOpenConversation/);
  assert.match(clientSource, /__AGENTKIT_STUDIO_BIND_AGENT__/);
  assert.match(clientSource, /sessions\.create\(\{\}\)/);
  assert.match(clientSource, /agentPresets\?\.select\?\./);
  assert.match(clientSource, /uiWorkspace\.openSession\(sessionId\)/);
});

test('resource catalogs route cloud-backed kinds through Server Actions and fail typed on contract gaps', () => {
  assert.match(clientSource, /const bridgeAvailable = \(\) => Boolean\(connection\?\.rpc\?\.call\)/);
  assert.match(clientSource, /mcp: 'ListMCPs'/);
  assert.match(clientSource, /'knowledge-base': 'ListKnowledgeBases'/);
  assert.match(clientSource, /'memory-instance': 'ListMemoryInstances'/);
  // The model catalog auto-discovers through the model gateway's
  // OpenAI-compatible /models endpoint via the Node-side model service —
  // the same discovery the legacy Studio used.
  assert.match(clientSource, /modelCatalog: profileId => studioCall\('models\/catalog'/);
  assert.match(clientSource, /value\.kind === 'model'[\s\S]*?studioBridgeOperation\('resources\/list', value\)/);
  // Tool and Skill catalogs are now routed through the authenticated Studio
  // bridge, which can merge the local workspace catalog with cloud Skill
  // Spaces instead of rejecting them as an unsupported cloud surface.
  assert.match(clientSource, /value\.kind === 'tool' \|\| value\.kind === 'skill'/);
  assert.match(clientSource, /studioBridgeOperation\('resources\/list', value\)/);
  assert.match(clientSource, /resources\/list/);
  assert.match(clientSource, /value\.kind === 'mcp' && bridgeAvailable\(\)/);
  assert.match(clientSource, /localMcpId = resourceId => String\(resourceId \|\| ''\)\.startsWith\('mcp-local-'\)/);
  assert.doesNotMatch(clientSource, /cloudUnsupported\('Tool 目录'\)/);
});

test('direct REST surface fails typed instead of probing the absent local Studio Host', () => {
  assert.match(clientSource, /if \(directServer\(\) && path !== '\/api\/v1\/system\/session'\)/);
  assert.match(clientSource, /if \(directServer\(\) && !path\.startsWith\('\/agentkit\/'\)\)/);
  assert.doesNotMatch(clientSource, /deployments: \(\) => request\('\/api\/v1\/deployments'\)/);
});

test('Delivery surface uses a Host-owned deployment preflight and explicit billable confirmation', () => {
  assert.match(clientSource, /const directServerMode = Boolean\(window\.__AGENTKIT_STUDIO__\?\.controlPlane === 'agentengine-server'\)/);
  assert.match(clientSource, /CloudDeploymentPanel/);
  assert.match(clientSource, /deployments\/prepare/);
  assert.match(clientSource, /确认创建云端实例/);
  assert.match(clientSource, /previewId: preview\.previewId/);
});

test('resource-bound Agents use the same native DSH preset bridge as model-only Agents', () => {
  const selector = clientSource.slice(clientSource.indexOf('function AgentContextSelector'), clientSource.indexOf('function StudioSubnav'));
  assert.match(selector, /resourceBound\(selectedRecord\)/);
  assert.match(selector, /已绑定原生会话适配器/);
});

test('platform resource picker does not refetch on every render', () => {
  const picker = clientSource.slice(clientSource.indexOf('function PlatformResourcePicker'), clientSource.indexOf('function AgentCreatePage'));
  assert.match(picker, /agentkit-studio:local-agent-changed/);
  assert.doesNotMatch(picker, /window\.removeEventListener\('agentkit-studio:local-agent-changed', changed\);\s*\}, \[load\]\)/);
});

test('native bridge intercepts the DSH stream without rewriting the visible model route', async () => {
  const pluginSource = await readFile(resolve(import.meta.dirname, '../src/providers/dsh-runtime-plugin.mjs'), 'utf8');
  const hostSource = await readFile(resolve(import.meta.dirname, '../src/index.mjs'), 'utf8');
  assert.match(hostSource, /ctx\.on\('llm\/stream', routeDshRuntime\)/);
  assert.doesNotMatch(pluginSource, /ctx\.on\('llm\/stream'/);
  assert.doesNotMatch(pluginSource, /provider:\s*'agentkit-studio'/);
  assert.doesNotMatch(pluginSource, /agent\/request/);
});

test('model-only local Agent admission can use the native DSH session UI', async () => {
  const hostSource = await readFile(resolve(import.meta.dirname, '../src/index.mjs'), 'utf8');
  const admissionSource = await readFile(resolve(import.meta.dirname, '../src/agent-preset-admission.mjs'), 'utf8');
  assert.match(clientSource, /studioRemote\.agentPresets\.select\(sessionId, admission\.presetId\)/);
  assert.match(hostSource, /localStore\.get\(agentId\)/);
  assert.match(hostSource, /presetAdmission\.ensure\(agentId, \{ agent: local \}\)/);
  assert.match(admissionSource, /suppliedAgent \|\| await this\.getAgent/);
  assert.match(admissionSource, /mode: bridge \? 'studio-bridge' : 'dsh-native'/);
});

test('cloud Agent execution remains available through the control-plane bridge', async () => {
  const hostSource = await readFile(resolve(import.meta.dirname, '../src/index.mjs'), 'utf8');
  assert.match(hostSource, /CreateSession/);
  assert.match(hostSource, /RunAgent/);
  assert.match(hostSource, /createDshRuntimeAdapter/);
  assert.match(hostSource, /streamAction\('RunAgent'/);
});

test('directServer Agent authoring persists through the Host bridge', async () => {
  const hostSource = await readFile(resolve(import.meta.dirname, '../src/index.mjs'), 'utf8');
  assert.match(clientSource, /studioBridgeOperation\('agents\/create-local', payload\)/);
  assert.match(clientSource, /studioBridgeOperation\('agents\/update-cloud'/);
  assert.match(clientSource, /cloudEditing/);
  assert.match(hostSource, /'agents\/create-local'/);
  assert.match(hostSource, /'agents\/update-cloud'/);
  assert.match(hostSource, /if \(endpoint === 'agents\/create-local'\)/);
  assert.match(hostSource, /if \(endpoint === 'agents\/update-cloud'\)/);
  assert.match(hostSource, /buildCloudAgentUpdate/);
  assert.match(hostSource, /store\.create\(\{/);
});

test('Studio domains use the DSH left panel list and old Studio underline tabs', () => {
  assert.match(clientSource, /ctx\.slots\.register\(\s*\{ name: 'main', key: panel\.id \}/s);
  assert.match(clientSource, /ctx\.slots\.register\(\s*\{ name: 'sidebar\.panellist', id: panel\.id/s);
  assert.match(clientSource, /borderBottom: '2px solid ' \+ \(value === item\.id/s);
  assert.match(clientSource, /function StudioPageTabs/);
});

test('Studio automation surface keeps Host-backed task management affordances', () => {
  assert.match(clientSource, /hostRemote\.schedules\(undefined, scope\)/);
  assert.match(clientSource, /hostRemote\.createSchedule/);
  assert.match(clientSource, /hostRemote\.scheduleOccurrences/);
  assert.match(clientSource, /每日简报/);
  assert.match(clientSource, /列表视图/);
  assert.match(clientSource, /执行中/);
  assert.match(clientSource, /需关注/);
  assert.match(clientSource, /Automation detail/);
  assert.match(clientSource, /taskPageSize/);
  assert.match(clientSource, /studioBridgeOperation\('schedules\/run', \{ taskId, agentId \}\)/);
});

test('Studio automation surface does not hide DSH session schedules', () => {
  assert.match(clientSource, /remote\.schedule/);
  assert.match(clientSource, /scheduleRemote\?\.catalog/);
  assert.match(clientSource, /DSH 原生会话自动化/);
  assert.match(clientSource, /与 Host Agent 自动化分开存储/);
  assert.match(clientSource, /当前会话还没有 DSH 原生自动化/);
  assert.match(clientSource, /schedule_create/);
});

test('operations pages expose the old Studio operational workflows', () => {
  assert.match(clientSource, /function EvaluationPage/);
  assert.match(clientSource, /hostRemote\.evaluationTargets/);
  assert.match(clientSource, /hostRemote\.evaluationRun/);
  assert.match(clientSource, /开始评测/);
  assert.match(clientSource, /function ObservabilityPage/);
  assert.match(clientSource, /hostRemote\.tracesOverview/);
  assert.match(clientSource, /原始 OTLP/);
  assert.match(clientSource, /function ChannelsPage/);
  assert.match(clientSource, /ListPairingRequests/);
  assert.match(clientSource, /ApprovePairing/);
  assert.match(clientSource, /ListBindings/);
  assert.match(clientSource, /新增渠道/);
  assert.match(clientSource, /解除绑定/);
  assert.match(clientSource, /UpdateBinding/);
  assert.match(clientSource, /Takeover/);
  assert.match(clientSource, /ReleaseTakeover/);
  assert.match(clientSource, /会话列表/);
  assert.match(clientSource, /visiblePairings/);
  assert.match(clientSource, /visibleBindings/);
  assert.match(clientSource, /visibleConversations/);
  assert.match(clientSource, /evalsetPage/);
  assert.match(clientSource, /targetPage/);
  assert.match(clientSource, /reference_match@v1/);
  assert.match(clientSource, /失败时停止/);
  assert.match(clientSource, /timeoutSeconds/);
  assert.match(clientSource, /hostRemote\.agents\(\)/);
  assert.match(clientSource, /按 Agent 筛选/);
  assert.match(clientSource, /GetConnectQr/);
  assert.match(clientSource, /扫码连接/);
  assert.match(clientSource, /attributes/);
  assert.match(clientSource, /resource/);
  assert.match(clientSource, /function OperationalPager/);
});

test('Delivery waits for local build and deployment operations before refreshing state', () => {
  assert.match(clientSource, /const waitForOperation = async operationId/);
  assert.match(clientSource, /await waitForOperation\(result\?\.operationId\)/);
  assert.match(clientSource, /operation\?\.result\?\.buildId/);
});

test('operational pages keep the old Studio hierarchy without stacked duplicate headers', () => {
  assert.match(clientSource, /function OperationalPageHeading/);
  assert.match(clientSource, /function OperationalPanel/);
  assert.match(clientSource, /function OperationalBars/);
  assert.match(clientSource, /运行趋势/);
  assert.match(clientSource, /DSH 原生会话自动化 \$\{nativeTasks.length\} · 展开查看/);
  assert.match(clientSource, /连接配置 · 点击设置/);
  assert.match(clientSource, /配对请求 \$\{pairings.length\}/);
  assert.match(clientSource, /会话绑定 \$\{bindings.length\}/);
  assert.match(clientSource, /消息记录 \$\{messages.length\}/);
});

test('Studio preserves Host plugin bridge routes and the Codex lifecycle adapter', () => {
  assert.match(clientSource, /dshPlugins: \(\) => bridgeAvailable\(\) \? studioBridgeOperation\('plugins\/dsh-list'/);
  assert.match(clientSource, /codexPlugins: \(\) => bridgeAvailable\(\) \? studioBridgeOperation\('plugins\/codex-list'/);
  assert.match(clientSource, /installDshPlugin: /);
  assert.match(clientSource, /enableDshPlugin: /);
  assert.match(clientSource, /disableDshPlugin: /);
  assert.match(clientSource, /updateDshPlugin: /);
  assert.match(clientSource, /uninstallDshPlugin: /);
  assert.match(clientSource, /hostRemote\.installCodexPlugin/);
  assert.match(clientSource, /hostRemote\.uninstallCodexPlugin/);
  assert.match(clientSource, /data-codex-plugin-center/);
  assert.match(clientSource, /section\('已安装'/);
  assert.match(clientSource, /section\('插件目录'/);
});

test('the official DSH plugin center is the only visible market and carries Codex as an official item', () => {
  assert.match(clientSource, /ctx\.slots\.inject\('plugins\.item'/);
  assert.match(clientSource, /agentkit-codex-plugin-market/);
  assert.match(clientSource, /function CodexPluginMarketItem/);
  assert.match(clientSource, /打开插件中心/);
  assert.doesNotMatch(clientSource, /id: 'marketplace', label: '插件市场'/);
});

test('resource surface exposes real MCP and Skill lifecycle actions', () => {
  assert.match(clientSource, /资源库只负责资源目录生命周期/);
  assert.match(clientSource, /Agent 创建页或编辑页完成/);
  assert.doesNotMatch(clientSource, /保存到 Agent Revision/);
  assert.match(clientSource, /hostRemote\.createModelResource/);
  assert.match(clientSource, /hostRemote\.createToolResource/);
  assert.match(clientSource, /hostRemote\.deleteResource/);
  assert.match(clientSource, /hostRemote\.createMcpResource/);
  assert.match(clientSource, /hostRemote\.updateMcpResource/);
  assert.match(clientSource, /hostRemote\.probeMcpResource/);
  assert.match(clientSource, /编辑凭证/);
  assert.match(clientSource, /hostRemote\.discoverSkills/);
  assert.match(clientSource, /hostRemote\.commitDiscoveredSkill/);
  assert.match(clientSource, /hostRemote\.previewInstalledSkill/);
  assert.match(clientSource, /扫描本地 Skill/);
  assert.match(clientSource, /查看文件/);
  assert.match(clientSource, /查看工具/);
  assert.match(clientSource, /发现本地 Skill/);
  assert.match(clientSource, /Skill 文件树/);
  assert.match(clientSource, /McpToolsDialog/);
});

test('global Agent and runtime lists expose bounded pagination and Codex provider state', () => {
  assert.match(clientSource, /hostRemote\.agents\(\{ page, pageSize, query, source: tab === 'cloud' \? 'cloud' : 'local' \}\)/);
  assert.doesNotMatch(clientSource, /const hydratedAgents = await Promise\.all\(listedAgents\.map/);
  assert.match(clientSource, /maxHeight: 'min\(64vh, 680px\)'/);
  assert.match(clientSource, /Provider 未注册/);
  assert.match(clientSource, /@deepseek-ai\/dsh-subagent-codex/);
  assert.match(clientSource, /data-studio-pager/);
  assert.match(clientSource, /installResponsiveStyles/);
});

test('host-facing settings use product-neutral Studio Host wording', () => {
  assert.match(clientSource, /label: 'Studio Host'/);
  assert.doesNotMatch(clientSource, /label: 'KsADK Host'/);
});

test('Studio owns the browser favicon and uses line icons for product panels', () => {
  assert.match(clientSource, /adoptProductDocumentBrand/);
  assert.match(clientSource, /agentkit-studio: document favicon/);
  assert.match(clientSource, /const STUDIO_MARK_COLOR = '#0aa6a6'/);
  assert.match(clientSource, /fill: STUDIO_MARK_COLOR/);
  assert.match(clientSource, /stroke: STUDIO_MARK_COLOR/);
  assert.match(clientSource, /studio-overview/);
  assert.match(clientSource, /studio-resources/);
  assert.match(clientSource, /const knowledgeBaseCount = platformCount/);
  assert.match(clientSource, /`记忆库 \$\{memoryCount\}`/);
  assert.match(clientSource, /`Skill Center \$\{skillSpaceCount\}`/);
});
