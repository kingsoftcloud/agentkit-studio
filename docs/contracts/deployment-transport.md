# 云端部署 API 复用

Studio 沿用 AgentEngine Server 的 `CreateAgentProduct` Action 创建云端 Agent，
不新增平行的创建接口，也不直接调用订单回调 `CreateAgent`。现有服务继续负责账号鉴权、
订单、Agent ID 分配和异步创建。`X-Ksc-Request-Id` 仅用于追踪，不是创建幂等键。

`src/server-client.mjs` 中的 `createAgentEngineDeploymentClient` 是 Node 侧传输层，
与浏览器可调用的通用 Action 桥接分开。它复用原有签名、区域和错误处理，提供：

| 方法 | 现有 Action | 边界 |
| --- | --- | --- |
| `createAgent` | `CreateAgentProduct` | 调用方先持久化创建意图；未知结果需核对，不能自动重新创建 |
| `uploadCode` | `UploadCode` | 获取上传地址；ZIP 单独 PUT 到对象存储，上传地址不能当下载地址 |
| `getUploadUrl` | `GetPresignedUrl` | 沿用旧客户端的上传入口；返回 Bucket/ObjectKey，可组成持久存储引用 |
| `forAgent(id).get` | `GetAgent` | 返回原始详情，可能包含凭证，只能留在 Node 侧 |
| `forAgent(id).update` | `UpdateAgent` | 固定 Agent ID，支持服务已有的环境变量增量更新 |
| `forAgent(id).instances/logs` | `ListInstances/GetAgentLogs` | 读取实际实例和日志，HTTP 成功不代表实例已就绪 |
| `forAgent(id).remove` | `DeleteAgent` | 软删除并保留审计，不联动删除共享代码包、镜像或日志 |

调用方必须从自己的部署回执取得云端 Agent ID；`forAgent` 只防止一次已选定部署的请求
意外覆盖到另一个 ID，不代替账号鉴权或本地来源校验。通用客户端依然拒绝创建、删除等
部署专用 Action。网络失败、429、普通 4xx/5xx 和重定向均不会触发写请求重试。
仅公开 KOP 明确拒绝内网账号时，沿用现有内网端点切换，并保留同一个追踪 ID。
也支持显式配置官方 AICP 内网 HTTP origin，与旧客户端相同；其他远程 HTTP 地址、
相似域名和非标准端口仍被拒绝。

2026-10-08 的真实预发探测发现：`UploadCode` 在公网入口、`GetPresignedUrl` 在公网及
内网入口均返回 `InvalidActionOrVesion`（API 版本 `2024-06-12`），尚未获得上传地址。
这是服务路由与 KOP 已发布 Action 之间的缺口，不能把源码中存在的接口当成线上可用。
冻结运行包上传仍未通过；独立验收镜像可继续使用已有 Container 创建流程验证平台连接。

## 新运行时的接入边界

首期部署使用已有的 `DeploymentType=Container`。Runtime Service 已支持自定义镜像、
镜像 `ENTRYPOINT` 和 `ContainerConfig.Command`，不需要为 Node/DSH 增加专用启动分支。
`agentengine-images` 负责固定 Node/DSH/Codex 依赖和启动脚本，Studio 负责调用既有接口、
冻结运行包、注入目标凭证和跟踪状态。

独立连通性验收镜像可内置无凭证的 ZIP。正式交付优先复用账号 KS3 上传及现有只读挂载，
使用共享基础镜像，不要求桌面用户安装 Docker；需实测权限、路径、摘要和重启后可读取性。
旧 SDK 的 Code 构建实际使用账号 AK/SK 直传 KS3，因此预签名 Action 未发布不代表必须新增
Server 上传接口。运行包保持私有，不沿用旧上传器默认的公开读 ACL。

现有 `ManagedRuntime` 固定的 Python 命令是另一条路径的限制，不是 Container 的限制。
本阶段不修改旧 ManagedRuntime，也不以改造 Server/Runtime Service 为先决条件；只有
实际联调证明现有合同不足时，才单独补齐对应缺口。

传输层已覆盖签名、预发路由、请求追踪、错误脱敏、无自动重试以及限定 ID 的操作测试。
这不表示部署页已经接通，也不表示真实云端创建、网关鉴权、资源绑定、持久卷、升级或
回滚已经通过。正式验收需要记录本地 Agent/Revision/Build、ZIP SHA256、云端 Agent ID、
镜像 digest、实例状态和真实运行结果。平台目前没有独立 Stop/Start Action，不能将删除
显示为“停止”。
