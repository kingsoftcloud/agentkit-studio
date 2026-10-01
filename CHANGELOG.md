# 更新日志

## Unreleased

- 本地 Harness 的模型 SSE 现在复用统一解析器，兼容 `\n`、`\r\n` 和分片 UTF-8 帧；上游截断、无效事件、错误帧和 `length/content_filter` 不完整输出会以带错误码的失败事件结束，不再吞掉思考、工具调用或误报成功。
- 本地 Harness 的 MCP 循环现在保留每轮 assistant 文本、reasoning 和 tool call 历史，并按 Agent Revision 的 `execution.maxSteps` 执行（默认 12、上限 100）；达到预算会返回 `LOCAL_EXECUTION_LIMIT`，不会写入记忆或发出 `run.completed`。
- 云端 Agent 编辑页现在通过 Host 代签 `UpdateAgent` Action 保存知识库、记忆库和 Skill Center
  ComponentConfig；云端页面不再调用不存在的旧本地 REST 路由。模型、MCP、本地 Skill 和 Tool 等
  不属于该云端合同的绑定会在保存前明确拒绝，避免出现页面成功但云端未更新。
- 云端 Agent 的 `langgraph`、`hermes`、`openclaw`、`adk` 等服务端运行时现在可以直接绑定到
  DSH 原生会话；Host 不再把它们误判为本地 runtime，也不会要求本地 Tool Registry 物化云端工具，
  实际执行统一交给 AgentEngine `RunAgent` 流。未知的本地 runtime 仍保持明确拒绝。
- 本地 MCP 现在会在每次探测和工具调用前重新解析 DSH credential；凭证轮换会自动替换旧连接，
  不再把过期的连接缓存到 Host 生命周期结束。HTTP 401/403/404、缺少凭证和工具目录失败分别
  返回可操作的错误码，并把最近一次探测错误保存在资源健康状态中，资源库可以直接看到失败原因。
- 云端 Skill Space 下载现在会在读取 `SKILL.md` 前校验服务返回的 `ContentHash` sha256 摘要；
  摘要格式非法或压缩包被替换时返回明确的 `SKILL_ARCHIVE_HASH_INVALID`/
  `SKILL_ARCHIVE_HASH_MISMATCH`，避免错误资源被注入本地 Agent 上下文。
- 云端 Agent 的原生会话在用户停止生成或连接断开时，会先中止本地 `RunAgent` SSE，再由 Host
  发送 `CancelRun`（携带 Agent、Session 和可用的 Invocation 身份）；取消动作失败不会覆盖
  原始 `CLOUD_RUN_CANCELLED` 终态。
- 绑定记忆库的本地 Agent 现在在回答完成后按 `spec.memory.write.mode`（`candidate` 或
  `explicit_only`）把本轮 user/assistant 对话通过 `CreateMemorySdk` 写回云端；写入使用
  session/user/Agent 隔离、限制消息数量和长度，并作为后置副作用记录 trace，写入失败不会吞掉
  已生成的回答。`QueryMemorySdk` 与 `CreateMemorySdk` 都留在 Host 的签名边界内。
- DSH 本地面板现在会在 Connection RPC 可用时直接通过 Studio Host 创建、保存和探测 MCP；即使嵌入页没有注入云端 control-plane 标记，也不会误调用不存在的旧版凭证 REST 合同。MCP 声明与探测到的工具契约由 Host 本地目录持久化，凭证值仍只由 DSH 凭证服务或进程环境持有；环境注入的只读凭证也可以用于本次 MCP 保存和运行。
- 原生 DSH 会话绑定 Studio Agent 时继续保留用户选择的 provider/model 标识；Studio provider 只接管
  实际传输，不再让模型选择器显示内部 `agentkit-studio/*` 路由。通过“在新会话运行”选择的本地
  Build ID 也会跨 scoped Agent request 传到 Harness/Codex 资源物化层，冻结版本不会误读最新 Agent。
