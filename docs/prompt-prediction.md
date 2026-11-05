# Studio 内置 Prompt Prediction

Studio 的 prompt prediction 直接挂在 DSH 原生 composer 的
`conversation.input.overlay` 上。它只在当前 Session 的输入框为空、没有附件、没有排队消息且上一轮正常完成时轮询预测；Tab、右方向键接受，Esc 忽略。接受通过 DSH 的 `inputActions.insertText()` 写回，因此受草稿 revision CAS 保护，不会触发发送。

Host 监听 `session/event`，只保留最近的 user/assistant 文本，追加一条 request-only 指令，并通过 Studio 的模型配置向 OpenAI-compatible `chat/completions` 发送一次短请求。预测不会追加 Session event，不参与 DSH Loop，不复用 Codex、云端 Agent、A2A 或 Native Harness whole-turn 路径。派生 Session、工具/云端/Codex 路由、没有 assistant 文本的会话都会跳过。

浏览器只能访问经过 DSH Connection 鉴权的三个路由：

- `GET /api/agentkit/prompt-prediction/state`
- `POST /api/agentkit/prompt-prediction/feedback`
- `GET /api/agentkit/prompt-prediction/config`

默认只记录状态与耗时，不写入原始草稿、模型请求或预测文本。可通过 `AGENTKIT_PROMPT_PREDICTION_ENABLED=0` 关闭，`AGENTKIT_PROMPT_PREDICTION_AUDIT=1` 开启 Host 审计开关；审计仍不应记录密钥或完整会话文本。模型请求复用 Studio 当前默认模型配置，API Key 只在 Host 侧读取。

这个实现没有新增 DSH patch，也不复制 DSH 私有 UI；升级到 `dsh-v0.2.2-rc.1` 后由 Studio 自己的 Host/Client 代码注册原生 slot 和 Connection route。
