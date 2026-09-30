# 云端 Agent 对话适配器

核对日期：2026-09-30。适用范围是 AgentKit Studio 直连
`agentengine-server` 的绑定 Agent 对话，不改变 Server 公共 Action 的语义。

## 当前路径

1. 浏览器通过 DSH Connection RPC 调用 `agents/conversation-surface`。
2. Host 使用 `GetAgent` 确认 Agent，并用 `GetSession` 查询会话；不存在时调用
   `CreateSession`。
3. Host 调用 `ListSessionEvents` 返回已有事件，页面恢复用户和助手文本。
4. 发送消息时，Host 调用 `RunAgent`，请求包含 `AgentId`、`SessionId`、`Messages`、
   `Stream=true`、`ApiFormat=responses` 和本轮 `InvocationId`。
5. Server 的 SSE 只在 Host 内部读取并转发给 `/agentkit/cloud-conversation`；浏览器只接收
   SSE，不持有 AK/SK 或服务令牌。
6. 停止按钮调用 `CancelRun(AgentId, SessionId, InvocationId)`，随后终止浏览器读取。

## 事件和错误边界

- `response.output_text.delta` 聚合为当前助手消息；`response.completed` 才能把运行标记为完成。
- HTTP 错误、Action 错误、断流和取消保持不同错误码；网络请求完成不等于 Agent 运行成功。
- `ListSessionEvents` 的 `SeqId` 是 Server 游标。当前页面只恢复已返回的历史事件；完整的
  seq watermark、实时订阅、重复事件去重和缺口重放仍由下一阶段的 SessionEventStore 适配补齐。
- `ResumeRun`、`SubmitInteraction` 已在 Node Action 白名单中，但本轮页面尚未自动展示
  checkpoint 和 interaction UI；没有对应事实时不伪造恢复或审批成功。

## 不在本轮范围

Server 当前没有公共 `CreateBuild`、`GetBuild`、`StopDeployment` 或通用 Agent 资源绑定合同。
本适配器不把 `DeleteAgent` 当成停止部署，也不把 `ComponentConfig` 当成可独立版本化的绑定资源。

## 验证

本地门禁覆盖 Action 请求签名、SSE 响应保持在 Node、会话面选择和浏览器消费路径。真实云端
租户的 Runtime 输出、取消 receipt、断线重连和权限矩阵需要在集成环境单独验证。