- 本地 Harness、Codex 和云端流的 reasoning/text 投影现在支持交替出现的多个内容 block；多轮工具调用
  后不会因为第一段文本已经结束而吞掉后续工具状态、思考或最终回答。插件市场页面同步采用原生 DSH
  的宽松双列目录节奏、图标卡片、搜索框和圆形新增/刷新入口；客户端清单补齐 DSH 原生
  layout/sidebar 依赖，确保这些 Studio 面板在新 Profile 中可见。

- 本地 Build 现在可作为可运行的冻结版本：Build ZIP 会经过目录、大小、CRC 和内容身份校验，
  DSH 原生会话可从构建与部署页选择“在新会话运行”。会话使用该 Build 的 Prompt、模型和资源绑定，
  不再悄悄读取 Agent 后续编辑的最新 Revision；旧 Build 对应的 preset 会保留到 Host 生命周期结束。

- Codex 本地 Agent 现在通过官方 `codex app-server --stdio` 协议运行，不再误用本地
  OpenAI-compatible 网关模型；每个 DSH turn 创建无工作区绑定的临时 Codex Thread，思考与答案
  增量继续投影到 DSH 原生会话。未安装 Codex 时返回 `CODEX_PROVIDER_UNAVAILABLE`，默认不授予
  命令或文件审批。
- Codex Agent 现在会复用本地资源物化层：绑定的 Skill、知识库和记忆库作为 Codex developer
  context 注入，MCP tools 通过 app-server 实验性 `dynamicTools` 注册，并由 Host 响应
  `item/tool/call` 执行绑定 Endpoint；Codex 与 Harness 使用同一套资源凭证边界。工具调用状态
  会投影到 DSH 原生会话的可展开 reasoning 流，避免工具已执行但页面没有过程反馈。
- Harness 本地运行时的 MCP `tool_call` / `tool_result` 也会进入同一条可展开 reasoning 流；云端
  Skill Space 下载改用 Host 注入的网络边界，避免本地资源适配器绕过宿主网络策略。
- 云端 `RunAgent` 的 Responses SSE 工具生命周期也会映射到 DSH 原生 reasoning，云端资源调用不再
  只显示最终文本而隐藏工具过程。
- 云端会话现在沿用浏览器的取消信号关闭 Host 到 `RunAgent` 的上游流；SSE 读取器会释放连接，
  取消会返回独立的 `CLOUD_RUN_CANCELLED`，不会再被误判为截断流或成功完成。
- 本地 Harness 会话也沿用浏览器断开信号中止模型流，并把本地 trace 写成 `canceled` 终态，
  不再在用户停止后继续等待模型超时或伪造 `run.failed`。
- Codex 本地 Agent 现在也写入同一套 trace store：工具调用、思考和回答事件会保留为轻量事件，
  完成、失败和取消分别写入对应的运行终态，观测页不再漏掉 Codex turn。
- Harness 本地 trace 也保留输入、思考、回答和 MCP 工具开始/完成事件；观测页可以看到一次本地
  运行实际经过的资源调用，而不是只有最终运行状态。
- 构建与部署页现在会等待 Host operation 的终态再刷新 Build/部署记录；本地 Build 完成后直接显示
  产物并可从同一页进入原生 DSH 会话，不再因一次即时刷新遗漏异步结果。
- 本地 Harness trace 现在带 Agent 名称，并记录 MCP 工具失败事件；观测页可以区分“运行失败”与
  “哪一个绑定工具失败”。
- Agent 绑定的 DSH Tool 现在会随资源白名单进入会话级 preset；官方 DSH Tool Registry 负责 schema
  投影和执行，Harness/Codex 的本地运行都复用 `ctx.tools.execute()`，不再出现“已绑定但运行时
  静默忽略”的情况。
- 直连 AgentEngine Server 时，Tool 和 Skill 目录现在通过现有 `/api/v1/catalog/resources`
  合同进入 Studio bridge；云端 Skill Space 会与本地导入 Skill 合并展示，Tool 目录缺失时返回
  明确的不可用状态，不再被前端硬编码成不支持。
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
