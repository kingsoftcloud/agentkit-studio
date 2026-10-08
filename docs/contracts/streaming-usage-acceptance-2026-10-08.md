# 流式模型用量验收（2026-10-08）

## 修复

GLM-5.3-Flash 经配置网关实际返回非零 Chat Completions usage，但本地 provider 丢弃了该事件，
导致 DSH 原生 Session 和冻结 Host 的 Responses 用量显示为零。

本地请求显式启用 `stream_options.include_usage`；每次上游请求只保留最后一个有效快照，重复
trailer 不累计。通过现有 provider adapter 将用量送到 DSH 公开 ModelChunk 合同，原生 Session
继续负责持久化与会话汇总。内部工具循环按每次请求累加，DSH 原生工具续轮由其原有循环汇总。
缓存输入包含在上游 prompt tokens 中，转换为 DSH 的独立缓存桶时扣除，避免重复计数；推理
token 包含在输出总量内，不再次相加。缺少或格式错误的上游用量不伪造为零事件。

## 自动检查

`tests/local-runtime-usage.test.mjs` 覆盖真实 local handler 到原生 adapter 的接缝：

- 普通回答、原生工具续轮均收到一次有效用量。
- 重复终帧不会重复计数；内部两步工具调用不会只保留最后一步。
- 缓存和推理 token 正确转换，缺失或无效 usage 不产生记录。
- 已同步的本地 Trace 保留原始单次模型用量。

回归测试先复现丢失用量和内部多步只计最后一步的问题，再应用修复。与本地运行时和续聊相关的
27 项检查通过。

## 真实 macOS Host

将当前 Studio tarball 解包到独立安装目录，使用 DSH 0.2.0-rc.2 的公开 Session/Loop。
为 Harness 和 DSH Native 分别导出独立 Agent 运行包，只绑定同一 GLM-5.3-Flash 网关模型；
使用独立数据目录和随机端口，不修改开发 Host。凭证通过本机受限环境文件注入。

用户消息为“你好，请用一句话回答。”，身份标记只存在于冻结系统提示词中。
检查实际 `/v1/responses` SSE 的完成结果；其用量由原生持久化 `assistant/message` 汇总，
不是从模型原始响应直接伪造。

| 运行时 | 输入 token | 输出 token | 文本增量帧 | 系统提示词盲测 |
| --- | ---: | ---: | ---: | --- |
| AgentKit Harness | 758 | 147 | 11 | 通过 |
| DSH Native | 758 | 121 | 14 | 通过 |

该输入不含业务资源和历史，不能推断所有“你好”请求都具有相同大小。Codex 沿用已独立验证的
用量通道，本次未重跑真实 Codex 请求。测试安装目录复用已有 DSH 编译包，不是完整离线 DMG
或 Linux 镜像验收；相关产物仍需按固定源码重新构建。

## 尚未覆盖

DSH 原生工具调用前的 provider 交接分支尚未将该步骤同步到 Studio 本地 Trace；原生会话
可以记录并汇总用量，但不能据此宣称本地 Trace 已包含完整多步运行的成本。此项单独跟进，
不得用最终模型步骤的 Trace 冒充整轮统计。
