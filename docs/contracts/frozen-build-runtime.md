# 冻结 Build 的 HTTP 运行入口

此入口让外部调用方在已有 Studio Node Host 中执行一个指定 Build。底层复用公开 DSH
Session Controller、AgentLoop、模型重试、工具注册、持久化历史与原生会话页。
它是本地构建产物的运行消费者；尚不是可独立部署的云端安装包，也不提供 AgentEngine
RunAgent 或 OpenAI Responses 协议兼容性。

## 启动

先通过 Studio 构建 Agent，并确保同一 Host 能解析其模型、MCP、Skill 和平台资源引用。
迁移到独立 Host 时，可使用[可迁移运行包](portable-agent-bundle.md)携带资源配置与 Skill 文件，
由目标环境注入凭证；普通定义 ZIP 仍只冻结绑定引用。
在启动已安装 Studio 插件的 DSH Profile 时注入以下环境变量：

| 变量 | 含义 |
| --- | --- |
| `AGENTKIT_RUNTIME_AGENT_ID` | 本地构建所属 Agent ID |
| `AGENTKIT_RUNTIME_BUILD_ID` | 已存在且内容校验通过的 `build_` ID |
| `AGENTKIT_RUNTIME_TOKEN` | 由部署者注入、至少 24 字符的随机访问令牌 |
| `AGENTKIT_RUNTIME_HOST` | 默认 `127.0.0.1` |
| `AGENTKIT_RUNTIME_PORT` | 默认 `8080` |

不设置 Agent/Build 时不启动额外监听。配置无效、资源无法准入或端口占用会使启动失败，
不会降级为默认编码助手。令牌和资源凭证不写入 Build 或客户端状态。
Agent 的 Prompt、Revision 和绑定引用来自校验后的构建；引用的凭证、模型配置与资源端点
仍由 Host 管理，不宣称已经把资源服务本身冻结或打包。

构建指定本地历史 Revision 时，Host 读取该 Revision 的不可变记录，不使用最新草稿替代。
找不到版本会在入队前失败；云端接口只能读取当前定义时，请求其他版本明确拒绝。后台任务
接收完整克隆快照，后续编辑不改变已受理的 Prompt、模型与绑定引用。该冻结仍不覆盖引用资源
自身的内容、配置或服务状态。

同一 Host 的并发相同请求只受理一次；同一幂等标识用于其他 Agent、版本或定义会返回冲突。
排队操作支持取消并阻止实际构建；已开始的操作不能被标记为已撤销，返回
`OPERATION_ALREADY_STARTED`，由真实执行结果决定终态。构建历史串行更新并原子落盘，重复构建
先校验已有产物，不覆盖损坏证据。下载和运行同时验证 manifest 身份与 spec 的一致性。

## 调用合同

`GET /health` 返回最小存活状态。其余入口要求 `Authorization: Bearer <token>`，拒绝带
Origin 的浏览器跨源请求。本机默认仅监听回环地址；当前不包含公网 TLS 终止、租户隔离、
负载均衡或多副本协调。

`POST /runs` 接收 `application/json`：

```json
{
  "input": "周末想去苏州玩两天，预算800元，帮我安排一下。",
  "sessionId": "trip-planning",
  "requestId": "question-1",
  "stream": true
}
```

`input` 和 `requestId` 必填。`sessionId` 可省略，此时该请求拥有独立会话。
会话和请求标识只接受 1–128 个 ASCII 字母、数字及 `_.:-`，首字符为字母或数字。
禁止传入 Agent、模型或 Prompt 覆盖字段；请求体上限 256 KiB、同时在途请求上限 16。
外部会话标识按 Agent + Build 命名空间映射，不能直接指定已有原生会话 ID。
同一会话的调用串行执行，权限模式为只读，文件工作区保持可选。无人值守运行通过公开的
DSH ApprovalService 设置 `never`：需要提权的工具自动拒绝，不等待 Web 审批；不会改为
完整文件访问。Linux 执行 Skill 脚本还要求可用的 Bubblewrap 或 Landlock 沙箱后端。

非流式返回原生 `sessionId`、持久化 `runId`、`output`、Token 用量及工具名记录，另附
HTTP 运行身份 `runtimeRunId`、调用者的 `requestId` 和 `buildId`。
同一会话同一请求标识重发已完成请求时复用原生结果；非流式请求换内容返回 409。
同一请求仍在执行时返回 409；未完成或失败的持久化请求不会自动启动第二次副作用。
需要新的尝试时使用新的 `requestId`。

流式返回以下 SSE 事件：

| 事件 | 内容与语义 |
| --- | --- |
| `run.started` | HTTP 运行 ID、原生会话 ID、Agent、Build 和请求标识；表示受理，不保证模型成功 |
| `dsh.assistant` | 官方 `AssistantStreamFrame`：start/chunk/end，保留 attemptId、revision、索引与提交/废弃结局 |
| `dsh.event` | 同一原生会话的 turn/step、assistant message/attempt、tool call/result 持久化事件 |
| `run.completed` | 已确认原生回合完成的最终结果 |
| `run.failed` | 错误码；不回显上游错误正文、认证头或凭证 |

流已开始后发生的运行或历史校验错误通过 `run.failed` 返回，HTTP 状态保持 200；
例如已使用 requestId 的内容冲突会返回 RUNTIME_REQUEST_CONFLICT，不能只凭 HTTP 状态判成功。

`dsh.assistant` 中途出现的文本是暂态，消费者必须按 attempt 跟踪，并在 abandoned 或失败
尝试时撤回，不能把重试前后的片段直接拼接为最终答案。持久化 `assistant/message` 和
`run.completed.output` 才是已提交结果。重发已完成请求可直接返回最终结果，不重播暂态帧。

`POST /runs/{runtimeRunId}/cancel` 请求取消当前运行并返回 202；它不是取消已经落盘的证明。
客户端断开也请求取消，原生终态可在 DSH 会话中核对。取消后的迟到结果不会误报成功。
SSE 每 15 秒发送保活，慢消费者缓冲超过 4 MiB 时断开并取消。当前流不支持
Last-Event-ID 重放；断线后可以读取原生历史，并以同一请求身份检查结果。

## 已验证与剩余工作

真实 Host 验收记录见 [端到端矩阵](e2e-acceptance-2026-10-07.md)。测试覆盖认证、输入限制、
实时事件先于完成、取消、断开、重复请求、历史定位、错误脱敏和并发资源预设注册。
云部署仍需独立实现固定 DSH/Profile 的可携带运行产物、资源配置注入、云端协议适配、上传
以及 CreateAgentProduct/UpdateAgent 生命周期联调；本入口不能作为这些流程已完成的证据。
