# 更新日志

## 0.0.1 — 2026-09-27

### 新增

- 以官方 DeepSeek Harness `dsh-v0.1.7-rc.2` 为宿主基线，接入 AgentKit Studio 品牌、侧边栏和二级导航。
- Agent 列表支持搜索、状态筛选、页大小、页码、表格滚动和能力计数。
- Agent 创建与编辑页支持运行目标选择；模型、Tool、MCP、Skill 可多选，知识库、记忆库、Skill Center 每类一个。
- 资源库收敛为资源生命周期页：模型、Tool、MCP、Skill、知识库、记忆库和 Skill Center 的发现、导入、探测、查看、刷新、删除和分页列表。
- 模型与云端凭证支持全局 `~/.agentkit` 配置，默认提供商为金山云模型服务，并提供 API Key 控制台入口。
- 插件市场接入 DSH 与 Codex 原生插件的安装、启用、停用、更新和卸载操作。
- 新增 Makefile、中文 README、无凭证 CI，以及 Web 和 macOS Desktop 的官方宿主开发/打包入口。

### 修正

- 删除资源目录中的“保存到 Agent Revision”操作；绑定关系只在 Agent 创建或编辑时提交。
- 修正资源列表分页、页大小、表格滚动和暗色主题下的表面颜色继承。
- 修正 Agent 卡片的模型、MCP、Skill、Tool、知识库、记忆库和 Skill Center 计数。
- 明确未选择 Agent 的对话继续走 DSH 原生会话，避免把候选 Agent 选择误显示为已经切换执行器。
- 将 DSH 宿主兼容补丁按 `patches/dsh-v<version>/` 隔离，补充基线校验、应用顺序和删除条件。

### 已知限制

- 桌面 Electron 壳是可选宿主；本插件不打包 Python/KsADK。官方裸 DSH Desktop 需要在发布 profile 中加入本插件后才会显示 AgentKit Studio 品牌。
- Codex 运行时需要 profile 已安装并启用 `@deepseek-ai/dsh-subagent-codex`，改动后必须重启 DSH profile。
- DSH Native 带资源的 Revision 在公开 adapter/provider 合同落地前保持 fail-closed；资源列表或卡片数量不能证明运行时已加载资源。
- AgentEngine Server 的绑定执行、云端部署、Codex 持续 thread 和端云协同仍须通过对应真实 Host/Server 合同验收。
