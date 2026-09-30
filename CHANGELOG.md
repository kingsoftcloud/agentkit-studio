# 更新日志

## Unreleased

- 本地 Build 现在可作为可运行的冻结版本：Build ZIP 会经过目录、大小、CRC 和内容身份校验，
  DSH 原生会话可从构建与部署页选择“在新会话运行”。会话使用该 Build 的 Prompt、模型和资源绑定，
  不再悄悄读取 Agent 后续编辑的最新 Revision；旧 Build 对应的 preset 会保留到 Host 生命周期结束。

- Codex 本地 Agent 现在通过官方 `codex app-server --stdio` 协议运行，不再误用本地
  OpenAI-compatible 网关模型；每个 DSH turn 创建无工作区绑定的临时 Codex Thread，思考与答案
  增量继续投影到 DSH 原生会话。未安装 Codex 时返回 `CODEX_PROVIDER_UNAVAILABLE`，默认不授予
  命令或文件审批。
- MCP 工具发现暂时不可用时保留绑定告警并继续纯文本回合；模型实际发起工具调用后仍严格失败闭环。
- 外部 Streamable HTTP MCP 绑定现在支持 Endpoint、请求头和 `env://` credential reference；
  DSH 原生会话可继续消费本地模型的 reasoning/text 增量。

- 修复云端 Skill Space UUID 被误当作本地 Skill 的兼容迁移；本地运行时现在可通过
  AgentEngine/Skill Service 读取云端 Skill、知识库和记忆库，并通过 `GetMCP` 物化绑定的 MCP。
- 云端 Agent 继续通过 AgentEngine Server `RunAgent` 合同执行，本地 Agent 保留本地 Skill 目录
  适配；两条路径共用 DSH 原生会话页。

## 0.0.1 — 2026-09-30

### 变更

- 云端绑定 Agent 对话改用 AgentEngine Server 现有的 `GetSession`、`CreateSession`、
  `ListSessionEvents` 和 `RunAgent(Stream=true)` Action，不再把本地 `buildId` 当成云端对话
  的前置条件；Host 负责 AWS4/服务令牌签名和 SSE 转发，浏览器不接触云端凭证。
- 对话页启动时恢复 Server 会话事件，流式响应消费 `response.output_text.delta` 和
  `response.completed`，运行中的请求提供 `CancelRun` 停止入口；本地 `ar-local-*` 路径保持
  原有本地运行合同。
- `server-client.mjs` 增加受控的 `streamAction`，仅开放本轮实际使用的会话运行 Action。
  独立 Build、部署停止和通用 Agent 资源绑定仍保持明确的云端合同缺口。

### 验证边界

- `pnpm check`、`git diff --check` 和打包检查覆盖的是本地模拟 Action、Host 签名边界和浏览器
  源码合同；本轮没有带真实租户凭证验证云端 Agent Runtime 的最终输出、断线重连或取消 receipt。

### 资源运行时迭代

- 本地 Agent Runtime 增加 Host-owned Resource Adapter：Skill 以只读 `SKILL.md` 内容注入，
  知识库通过 AICP `RetrieveKnowledge` 检索，MCP 通过官方 TypeScript SDK 的 Streamable HTTP
  transport 发现工具并执行调用；MCP 工具结果会回填模型继续生成，工具名冲突和未绑定工具会
  fail-closed。
- 本地运行完成和失败都会投影到 Studio trace store，观测页可以看到本地运行记录；trace 写入
  失败不会改变已经产生的运行终态。
- 本地 Agent 构建优先读取插件自己的 Agent Store，云端 Agent 才回退到 Server `GetAgent`。
  云端部署仍未伪装成本地部署成功。
- 构建与部署页在直连 AgentEngine Server 时明确展示当前合同边界：Build 和本地运行可用，
  云端 Deployment 控件保持禁用并显示等待合同，不再触发旧版 Studio REST 请求。
- 修正原生会话选择本地 Agent 后仅保存下拉框状态、实际仍运行编码助手的问题：直连模式
  选择 Agent 会打开该 Agent 的独立对话，由本地或云端实际 transport 执行；流请求使用同源
  插件路由。本地 Agent 详情同时加载真实 Build 历史。
