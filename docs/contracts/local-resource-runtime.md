# 本地资源运行时合同

核对日期：2026-10-07。目录状态和预发迁移边界见
[资源状态、删除与部署](resource-status-and-deployment.md)。

本合同只适用于插件 Node Host 内执行的本地 Agent。浏览器不读取资源凭证，也不直接访问 MCP
或知识库 Endpoint。

## 执行路径

- **Skill**：本地 Skill Resource ID 映射到已导入 Skill 完整目录；云端 Skill
  Space 则通过 Skill Service 的 `ListSkillsBySpaceId` 与下载 URL 合同拉取 Skill 包，先按
  `ContentHash` 做 sha256 完整性校验，并校验压缩包路径、大小和 CRC 后加载完整文件。
  缺少摘要的历史条目仍可兼容读取，但摘要格式非法或校验不匹配会以 typed error 终止物化。
  文件注册到 Agent 作用域的 DSH SkillRegistry，并启用原生 Skill 和 Bash/Pwsh 工具；
  模型可按任务请求读取 Skill、执行脚本，执行受当前会话工具策略约束。目录可见或导入成功
  不等同于脚本依赖齐备，也不意味着每次对话都会调用这个 Skill。
- **Knowledge Base**：绑定的 Dataset ID 通过 `RetrieveKnowledge` 查询，默认取 5 条结果，
  结果以只读 context 注入本轮模型输入。
- **Memory**：绑定的 Memory Instance ID 通过 `QueryMemorySdk` 查询，使用请求中的用户 ID；
  没有用户 ID 时使用 session/Agent 范围的隔离回退值，结果以只读 context 注入本轮模型输入。
  当 `spec.memory.enabled=true` 且 `spec.memory.write.mode` 为 `candidate` 或
  `explicit_only` 时，回答完成后会把本轮 user/assistant 对话通过 `CreateMemorySdk` 排队写回；
  `explicit_only` 仅在用户输入包含“记住 / 别忘了 / remember”等显式记忆意图时写入。
  这是后置副作用，写入失败只记入 trace，不改变已生成的回答。Harness 与 Codex 共用同一回写适配器。
- **MCP**：Host 对只有 `resourceId` 的绑定调用 Server `GetMCP` 获取 Endpoint 和认证信息；
  也接受带 `endpointUrl`/`url`、`headers` 和 `credentialRef` 的外部 MCP 描述，凭证引用由 DSH
  credential service 或同名进程环境变量解析。随后使用 `@modelcontextprotocol/sdk` 建立
  Streamable HTTP 连接，调用 `tools/list` 和 `tools/call`。只允许模型请求当前 Agent 绑定且已
  发现的工具；同名工具绑定会直接失败，避免路由歧义。
- **DSH Tool**：资源绑定中的 Tool 名称进入会话级 DSH preset。Studio runtime plugin 通过官方
  `ctx.tools.schemas()` 做白名单投影，并用 `ctx.tools.execute()` 保留 DSH 的参数校验、审批和
  生命周期策略；本地 Harness 与 Codex 都复用这条适配器，未注册或未绑定的工具会返回明确的
  `TOOL_NOT_FOUND`/`TOOL_ADAPTER_MISSING`，不会把绑定静默当成普通文本。

直连 AgentEngine Server 时，Tool 目录通过现有 `/api/v1/catalog/resources?kind=tool` 读取；该
接口不可用时返回 typed unavailable，而不是伪造一个空目录。Skill 目录由本地导入 Skill 与
`ListSkillWorkspaces` 返回的云端 Skill Space 合并，实际读取云端 Skill 仍由 Host-owned
Skill Service 适配器完成。

- **Codex**：Codex Agent 复用上面的 Host 资源上下文。Skill、知识库和记忆库以 developer
  context 注入官方 Codex App Server Thread；MCP 工具转换为实验性 `dynamicTools`，Codex
  发出 `item/tool/call` 后由 Host 校验绑定并调用同一 MCP adapter，再以 `contentItems` 返回。
  这条路径仍由 DSH 原生 Session/Loop 承载，Codex 不会获得 Studio 工作区或 MCP 凭证。
  Host 会把工具调用的开始、完成和失败状态投影成 DSH reasoning 增量，因此原生会话可以展开
  查看资源调用过程；不会伪造 DSH `tool-call` block，避免 DSH loop 再次执行同一个 MCP 工具。

Harness 和有资源的 DSH Native 使用原生模型步骤：MCP 注册到公开 ToolRegistry，调用与结果
由 DSH Loop 执行、持久化和展示。Codex 的动态工具仍通过 Host 适配器执行并投影过程。
云端 Skill Space 的压缩包下载经过 Host 注入的 `fetchImpl`。

原生路径由 DSH Loop 管理工具续跑；独立本地兼容运行路径按 Agent 的 `execution.maxSteps`
限制步数（默认 12，上限 100）。MCP/DSH Tool 返回 `isError`、参数 JSON 非法、资源缺失或模型实际调用
工具失败都会生成失败终态；一次文本回合开始前的 `tools/list` 连接失败会作为受限资源告警注入
上下文，让不需要工具的文本回合继续运行，并在下一回合重新尝试发现工具。

浏览器取消或断开本地流时，Host 将同一个 `AbortSignal` 传给模型请求；上游模型连接会被中止，
运行 trace 写入 `canceled` 终态，不再继续等待超时或写入 `run.failed`。

## 安全和边界

- AK/SK、MCP API Key、模型 API Key 全部留在 Node Host；外部 MCP Agent 绑定只持久化 Endpoint
  和 credential reference，不把 API Key 写入 Agent Revision。
- Skill 可以通过原生工具执行其脚本；只读权限或缺失依赖造成的拒绝不能误报执行成功。
- 资源运行适配器不把 Server 的资源目录接口误当作通用 Agent binding；绑定数据仍来自
  Agent Revision。旧版本把云端 Skill Space UUID 写进 `bindings.skills` 的记录会在读取时迁移
  成 `skill-space` 云端绑定，本地 Skill ID 仍保持原有语义。
- 云端 Agent 由 AgentEngine Server 的 `RunAgent` 合同执行，Studio 不在本地重复执行云端 Agent
  的 loop；本地 Agent 才在 Node Host 物化这些绑定。仍未实现 stdio MCP 自动启动、资源级 secret
  rotation 或多租户策略编排，这些情况必须返回明确错误或使用 Server 已有能力。

## 观测

每次 Harness 或 Codex 本地运行完成、失败或取消后调用 `StudioObservability.syncTrace`。两条路径都
写入输入、思考、回答和工具生命周期的轻量事件；工具名、失败码和字符数会保留，完整回答不会复制到 trace。
trace 写失败只记录 Host 警告，不改变模型运行结果。运行 session ID 来自对话请求，便于观测页按会话追踪。
