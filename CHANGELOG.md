# 更新日志

## Unreleased

- Codex 插件安装校验结构化结果，展示官方连接器可调用状态和授权入口；原生插件 MCP 进度进入 Studio 事件流，补充真实模型与独立插件执行验收。

- 修复运行资源页请求已停用的通用 REST 目录而整页报错；改为 Host 汇总真实模型、MCP、Skill、知识库和记忆库目录，分项报告读取失败与截断，不再显示虚假的工作区和部署就绪统计。
- Codex 插件市场优先复用官方 App Server 的名称、说明、图标与精选目录；CLI 回退补齐 --available 并提高有界输出大小，修复只能看到已安装插件的问题。首屏按需展示并可搜索全目录，保留账户安装限制。
- Codex 模型与插件目录共用短连接 RPC；插件仍由固定官方 CLI 安装和卸载，连接器授权与完整官方桌面能力不因安装包存在而自动获得。

- 资源库将 Skill 的 ready / available 显示为“本地已导入 / 云端目录可见”，明确目录状态与实际执行验收的区别；MCP 区分已配置、探测通过和云端运行状态。
- 云端 MCP 接入已有 DeleteMCP，确认弹窗区分删除云端运行资源和移除本地配置；缺失本地记录不再可能误路由到云端，删除失败保留错误。云端 Skill Space 不再提供错误的本地文件预览入口。
- 补充资源绑定迁移到预发的条件和当前部署缺口；本地资源调用成功不作为云端部署验收证据。

- 本地冻结 Build 增加可选的认证 HTTP 运行入口，复用 DSH 原生会话、实时模型事件与持久化工具记录；支持重复请求复用、内容冲突拒绝、取消和断开处理。云端可携带产物与部署联调仍未完成。
- 修复资源预设恢复与运行准入并发时重复注册、导致 Agent 无法启动的问题；同一预设共享一次资源探测与注册，失败后允许重试。

- Channels 现在可为本地 Agent 建立出站 Gateway 连接，渠道消息复用 DSH 原生会话、绑定模型、资源与历史；按 Agent 和渠道会话隔离，并用持久化请求身份防止重复执行。
- 本地渠道连接支持心跳、取消、截止时间和断线重连；凭证拒绝停止重试，设备离线明确报错。连接状态可查看和停用，凭证只在 Host 保存。
- 渠道编辑支持按名称选择本地 Agent，保存时自动填写本地执行路由；渠道工作区 ID 不绑定文件目录。真实 WPS 消息已通过 Gateway 进入原生会话并回复；同一普通问题分别验证 Harness、DSH Native 与 Codex 的系统提示词，渠道改绑保存后立即生效。独立 Channel 服务同步修复配置刷新、慢执行 HTTP 超时，以及停用后无法在列表重新启用的问题。

- 部署页准确说明本地 Build 尚未接入云端发布，修正“Server 没有部署合同”的错误归因；已有 CreateAgentProduct/UpdateAgent 部署能力与 Studio 产物适配分开记录。

- Channels 新增表单补齐必填 App ID 和 App Secret；编辑时留空保留凭证，锁定不可变渠道身份字段。连接保存后刷新数据，工作区保持可选。
- Channels 代理校验业务响应码和响应格式，渠道不存在等错误不再显示为保存成功；参数错误显示字段名，避免把凭证回显到错误信息中。
- 补齐 DSH 临时兼容 API 的双语使用说明和生成目录，43 项官方文档同步门禁全部通过；持久化类型摘要未变更。

- macOS 原生菜单、“关于”窗口和恢复提示使用 AgentKit Studio 产品名称，与安装图标一致；不改动应用数据路径和模型提供方名称。
- DSH 补丁检查按顺序在独立临时索引中验证，支持后续补丁依赖已有改动，检查失败不改动工作目录。
- macOS 普通启动会为已有 Desktop Profile 补齐首次加入的 Studio 产品插件，修复 App 只有 DSH 插件页、没有 Studio 入口的问题；保留用户后续禁用选择。
- 本地 macOS 打包完成后自动导出 Studio 命名的 DMG 和摘要记录，修复构建成功但下载路径仍保留旧包的问题；缺失或空产物明确失败。
- 本地 Harness 的模型临时故障进入 DSH 原生重试与持久化历史；无工具 Agent 也使用同一循环。认证、配额和上下文错误保留分类，取消与重试上限继续由 DSH 管理，云端 Agent 和 Codex 整轮不会被自动重放。
- 模型空响应和缺少完成标记的断流不再误报成功；上游错误响应正文不进入会话或 Trace。

