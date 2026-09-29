# `ksyun-sdk-node` 在 AgentKit Studio 的使用边界

核对日期：2026-09-29。核对版本：`ksyun-sdk-node@1.5.67`。

## 结论

这个包可以使用，但只适合作为 **Node Host 到金山云 OpenAPI/AICP 的云端传输层**。它不能替代
AgentKit Studio 当前的 `server-client.mjs`，也不能替代 DSH Host、AgentEngine Server 的
本地 REST/Connection RPC 或会话事件合同。

当前 Studio 已经用 `aws4` 自己完成了 AICP `2024-06-12` 的签名，因为这一层还需要：

- `agentengine-server` 自定义 HTTPS origin 和 loopback Host；
- 本地 `X-AgentKit-Session`、云端 service token 与请求超时；
- `pre-online` 的真实签名 region 和 `X-KSC-CUSTOM-SOURCE`；
- 内网 AICP endpoint 的受限 fallback；
- 只允许白名单 Action，禁止把任意 Action 暴露给浏览器。

这些是产品安全和路由语义，不是通用 SDK 能替 Studio 决定的事情。

## 可以直接复用的部分

`1.5.67` 的 AICP 生成客户端包含以下版本：

- `Aicp.v20240612`：资源池、Notebook、推理和模型等旧版 AICP API；
- `Aicp.v20251114`：知识库、Memory SDK/Collection、MCP Server 和 Session API；
- `Aicp.v20251212`、`Aicp.v20260401`：新版本 AICP API 目录。

因此下一阶段可以在 Node Host 内增加一个**可选的 SDK 适配器**，优先用于只读资源目录和
Session API，例如把 `DescribeKnowledgeBases`、`DescribeMcpServers`、`ListSessions` 的
请求和响应归一化到 Studio 的 `{ items, total, requestId }` 合同。适配器必须仍由
`server-client.mjs` 做 Action 白名单、凭证解析、错误归一化和 endpoint 选择。

## 不能直接拿来补齐的部分

生成客户端中没有 Studio 需要的完整 AgentEngine 产品合同：Agent Revision、Build、Deployment、
部署回滚、运行观测聚合、Studio 的 Session Event Log、DSH preset admission 和插件生命周期。
这些能力仍要由 AgentEngine Server/DSH Host 提供；仅仅把 SDK client 实例化不会让资源绑定进入
DSH Native 运行时。

另外，SDK 默认实现会打印 curl 请求，不能直接在 Studio Host 中启用，否则可能把签名请求头写入
日志。若采用 SDK，必须关闭该输出，并强制使用 HTTPS、显式 region 和 Host 自己的超时/取消边界。

## 采用条件

只有满足下面条件才把某个 Action 切到 SDK：

1. API Explorer 的 Action、Version、请求字段和返回 envelope 已与当前 Server 合同核对；
2. 适配器有脱敏 fixture，覆盖成功、401/403、限流、内网 endpoint 和取消；
3. SDK 路径失败时不会自动重试写操作，也不会把失败降级成空资源列表；
4. `pnpm check`、带凭证的云端只读 probe 和无凭证 fail-closed 测试都通过。

在这些条件完成前，保留当前 `aws4 + fetch` 实现更安全。SDK 的第一批落点应是只读知识库/MCP/Session
目录，不应先用于 Agent 创建、构建或部署。
