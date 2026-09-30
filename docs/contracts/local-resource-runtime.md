# 本地资源运行时合同

核对日期：2026-09-30。

本合同只适用于插件 Node Host 内执行的本地 Agent。浏览器不读取资源凭证，也不直接访问 MCP
或知识库 Endpoint。

## 执行路径

- **Skill**：本地 Skill Resource ID 映射到已导入 Skill 目录，只读取 `SKILL.md`；云端 Skill
  Space 则通过 Skill Service 的 `ListSkillsBySpaceId` 与下载 URL 合同拉取 Skill 包并读取其中
  的 `SKILL.md`。两者都会截断后注入 system context，文件内容不会因为 Agent 对话自动执行。
- **Knowledge Base**：绑定的 Dataset ID 通过 `RetrieveKnowledge` 查询，默认取 5 条结果，
  结果以只读 context 注入本轮模型输入。
- **Memory**：绑定的 Memory Instance ID 通过 `QueryMemorySdk` 查询，使用请求中的用户 ID；
  没有用户 ID 时使用 session/Agent 范围的隔离回退值，结果以只读 context 注入本轮模型输入。
- **MCP**：Host 对只有 `resourceId` 的绑定调用 Server `GetMCP` 获取 Endpoint 和认证信息；
  也接受带 `endpointUrl`/`url`、`headers` 和 `credentialRef` 的外部 MCP 描述，凭证引用由 DSH
  credential service 或同名进程环境变量解析。随后使用 `@modelcontextprotocol/sdk` 建立
  Streamable HTTP 连接，调用 `tools/list` 和 `tools/call`。只允许模型请求当前 Agent 绑定且已
  发现的工具；同名工具绑定会直接失败，避免路由歧义。

- **Codex**：Codex Agent 复用上面的 Host 资源上下文。Skill、知识库和记忆库以 developer
  context 注入官方 Codex App Server Thread；MCP 工具转换为实验性 `dynamicTools`，Codex
  发出 `item/tool/call` 后由 Host 校验绑定并调用同一 MCP adapter，再以 `contentItems` 返回。
  这条路径仍由 DSH 原生 Session/Loop 承载，Codex 不会获得 Studio 工作区或 MCP 凭证。
  Host 会把工具调用的开始、完成和失败状态投影成 DSH reasoning 增量，因此原生会话可以展开
  查看资源调用过程；不会伪造 DSH `tool-call` block，避免 DSH loop 再次执行同一个 MCP 工具。

模型的 tool call 会先记录为本地 conversation item，Host 执行 MCP 后以 tool result 继续最多两次
工具续跑（最多三次模型请求）。MCP 返回 `isError`、参数 JSON 非法、资源缺失或模型实际调用
工具失败都会生成失败终态；一次文本回合开始前的 `tools/list` 连接失败会作为受限资源告警注入
上下文，让不需要工具的文本回合继续运行，并在下一回合重新尝试发现工具。

## 安全和边界

- AK/SK、MCP API Key、模型 API Key 全部留在 Node Host；外部 MCP Agent 绑定只持久化 Endpoint
  和 credential reference，不把 API Key 写入 Agent Revision。
- 本地 Skill 只读，不执行其中脚本。
- 资源运行适配器不把 Server 的资源目录接口误当作通用 Agent binding；绑定数据仍来自
  Agent Revision。旧版本把云端 Skill Space UUID 写进 `bindings.skills` 的记录会在读取时迁移
  成 `skill-space` 云端绑定，本地 Skill ID 仍保持原有语义。
- 云端 Agent 由 AgentEngine Server 的 `RunAgent` 合同执行，Studio 不在本地重复执行云端 Agent
  的 loop；本地 Agent 才在 Node Host 物化这些绑定。仍未实现 stdio MCP 自动启动、资源级 secret
  rotation 或多租户策略编排，这些情况必须返回明确错误或使用 Server 已有能力。

## 观测

每次本地运行完成或失败后调用 `StudioObservability.syncTrace`。trace 写失败只记录 Host 警告，
不改变模型运行结果。运行 session ID 来自对话请求，便于观测页按会话追踪。