- Build ZIP 下载改用 DSH 已认证的文件响应，修复内嵌浏览器点击下载却没有文件的问题；仍校验冻结内容和下载大小。
- 本地开发插件按包内容摘要安装，并逐文件核对安装内容，防止同版本 tarball 被 pnpm 缓存为旧代码。
- 原生会话在预设恢复后实时更新 Agent 名称，合并读取期间的目录刷新，避免冷启动长期显示内部 ID。

- 原生会话修复裸网址紧邻中文括号时的错误跳转与加粗显示，流式和历史回放保持一致；显式链接和中文路径不受影响。
- Codex 插件空目录提供直接安装入口，搜索无结果时可清空恢复目录；补齐独立桌面安装、技能加载与卸载的界面验收。
- Profile 安装和 Web 启动使用官方源码 CLI，保留当前 pnpm 环境，避免把 DSH 工作区的 pnpm 11 注入旧版 pnpm 10 Profile 后导致插件安装失败。

- 本地 Agent Revision 按版本保留不可变快照，Host 重启恢复旧会话预设；已验证的历史 Build 可补齐旧版本，避免编辑 Agent 后旧会话报 unknown preset 或误用最新 Prompt。
- Studio 的模型传输按公开 sessionId 路由，普通会话和标题生成不再被其他 Agent 截获；选择 Agent 模型不会改写普通新会话的全局默认值。
- 添加模型实际调用 Host 配置合同，独立配置保留各自凭证与名称；模型变更立即同步原生选择器。已有 MCP 凭证仅填写引用名也能保存和探测，无须重填密钥。
- 绑定 Agent 期间显示处理中并防止重复提交；普通新会话清除上一个 Agent 的历史过滤。一次性自动化必须填写未来时间，编辑时按本地时区显示。

- 评测集导入传递真实文件内容，本地冻结 Build 进入目标目录并通过 DSH 原生运行读取实际答案与工具记录；JSON Schema 断言复用 MCP SDK 校验器。Session 日志导出复用官方 DSH 的持久化读取与序列化 API。
- 自动化表单与持久化调度合同统一，实际执行复用 DSH 公开 Session Controller、Agent.whenIdle 和回合结束记录；保存错误诊断并显示真实下次执行时间。
- 观测页读取真实本地 Trace，云端汇总独立显示；修复耗时、完成率、Agent 筛选和 Run/Session 搜索，未上报的 Token 用量保持未知，OTLP 导出使用合法 Trace ID。关闭长期记忆后不再召回云端内容。
- 安装包内置固定版本的官方 Codex CLI，模型目录、对话和插件管理使用同一入口，保留显式外部 CLI 覆盖。
- macOS 产品包使用 AgentKit Studio 图标和名称，保留 DSH 默认构建品牌；修复 Studio 面板刷新恢复与设置页连接状态。

- 一键研究模板实际填写并保存研究 Prompt，切换模板保留自定义内容；本地 Skill 预览和导入使用 Host 扫描记录中的真实目录，支持指定目录及 Skill 根目录，不再错误限制为 Home 内路径。Skill 存储遵循 AGENTKIT_HOME。

- Codex 模型通过实际 App Server 的 `model/list` 和配置读取进入 DSH 原生模型目录，Agent 默认模型与会话选择传到 `thread/start`；不再显示无关的网关模型。适配器继承官方 `LlmAdapter`，保留原生目录、模型选择和生命周期合同。
- Agent 新会话先通过 DSH 公开 Remote 保存模型，再挂载原生页面，消除未创建浏览器 scope 的绑定竞态；进入会话后刷新不再恢复旧的 Studio 面板。
- 网关已发布的模型可沿用所选网关配置的凭证真实运行，并进入原生模型选择器；创建默认值保留配置的默认模型。多模型绑定以显式默认字段为准，已停用配置和未发布模型仍明确拒绝。
- 云端 Agent 目录读取失败时继续显示本地 Agent，并保留创建和运行入口；混合目录的搜索、分页和总数统一计算，不再每页重复附加本地 Agent。
- 构建历史可下载经过内容身份和 ZIP 校验的冻结产物；下载沿用 Host 连接，模型和资源凭证不会进入产物。
- 模型、MCP 和 Skill 资源目录统一支持搜索及游标分页；合并目录读取后续云端页并去重，云端读取失败会明确提示只显示本地资源。
- MCP 保存成功但探测失败后保留资源 ID，重试更新同一记录；页面区分配置保存与连通性验证，探测和删除结果提示不会在刷新时消失。
- 云端 MCP 探测通过控制面读取 Endpoint，不再强制要求本地资源记录；探测工具清单和连接失败状态在 Host 持久化，刷新后仍可查看。
- 本地及云端 Skill 的完整文件注册到 Agent 作用域中的 DSH SkillRegistry，复用原生 Skill 与脚本工具，云端压缩包校验路径、大小和 CRC。记忆上下文说明 Host 的真实写入策略，避免模型误报仅支持当前会话记忆或提前承诺保存成功。
- 增加显式的 macOS 本地 `unsigned` 离线包入口，复用官方 DSH 生产运行时与 package-set，产物独立标识且不携带更新源或发布记录。正式签名、公证门禁保持启用。
- 离线 App 首次 Profile 保留 Studio bundle，启动器从打包根 manifest 解析插件；Studio 使用自身模型配置入口，避免被默认 DeepSeek welcome 阻断。

