# 云端部署产品与镜像维护边界

目标是本地创建的 DSH Native、Codex、AgentKit Harness 使用同一套部署交互与管理入口。
当前 Node 传输和真实 Container 调用已有证据，部署页面编排、镜像目录消费、升级回滚和
完整持久化尚未完成。本文中的交互和目录接入是待实现合同，不能当作已上线功能。

## 身份与生命周期

Studio Node Host 使用用户配置的 AK/SK 对 KOP Action 签名。**签名成功不代表子账号
操作人已传递。** `X-Ksc-Account-Id` 表示资源所属主账号，`X-Ksc-User-uuid` 表示子账号
操作人；Server 读取后者，再传入创建订单的 `user_uuid`，最终创建回调将其持久化。
AK 同时用于签名及 KOP 公共参数 `Accesskey`；SK 仅用于计算签名，不放入请求正文。

2026-10-08 的独立预发测试确实请求了 AICP 内网 KOP Action 入口，但未发送
`X-Ksc-User-uuid`，首次失败 Agent 的 `Basic.Creator` 为空。同一套凭证的 IAM 只读核验
在默认账号密钥列表中命中当前 AK，`UserName` 为空；完整子用户密钥列表未命中，表明该
测试使用主账号密钥，不能从中推导其他子用户身份。模型凭证映射修复避开了自动申请 AICP
Key，不是子账号身份修复。详见[部署传输边界](deployment-transport.md)。

旧 KsADK 客户端已有 IAM 身份解析和身份 Header 传递，新版 Node 客户端尚未迁移此能力。
后续部署须验证当前签名凭证对应的操作人及账号一致性，不能手填或复用其他人的 UUID。
应明确区分主账号、已验证子账号和无法验证的身份，不将查询失败误判为主账号。
真实子账号的 Header、创建回调、数据库记录以及两个子账号的权限隔离均尚未验收；
不能将本轮容器连通性结果表述为子账号部署已通过。

三种运行时都走 `CreateAgentProduct(DeploymentType=Container)`、`GetAgent`、
`UpdateAgent`、`ListInstances`、`GetAgentLogs` 和 `DeleteAgent`。平台尚无独立停止/启动
Action，不将删除显示为停止。MCP/Skill 等绑定冻结在运行包中，不能通过旧 ComponentConfig
更新接口假装已经同步这些绑定。

## 用户操作

预期交互为：本地 Agent → 部署到云端 → 选择区域和规格、检查资源凭证 → 确认部署。
可直接使用当前 Revision 创建冻结 Build，也可选择历史 Build；确认页显示实际版本、
运行时、资源可用性与计费规格。用户无需输入 Docker 命令、镜像地址、KS3 对象路径或摘要。

创建后在云端标签展示可追溯至本地 Agent 的部署，提供状态、原生对话、日志、更新版本与
删除入口。上传、创建受理、实例启动、健康检查、失败分别反映实际进度。未知创建结果先
核对已有资源；升级保留先前 Build 和镜像引用。只有恢复历史、升级和回滚均实测通过后，
才开放对应操作。当前不能将这套预期交互描述为已验收。

## 一套共享镜像

`agentengine-images/deploy/studio-runtime` 维护一套共享镜像，内置固定 Node、DSH、Studio
和官方 Codex npm CLI。冻结包里的运行时字段选择对应适配器。每个 Agent 单独上传私有包，
无需重建镜像。Skill 的额外系统依赖需要另行声明并纳入受控镜像变体，不能在启动时任意安装。

发布流程：更新源码锁与依赖版本 → 构建不可变标签 → 验证三种运行时及沙箱 → 推送镜像仓库
并记录 digest → 预发真实资源/生命周期验收 → 发布环境与区域对应的推荐版本。
已有部署继续固定原镜像和 Build，不随推荐版本改变而静默升级。不覆盖同名版本标签。

## 复用 Server 数据库配置

Server 已有 `client_bootstrap_configs` 表与 `GetClientBootstrapConfig`，可以按产品、客户端、
运行时、环境和区域下发配置。Studio 应使用独立产品范围的镜像目录，复用此配置能力，
不硬编码最新标签，也不改变其他产品的默认镜像。镜像字节在 KCR，数据库保存推荐版本、
镜像地址/digest、支持的三种运行时、运行包协议版本、兼容 Studio 版本及启停状态。

当前验收脚本仍显式指定镜像；Studio 尚未消费该目录，也未更新服务器数据库配置。
已有 `runtime.catalog` 服务用于 ManagedRuntime 的解析，不直接套用其中的旧 Python
启动规则。这里继续采用通用 Container 合同；若所需元数据不能由现有配置接口承载，
以具体缺口补充合同，而不新增另一套运行服务。
