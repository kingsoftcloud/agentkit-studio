# 共享预发控制面版本复查

2026-10-09 继续验证 DSH / Codex 知识库绑定的升级与回滚时，发现共享预发 Server 已更换版本。
这次切换中断了资源升级回滚验收。原有通过记录仍是对应候选版本的历史证据，不能代替当前环境检查。

## 已核对的事实

1. 通过已核验子账号创建新的 DSH 测试部署时，私有包上传成功，KOP 创建失败，部署保持
   `CREATE_UNKNOWN`。没有自动重试创建。随后按唯一名称查询以及同账号、同名称的只读数据库
   事务查询，均未找到 Agent；仍保留待确认记录和独占私有包，避免误删可能被异步创建使用的来源。
2. Server 两个新 Pod 的启动时间为 `2026-10-08T22:42:19Z` 和 `22:42:39Z`，与这次请求
   处于同一时间窗。实际镜像摘要为
   `sha256:e75f5014b163b830994f13e19e433c06bc7fcb1877e34b1cfef80bda5ccd6c8a`。
   时间重合只能说明存在发布切换，尚未证明创建失败的具体原因。
3. KOP `GetClientBootstrapConfig` 成功响应缺少 `Capabilities`。部署容器中 bootstrap
   源文件摘要与 `origin/master` 相同，均没有 `ContainerStorage` 声明。
4. Codex 的默认 20 GiB 持久化部署在预检查阶段返回 `DEPLOYMENT_STORAGE_UNAVAILABLE`，
   未提交 Codex 创建请求，也没有为了继续测试改成临时存储。
5. `origin/feat/studio-cloud-operations` 的 `8da629cb` 包含当前 `origin/master`，并多出
   8 个提交；适配已经推送，但尚未合入主线。本轮未修改共享预发镜像、节点安全策略或日常 Host。

## 待发布的适配范围

| 提交 | 内容 |
| --- | --- |
| `da613ba3`、`15031646` | Studio Responses 调度及旧运行时准入边界 |
| `9c281929` | 调度预发证据与 KOP 门槛记录 |
| `21fd3460`、`b44e4c24` | 显式 Container 存储保留、能力声明及三运行时持久化证据 |
| `394439d3` | Runtime 已恢复 Running 时清理旧更新 phase |
| `33f5d728` | 保存调度最终文本并通过 Channel Outbox 投递 |
| `8da629cb` | 下游删除结果未确认时保留 Agent 和关联资源 |

推荐先将这些适配纳入主线发布，再继续验收；临时候选镜像必须与共享环境的发布方确认使用范围。
调度投递还依赖 Channel API/Worker、私有连接配置与 additive schema migration；回滚不删除已有表列。
仅切 Server 镜像仍不能代替 KOP 七个调度 Action 的发布及 IAM 配置。

发布准备复查：Studio `make check` 519 项通过、`make pack` 通过；Server 适配分支的
存储能力、产品创建、Responses 调度、结果投递与删除保护定向测试 70 项通过。
这些是本地回归检查，不表述为当前预发已恢复。

## 恢复后的验收顺序

1. 经 KOP 核对 `Capabilities.ContainerStorage` 为 `agentengine.container-storage/v1`，
   覆盖 Harness/Codex Framework；实际创建详情须保留所选 Storage。
2. 核对 `ListAgentSchedules.Availability.RuntimeContracts` 包含 `agentkit.responses/v1`，
   指定渠道投递时另核对 `DeliveryContracts` 和真实连通性。
3. 先重新核对本次 `CREATE_UNKNOWN`，不重新提交原创建请求；确认唯一实例后继续或清理。
4. 分别验证 DSH 和 Codex 的“仅绑定知识库 → 升级解绑 → 回滚恢复”。每阶段使用全新会话，
   验证实际入口包身份、未出现在输入/配置中的知识库标记、流式文本和用量。
5. Codex 命令/脚本能力仍需独立通过 Linux 沙箱门槛，不从知识库文本成功外推。

原始请求回执、源码摘要、Pod 信息和只读查询证据保存在隔离私有目录；本文件不包含凭证、
账号标识、内部服务地址或用户内容。当前保留的私有包不计为清理完成，未核验最终账单。

## 后续环境恢复

同一轮后续只读复查发现，共享预发又切回已验收候选
`sha256:ad67e1226b8d6f14addbad5db314016fd562ce4506a29a638c33be455003225b`，
两个副本均就绪，KOP 再次返回正确的 `ContainerStorage` 合同。本任务没有执行这两次发布。
环境恢复后可以继续使用候选联调；适配仍需纳入主线，避免下一次主线发布再次丢失能力。
未直接重发此前结果不明的 DSH 创建请求。

恢复后新的 Codex 测试 Agent 已通过知识库绑定、升级解绑、回滚恢复和持久卷保持验证，
并完成实例、卷及 3 个独占私有包的清理，详见[资源版本补验](cloud-resource-isolation-2026-10-09.md)。
DSH 原创建再次核对仍为待确认，未删除其独占私有包。恢复后的 KOP 调度查询仍返回
`SERVER_ACTION_NOT_REGISTERED`，不能将候选恢复视为调度产品入口已开放。