- 插件市场的加号现在打开安装源表单。DSH 安装、启停、卸载和更新按原生 `ChangeResult`
  判断是否生效，失败、取消或配置被覆盖不会再被包装为成功；安装源检查拒绝会在下载前显示。
  DSH 自带 bundle 直接启用，宿主必需组件保留保护，详情显示 Host 条目的加载状态与失败原因。
  更新保留原有依赖直至新版本安装完成，重启提示与加载警告不会被目录刷新清除。
- Codex 插件生命周期保留完整的 `plugin@marketplace` 标识和配置的 `CODEX_HOME`，并展示 CLI
  失败原因；空的官方清单不会被过期缓存替代，只有缓存时不再声称插件已经启用。
- 本地 Harness 的绑定 MCP/AgentEngine Tool 现在会在 preset 准入时读取真实工具 schema，并注册到 DSH
  原生 ToolRegistry；模型发出的工具调用由 DSH loop 执行，MCP 凭证和传输仍由 Host 持有，原生轨迹会
  记录可展开的 `tool-call` block 和 `tool-calls` 终态，不再只把调用过程伪装成 reasoning 文本。
- 本地 Harness 的模型 SSE 现在复用统一解析器，兼容 `\n`、`\r\n` 和分片 UTF-8 帧；上游截断、无效事件、错误帧和 `length/content_filter` 不完整输出会以带错误码的失败事件结束，不再吞掉思考、工具调用或误报成功。
- 本地 Harness 的 MCP 循环现在保留每轮 assistant 文本、reasoning 和 tool call 历史，并按 Agent Revision 的 `execution.maxSteps` 执行（默认 12、上限 100）；达到预算会返回 `LOCAL_EXECUTION_LIMIT`，不会写入记忆或发出 `run.completed`。
- 云端 Agent 编辑页现在通过 Host 代签 `UpdateAgent` Action 保存知识库、记忆库和 Skill Center
  ComponentConfig；云端页面不再调用不存在的旧本地 REST 路由。模型、MCP、本地 Skill 和 Tool 等
  不属于该云端合同的绑定会在保存前明确拒绝，避免出现页面成功但云端未更新。
- 云端 Agent 的知识库、记忆库和 Skill Space 绑定现在会在进入 `RunAgent` 前由 Host 物化为受限上下文，
  再交给云端运行时生成回答；这补齐了自定义运行时只保存 ComponentConfig、却没有自动注册资源工具的缺口。
- 知识库检索会把 DSH 会话中的长输入限制在 `RetrieveKnowledge` 支持的 250 字符以内，避免云端
  Action 因查询过长返回 400。
- 云端 Agent 的 `langgraph`、`hermes`、`openclaw`、`adk` 等服务端运行时现在可以直接绑定到
  DSH 原生会话；Host 不再把它们误判为本地 runtime，也不会要求本地 Tool Registry 物化云端工具，
  实际执行统一交给 AgentEngine `RunAgent` 流。未知的本地 runtime 仍保持明确拒绝。
- 本地 MCP 现在会在每次探测和工具调用前重新解析 DSH credential；凭证轮换会自动替换旧连接，
  不再把过期的连接缓存到 Host 生命周期结束。HTTP 401/403/404、缺少凭证和工具目录失败分别
  返回可操作的错误码，并把最近一次探测错误保存在资源健康状态中，资源库可以直接看到失败原因。
- MCP 资源库现在支持编辑已有本地 MCP 的 endpoint、环境变量引用和凭证；保存后会使旧工具契约失效并
  重新探测，用户不必删除资源后重建。凭证值仍只进入 DSH credential service，不会写入资源声明。
- 云端 RunAgent SSE 现在兼容 CRLF 分帧和 authoritative snapshot 替换语义；DSH runtime context 不会再
  被误当成人类问题发送，知识库 `Segment.Content` 与文档名也会保留到受限上下文中。
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
