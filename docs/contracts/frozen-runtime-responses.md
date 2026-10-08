# 冻结 Agent 的 Responses 入口

可迁移运行包启动后，同一 HTTP 服务同时提供原有 `/runs` 与 `POST /v1/responses`。
后者接收 AgentEngine `ChatService.responses` / `stream_responses` 的单轮文本请求。
它仍执行包中固定的 Agent、Build、默认模型和资源绑定。

## 复用与所有权

固定 DSH v0.2.0-rc.2 中没有服务端 Responses ingress。Studio 增加传输转换，复用
`createNativeAutomationRunner`、公开 `sessionController`、`agent/assistant-stream`
与 `session/event`；不复制循环、不建立另一套 transcript 或 Session 存储。
前一轮存在性、完成状态、输入冲突和重复请求都以 DSH 持久化历史为准。

## 请求

```sh
curl "$RUNTIME_ENDPOINT/v1/responses" \
  -H "Authorization: Bearer $AGENTKIT_RUNTIME_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: request-1' \
  -d '{"input":[{"role":"user","content":[{"type":"input_text","text":"查询 Q7 卡片的状态，给我结论。"}]}],"session_id":"cards","stream":true}'
```

- `input` 接受非空字符串，或一条 `role=user` 消息；内容接受字符串、`input_text` / `text`
  文本块。请求上限 256 KiB。暂不接受图片、文件、历史消息数组和客户端工具结果。
- `stream` 默认 `false`。`session_id` 或 `conversation`（字符串 / `{id}`）指定续聊；
  也可只传上一轮返回的 `previous_response_id`。冲突的会话标识返回 400。
- `request_id`、`Idempotency-Key`、`metadata.agentengine.invocation_id` 是可选幂等标识；
  同时提供时必须一致。不传则每次产生新的请求。相同请求进行中返回 409，完成后从 DSH
  历史返回结果；同一标识配不同输入返回 409，不重复调用资源。
- `model` 可省略；提供时必须等于冻结 Build 的默认模型资源 ID。当前不提供请求级
  模型、系统指令、工具或模型参数覆盖。`instructions`、`tools`、`model_options`、
  `model_metadata`、`store`、后台执行等未支持字段明确拒绝，不会静默忽略。
- `user` / `account_id` 参与会话隔离，必须由上游鉴权后的业务身份填充。直接持有此
  Host Bearer 的调用方具有该 Agent 的访问权限；这不是独立的多租户鉴权服务。
- Response / Conversation 句柄只包含摘要，签名绑定 Agent、Build、身份及 Host token。
  保留数据目录和 token 可跨 Host 重启续聊；token 轮换会使旧句柄失效。

## 响应、流和取消

普通响应返回 `id`、`object=response`、`status`、`model`、`session_id`、`conversation`、
`output`、`output_text`、`metadata` 和真实 `usage`（运行时提供时）。
流包含创建、进行中、文字增量、推理摘要增量、输出项完成和最终终态，并以 `[DONE]` 结束。
生命周期事件同时保留顶层字段和 `response` 对象，兼容 AgentEngine 现有消费者。

DSH 的失败尝试标记为 incomplete，最终 output 排除其草稿；最终 `output_text` 取 DSH
持久化运行结果。客户端须按 item/status 处理重试，不能把所有到达过的文字当成最终答案。
`sequence_number` 仅用于本次连接排序，不是持久化重放游标；`Last-Event-ID` 明确返回
`RESPONSES_STREAM_REPLAY_UNSUPPORTED`。没有宣称断线自动恢复或多副本共享会话。

工具输出项来自 DSH 的 `tool/call` / `tool/result`，也包含 Codex 已持久化的
`agentkit/codex-tool` 展示事件。Codex 工具不再执行一次；结果通过扩展事件
`response.tool_result` 返回，执行次数按 call ID 去重。

`POST /v1/responses/{response_id}/cancel` 使用同一 Bearer，验证活动句柄后返回 202，
并取消原生 Agent。断开 HTTP 连接也取消运行；取消后不会发出成功终态。错误只返回错误码，
不回显模型地址、鉴权头和上游原始异常。

## 2026-10-08 验收

- `verify-agentengine-responses.mjs --server-root SERVER_CHECKOUT --python SERVER_PYTHON`：
  直接加载现有 `ChatService`，实际通过 HTTP 验证 JSON、SSE、文本块、会话和 token 用量。
  此项用合成运行器，未启动控制面数据库、Gateway 或预发服务。
- `verify-portable-codex.mjs --execute --responses --dsh-root DSH_CHECKOUT --keep`：
  真实 Codex 0.159.2 + GLM-5.3-Flash，独立 Profile、删除导出源后运行。
  系统标记、Skill 格式和 MCP 当次随机核验码均命中；实际调用 MCP 1 次，20 个文字增量，
  首段文字约 4.94 秒，总计约 6.58 秒，输入 18314 / 输出 127 tokens。
  重复请求没有再次执行 MCP；重启 Host 后仅凭 `previous_response_id` 找回卡片编号和核验码。
- 首轮曾漏掉 Skill 要求的输出标记，DSH 历史显示模型已读取要求；更明确的 Skill JSON
  格式通过了后续验收。模型遵从性仍可能波动，这不是协议层自动补写出来的标记。
- 单元测试覆盖鉴权、字段拒绝、Build/用户隔离、句柄校验、取消、失败尝试、跨块文字、
  Codex 工具事件，以及原有 `/runs` 行为。
- Node 22.19.0 下 `make release-check`：401 项测试、18 份补丁格式检查和 237 文件的
  插件包完整性检查通过。

尚未证明 Linux 镜像、预发 UploadCode/CreateAgentProduct 生命周期、真实云资源网络、
多副本路由、完整 Responses 功能及云端 UI 都已接通；这些仍是发布门禁。