- 模型与 Prompt 已满足 DSH preset 合同的本地 `dsh-native` Agent 现在复用 DSH 原生会话页；
  Harness、Codex 以及带 MCP/Skill/知识库绑定的 Revision 也通过 preset-scoped Studio
  `llm/stream` provider bridge 复用同一原生 Session、Loop 和渲染器。桥接不会改写 DSH
  会话记录中的可见模型路由；资源适配失败时返回 typed runtime error。
- Agents 页的“绑定到新会话”直接创建 DSH Session、注册/选择 Agent preset 后导航到官方
  Conversation，不再打开 Studio 自定义 Bound conversation。Workspace 仍由 DSH 原生选择器
  管理，不作为 Agent 绑定条件；已有 Agent Session 未选择 Workspace 时也可直接发送，
  Workspace 只作为 cwd、文件和工作区工具的可选上下文。
- 新增 DSH rc.2 兼容补丁 `008-agent-session-without-workspace.patch`，让原生 composer 只在
  没有 Session 的冷启动页面禁用；绑定 Agent 后不会因为未选择 Workspace 而变成不可发送。
- 插件页采用白底、两列发现列表、大图标与简洁操作，按已安装/发现分组；管理操作集中到
  详情页，移除列表中的多组状态与按钮堆叠。

## 0.0.1 — 2026-09-29

### 新增

- 以官方 DeepSeek Harness `dsh-v0.2.0-rc.1` 为宿主基线，接入 AgentKit Studio 品牌、侧边栏和二级导航。
- Agent 列表支持搜索、状态筛选、页大小、页码、表格滚动和能力计数。
- Agent 创建与编辑页支持运行目标选择；模型、Tool、MCP、Skill 可多选，知识库、记忆库、Skill Center 每类一个。
- 资源库收敛为资源生命周期页：模型、Tool、MCP、Skill、知识库、记忆库和 Skill Center 的发现、导入、探测、查看、刷新、删除和分页列表。
- 模型与云端凭证支持全局 `~/.agentkit` 配置，默认提供商为金山云模型服务，并提供 API Key 控制台入口。
- 插件市场接入 DSH 与 Codex 原生插件的安装、启用、停用、更新和卸载操作。
- 新增 Makefile、中文 README、无凭证 CI，以及 Web 和 macOS Desktop 的官方宿主开发/打包入口。
- 新增 `make dsh-bootstrap`，从公开 GitHub 固定 tag 准备 DSH checkout；发布门禁增加
  版本补丁格式校验，CI 会实际拉取固定 DSH 并运行两个官方 node-store probe。
- 绑定 Agent 对话页的助手消息改用宿主 `@deepseek-ai/dsh-client-ui-primitives` 的
  `MarkdownText` 渲染（Markdown、代码块、脚注），替代纯文本气泡；流式期间走增量渲染。
  该包是 DSH ModuleLoader 的平台 seed 模块，无需扩展 `dsh.client.inject`；seed 不存在的
  环境自动回退纯文本，页面不因宿主缺包而失效。

### 变更

- DSH 宿主基线从 `dsh-v0.1.7-rc.2`（commit `477b4f4…`）升级到 `dsh-v0.2.0-rc.1`（commit
  `4878cdabd87d4041bdaff61d04c966883b9fd07a`）。`Makefile`、`studio.plugin.json`、
  `src/index.mjs`、`src/session-adapter.mjs`、CI、profile/patch/package 门禁脚本和
  `README`/`CONTRIBUTING` 中的版本钉点同步更新；旧 `patches/dsh-v0.1.7-rc.2/` 目录已删除。
- 补丁集迁移到 `patches/dsh-v0.2.0-rc.1/`。`001-chat-thinking-copy.patch` 按新基线重新生成
 （v0.2.0-rc.1 上游将 locale key 从 `message.turnProcess.deepDivingFor` 迁移为
  `chat.deepDiving`/`chat.deepDivingFor`，补丁已跟随）；其余 5 个补丁原样适用，全部通过
  `git apply --check`。6 个补丁的作用与删除条件不变。
