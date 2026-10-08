# Channels 与原生会话

## 复用边界

| 能力 | 既有实现 | Studio 适配范围 |
| --- | --- | --- |
| IM 收发、配对、消息记录 | 独立 Channel API / Worker | 继续通过 Action API 管理，不在桌面复制服务 |
| 本地连接协议 | Channel Gateway `/agentengine/connector/v1`，KsADK `ChannelConnector` | Node Host 实现同一 v1 出站连接；桌面不新增 Python SDK 依赖 |
| 执行、模型、资源、持久化与原生界面 | DSH `sessionController`、Agent registry、Studio preset admission | 复用原生自动化 runner；渠道只提供输入和稳定的会话/请求身份 |
| 身份与授权 | Gateway 验证短期 Connector JWT | 每个 Agent 显式启用，凭证仅在 Host 保存；客户端不签发 JWT |

固定 DSH 基线没有 IM Channel Gateway 客户端；本次修改前 Studio 渠道模块只有配置和
Action 代理。KsADK 的 Python 客户端可以作为协议参考，但不是新版 Node Host 的
运行时依赖。不得另建聊天渲染器或直接调用模型绕过 DSH Session。

## 验收要求

- 配置账号、工作区、Agent 与注册回执身份一致；远端只接受 WSS，开发环回允许 WS。
- Bearer 只出现在握手头中，不放入 URL、浏览器状态或日志。
- 不同 Agent/账号/渠道会话隔离；同一渠道会话保留原生历史及创建时的模型和版本。
- 心跳不被长任务阻塞；支持取消、截止时间、断线重连和有限终态缓存。
- 未知执行结果不盲目重放；同一请求复用 DSH 持久化 requestId 去重。
- 本地目标离线时明确不可用，不降级到同 ID 的云端 Agent。
- 配置保存不代表连接成功，目录同时展示实际连接状态和失败原因。
- 网关与原生 Session 的本地集成验证，与真实 WPS/飞书/企业微信消息验收分别记录。

## 使用方式

1. 在运行中心 → Channels → 连接配置中填写 Channel API 地址和账号。仅管理云端渠道时工作区可空；接入本地 Agent 时填写平台分配的逻辑工作区 ID，它不对应本机文件目录。
2. 在“本地 Agent 接入”选择已创建的 Agent，填写平台为该账号、工作区和 Agent 签发的短期 Connector JWT，启用后等待“已连接”。Studio 不签发或自动延长该凭证，过期后需要替换。
3. 新增渠道时按名称选择本地 Agent，填写渠道应用凭证。Host 自动设置 `ConnectorWorkspaceId`；尚未启用连接时拒绝误存为云端路由。
4. 外部 Channel Worker 负责收发平台消息；Gateway 将输入交给当前设备的 DSH Session，回复经过同一个连接返回。关闭应用或停用连接后本地目标明确离线。

选择本地 Agent 的云端部署时，Host 清空 `ConnectorWorkspaceId`，消息由云端 Worker
执行，关闭桌面不影响该目标。创建/修改云端渠道及审批其配对请求，都要求核验子账号及
所属账号与连接配置一致。审批先读取服务端保存的请求，再按其中的 Agent 核验身份；
浏览器提交的 Agent ID 或审批人不作为依据。服务端按租户、待处理状态及审批到期时间
原子更新，不能通过另一个租户的请求 ID 越权或覆盖已有决定。

真实 WPS 配对、知识库问答、续聊和定时投递证据见
[三运行时渠道验收](wps-runtime-acceptance-2026-10-09.md)。

同一渠道会话继续使用首次创建时冻结的 Agent 版本和模型。更新 Agent 后需要新的渠道会话才能使用新版本，已有会话不会悄悄切换身份。连接重新启动后，相同请求仍由 DSH 历史去重；已取消或结果未知的请求不会自动重放。
