import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const clientSource = readFileSync(resolve(import.meta.dirname, '../src/client.js'), 'utf8');

test('Studio conversation surface does not ship the legacy DSH hero copy', () => {
  assert.doesNotMatch(clientSource, /探索未至之境|预览版/);
});

test('Agent context selector uses the DSH Connection catalog seam and stays honest about execution', () => {
  assert.match(clientSource, /connection\.rpc\.call\('\/agentkit', 'agents\/list'/);
  assert.match(clientSource, /无 Agent · DSH 原生会话/);
  assert.match(clientSource, /未绑定当前会话/);
  assert.match(clientSource, /这里只记录候选智能体，不改变当前会话/);
  assert.match(clientSource, /agentkit-studio:open-bound-conversation/);
  assert.match(clientSource, /打开绑定对话/);
});

test('bound Agent conversations use the Host canonical stream entry', () => {
  assert.match(clientSource, /function BoundAgentConversationPage/);
  assert.match(clientSource, /onOpenConversation/);
  assert.match(clientSource, /打开绑定对话/);
  assert.match(clientSource, /hostRemote\.streamAgentConversation\(agentId/);
  assert.match(clientSource, /conversation\.ksadk\.io\/v1/);
  assert.match(clientSource, /Idempotency-Key/);
  assert.match(clientSource, /run\.completed/);
});

test('Studio domains use the DSH left panel list and old Studio underline tabs', () => {
  assert.match(clientSource, /ctx\.slots\.register\(\s*\{ name: 'main', key: panel\.id \}/s);
  assert.match(clientSource, /ctx\.slots\.register\(\s*\{ name: 'sidebar\.panellist', id: panel\.id/s);
  assert.match(clientSource, /borderBottom: '2px solid ' \+ \(value === item\.id/s);
  assert.match(clientSource, /function StudioPageTabs/);
});

test('Studio automation surface keeps Host-backed task management affordances', () => {
  assert.match(clientSource, /hostRemote\.schedules\(\)/);
  assert.match(clientSource, /hostRemote\.createSchedule/);
  assert.match(clientSource, /hostRemote\.scheduleOccurrences/);
  assert.match(clientSource, /每日简报/);
  assert.match(clientSource, /列表视图/);
});

test('Studio automation surface does not hide DSH session schedules', () => {
  assert.match(clientSource, /remote\.schedule/);
  assert.match(clientSource, /scheduleRemote\?\.catalog/);
  assert.match(clientSource, /DSH 原生会话自动化/);
  assert.match(clientSource, /与 Host Agent 自动化分开存储/);
  assert.match(clientSource, /当前会话还没有 DSH 原生自动化/);
  assert.match(clientSource, /schedule_create/);
});

test('Studio marketplace exposes the old Studio plugin lifecycle through Host routes', () => {
  assert.match(clientSource, /hostRemote\.installDshPlugin/);
  assert.match(clientSource, /hostRemote\.enableDshPlugin/);
  assert.match(clientSource, /hostRemote\.disableDshPlugin/);
  assert.match(clientSource, /hostRemote\.updateDshPlugin/);
  assert.match(clientSource, /hostRemote\.uninstallDshPlugin/);
  assert.match(clientSource, /hostRemote\.installCodexPlugin/);
  assert.match(clientSource, /hostRemote\.uninstallCodexPlugin/);
  assert.match(clientSource, /变更会调用对应 Host/);
});

test('resource surface exposes real MCP and Skill lifecycle actions', () => {
  assert.match(clientSource, /资源库只负责资源目录生命周期/);
  assert.match(clientSource, /Agent 创建页或编辑页完成/);
  assert.doesNotMatch(clientSource, /保存到 Agent Revision/);
  assert.match(clientSource, /hostRemote\.createModelResource/);
  assert.match(clientSource, /hostRemote\.createToolResource/);
  assert.match(clientSource, /hostRemote\.deleteResource/);
  assert.match(clientSource, /hostRemote\.createMcpResource/);
  assert.match(clientSource, /hostRemote\.probeMcpResource/);
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
  assert.match(clientSource, /hostRemote\.agents\(\{ page, pageSize, query \}\)/);
  assert.match(clientSource, /maxHeight: 'min\(64vh, 680px\)'/);
  assert.match(clientSource, /Provider 未注册/);
  assert.match(clientSource, /@deepseek-ai\/dsh-subagent-codex/);
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
