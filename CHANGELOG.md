# 更新日志

## 0.0.1（待首次发布）

AgentKit Studio 首个版本，基于 DSH 原生 Web / macOS 界面，支持 DSH Native、Codex 和 AgentKit Harness。

### 主要功能

- **Agent 管理与对话**：本地 Agent 分页展示并按创建时间排序，原生选择菜单支持搜索；支持表单及对话创建、版本记录、绑定模型和资源。三种本地运行时共用原生会话、流式输出、思考与工具卡片，支持无工作区会话，取消目录保留 Agent、模型与草稿。
- **模型配置**：管理多个提供商及默认模型，Agent 与会话保留独立选择；Codex 支持原生模型、Responses 兼容网关及内置 Chat Completions 协议代理。
- **资源与插件**：管理 MCP、本地 Skill、云端 Skill Space、知识库和记忆库，支持资源探测与运行时物化；接入 DSH 插件管理和 Codex 官方插件目录、安装、卸载及连接器授权状态。
- **构建与本地交付**：按 Agent Revision 冻结构建，提供构建历史、产物下载、本地运行及可迁移运行包，目标环境单独注入凭证。
- **运行中心**：提供自动化调度、评测集与执行记录、本地 Trace 和云端统计；Codex 上报 token 用量，Chat 代理记录请求大小及工具定义开销。
- **渠道接入**：通过 Gateway 将渠道消息路由到本地 Agent，保留模型、资源与会话历史，支持连接状态、重连和停用。
- **macOS 应用**：统一 AgentKit Studio 名称与图标，提供内置 Node、固定版本官方 Codex CLI 和 Studio 插件的本地 DMG；侧栏直接进入设置。

### 当前限制

- Agent 目录只接纳新版 Studio 创建的 DSH Native、Codex 和 Harness；历史云端 Agent 不在本产品兼容范围。本地构建的云端发布尚未接入，云端列表等待真实部署记录，预发资源绑定仍需联调。
- Codex 插件按 Agent 隔离及工具按需加载尚未完成；连接器另需服务授权，持续原生 Thread 恢复与完整官方插件能力未全部验收。
- 当前 macOS DMG 为未签名的本地验收包，正式签名与公证尚未完成。离线安装和启动不代表云模型或联网资源可离线使用。

详细协议、验收证据和限制见 [项目说明](README.md) 与 [DSH Native 架构](docs/studio-dsh-native-architecture.md)；开发迭代历史保留在 Git 中。