- 云端控制面链路对齐旧版 KsADK Studio：`server-client.mjs` 的 AWS4 签名把 `pre-online`
  逻辑环境归一化为真实签名 region（`cn-beijing-6`，与旧版 `_normalize_control_region`
  一致），内网专属账号的回退端点改为 `http://aicp.inner.api.ksyun.com`（旧版
  `_INNER_AICP_BASE_URL` 语义，HTTPS 在内网域名上证书不匹配）。
- 资源库的 MCP、Skill、知识库、记忆库目录直接读取云端 Server Action；模型目录经
  `model-service` 的 OpenAI 兼容 `/models` 自动发现（与旧版 Studio 同款机制，空 profile
  回退默认 profile）。Tool 目录在本迭代从资源库移除（云端无对应 Action）。
- 新增补丁 `007-sidebar-session-filter.patch`：
  007 在 `ui-workspace/tree.ts` 暴露 `registerSessionFilter` 注册点，插件在 Agent 选择器
  选中 Agent 后按"会话 → Agent 绑定"过滤 DSH 侧栏会话列表，清除选择恢复全部；
  008 修复旧日志空 stream run 记录（缺 `args`/`texts`）导致的会话投影崩溃——该 bug 使
  rc.2 时代会话在升级后无法恢复、新建会话失败、侧栏会话全部消失。
- 本地 Skill 发现迁移到插件 Node 侧（`src/skill-discovery.mjs`）：扫描 `~/skills`、
  `~/.agents/skills`、`~/.codex/skills`、`~/.claude/skills` 中的 `SKILL.md` 清单，提供
  候选预览、脚本/网络风险标记、导入到 `~/.agentkit/studio/skills` 与已导入目录读取，
  合同与旧版 Studio Host 一致，经 `/agentkit` 桥的 `skills/*` 端点服务。
- DSH 宿主升级到 `dsh-v0.2.0-rc.2`（commit `639ed01539`）：7 个补丁全部重验（仅 001 思考态
  文案按新基线重新生成，rc.2 的 `chat.deepDivingFor` 尾缀变为 `···`），版本钉点、CI、
  门禁脚本同步更新，补丁目录更名为 `patches/dsh-v0.2.0-rc.2/`。全量 lib/web 重建。
- 按用户决策不做 rc.2 旧本地会话数据兼容：已清除 `~/.dsh/sessions/` 与
  session_projcache 的旧会话日志，浏览器端 Studio 站点的 localStorage 一并重置后即为
  全新状态（曾临时生成的 008 兼容补丁已撤回）。
- 运行中心的本地能力开始迁入插件 Node 侧（对齐旧版 Studio Host 实现）：
  异步 operation 框架（幂等键去重、JSON 持久化、宿主重启中断恢复）与本地 Agent Build
  （内容寻址 `build_<digest>`、`agent-bundle.zip` 打包、`~/.agentkit/studio/dist` 存储）。
  构建与部署页恢复可用：提交构建、Build 历史、部署选择器读取本地 Build；部署上云仍待
  AgentEngine Server 合同（`builds/create`、`operations/*` 桥端点）。
- 本地 Agent 真实执行：新增 `local-runtime.mjs`（网关 chat-completions 流适配 +
  canonical 事件信封）与同源 SSE 路由 `/agentkit/local-conversation`，对话页对
  `ar-local-` 前缀 Agent 直接走本地运行（模型+Prompt，资源绑定仍 fail-closed）。
  注意宿主 IncomingMessage 的 abort signal 在 body 读取后即失效，不得传递给上游
  模型请求（改用超时保护）。
- 观测页接入云端统计：`GetObservabilityOverview`（epoch 毫秒时间）与
  `ListAgentRuntimeStats` 与本地 trace store 合并展示。
- 对话创建 Agent 的工具改为进程内数据源（注入 remote 工厂）：资源查询走模型网关目录
  与云端资源 Action，创建的 Agent 写入本地 Agent 存储（`~/.agentkit/studio/agents/`），
  Agents 列表合并本地与云端行。不再调用已下线的 8789 本地 Host REST。云端快速创建合同
  未开放前，本地 Agent 可被列出与构建（本地 bundle）。
- 运行中心四个域迁入插件 Node 侧（对齐旧版 Studio Host，纯本地实现）：
  - **自动化**：`studio-scheduler.mjs`（SQLite 存储 schedules/occurrences、进程内 cron 引擎
    30 秒 tick、once/interval/cron 三种 kind、misfire 策略、幂等 task_id）。桥端点
    `schedules/*`。NL assistant 留后续（需模型端点）。
  - **观测**：`studio-observability.mjs`（RunEvent→OTLP JSON 投影写 `~/.agentkit/studio/traces/`、
    overview 分桶统计、list/get/getOtlp 读模型）。桥端点 `traces/*`。
  - **评测**：`studio-evaluation.mjs`（evalset 解析 native/studio_suite、断言评估 13 种 type、
    本地 run 存储 `~/.agentkit/studio/evaluations/`、runner 注入式执行器）。桥端点
    `evaluations/*`。无 runner 时诚实记录为 failed。
  - **Channels**：`studio-channels.mjs`（连接配置本地存储 + 渠道服务 API proxy）。桥端点
    `channels/*`。WebSocket 长连接器留后续。
- directServer 模式下 `request()`/`streamRequest()` 对没有云端合同的旧本地 Host REST
  路径直接返回 typed `CLOUD_CONTRACT_UNAVAILABLE`（含路径），不再尝试注定失败的本地
  请求；Skill 与 Skill Center 目录分别对应本地导入目录与云端 `ListSkillWorkspaces`。
- 绑定 Agent 对话的 conversation-surface 在 directServer 模式下经 `/agentkit` 桥解析；云端
  Build 合同未开放时返回 typed `BUILD_NOT_READY`。交付/长任务写路径同样返回
  typed 合同缺失错误。

- 插件市场切换到 DSH 0.2.0-rc.2 原生插件管理：`studio-plugins.mjs` 直调宿主进程内的
  `PluginManager`/`PluginInventoryGateway` 服务（listBundles/listPlugins/inspect/
  installBundle/removeBundle/setBundleEnabled/setPluginEnabled），替代 profile 文件
  读取与 `dsh plugin` CLI 转发；市场列表为产品 bundle（安装/内置/启用/停用），
  Loader 的 ~200 个内部插件行归 DSH 设置页插件管理。Codex 生态接 `codex plugin`
  CLI 的结构化 JSON 清单（0.159.0，installed/enabled/marketplace）与 add/remove。
### 修正

- 删除资源目录中的”保存到 Agent Revision”操作；绑定关系只在 Agent 创建或编辑时提交。
- 修正资源列表分页、页大小、表格滚动和暗色主题下的表面颜色继承。
- 修正 Agent 卡片的模型、MCP、Skill、Tool、知识库、记忆库和 Skill Center 计数。
- 明确未选择 Agent 的对话继续走 DSH 原生会话，避免把候选 Agent 选择误显示为已经切换执行器。
- 将 DSH 宿主兼容补丁按 `patches/dsh-v<version>/` 隔离，补充基线校验、应用顺序和删除条件。
- 将远端默认分支统一为 `master`，删除重复的 `main` 分支；维护中的 `src/` 和 `scripts/`
  JavaScript 源文件统一纳入 1000 行门禁。

### 已知限制

- 桌面 Electron 壳是可选宿主；本插件不打包 Python/KsADK。官方裸 DSH Desktop 需要在发布 profile 中加入本插件后才会显示 AgentKit Studio 品牌。
- Codex 运行时需要 profile 已安装并启用 `@deepseek-ai/dsh-subagent-codex`，改动后必须重启 DSH profile。
- DSH Native 带资源的 Revision 在公开 adapter/provider 合同落地前保持 fail-closed；资源列表或卡片数量不能证明运行时已加载资源。
- AgentEngine Server 的绑定执行、云端部署、Codex 持续 thread 和端云协同仍须通过对应真实 Host/Server 合同验收。
