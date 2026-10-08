# Container 预发首次连通验收（2026-10-08）

通过原有 `CreateAgentProduct`、`DeploymentType=Container` 创建独立测试 Agent，镜像入口
成功启动 DSH Host；真实 Gateway 鉴权、模型调用、文本流、系统提示词盲测和 token 用量通过。
本轮未修改 AgentEngine Server 或 Runtime Service 代码。此结果仅覆盖 Harness 的无资源
绑定用例，不代表三种运行时及完整部署生命周期均已验收。

## 固定输入

- 镜像中的 Studio：`51834d7938daee05d1c023752d4d700b88a9ec4e`。
- DSH：`639ed015397290b3745d163aafe02ffee4aa3f84`，版本 `0.2.0-rc.2`。
- Node `22.19.0`，官方 Codex npm CLI `0.159.2`；基础镜像平台 `linux/amd64`，非 root 用户。
- 独立 canary 标签：`studio-canary:0.0.1-51834d7-harness-20261008`。
- Registry digest：`sha256:6b22f35622988646ec64720482d876cde8ca5e12f01f7b3c0b9ac6986b4eeb78`。
- ZIP SHA256：`cf2823fcd0e7d47945bcd2abbe3ebd8b22d26653c2b751b138ceda7306fc0a73`。
- CPU 2、内存 8 GiB、单副本；模型为冻结运行包绑定的 GLM-5.3-Flash / Kspmas。

验收镜像内置无凭证的冻结 ZIP，凭证仅通过运行环境注入；没有覆盖共享默认镜像。
部署端调用新的 Node 环境映射助手，容器仍使用以上固定版本。完整创建回执、云端 Agent ID、
原始 SSE 和日志保存在本机受保护的验收目录，不写入仓库。

## 实测结果

| 项目 | 结果 |
| --- | --- |
| 创建 | `CreateAgentProduct` 受理，最终 `RUNNING`、ReadyReplicas `1/1`，实例列表数量为 1 |
| 镜像入口 | 云端日志记录 bundle ID、Build ID、SHA256、DSH 版本，与冻结输入一致 |
| 凭证更新 | `UpdateAgent.EnvironmentVariablePatch` 将 Host 入口令牌与平台 API Key 对齐 |
| 未授权请求 | Gateway 返回 HTTP 401 |
| 正常调用 | HTTPS `/v1/responses`，普通问候，9 个文本增量帧，约 1.5 秒收到首个文本，约 1.7 秒完成 |
| 系统提示词 | 仅写在系统提示词中的核验前缀出现在回答中，用户消息没有身份提示或核验前缀 |
| 用量 | input 758、output 97、total 855 tokens |

控制面的 `DeploymentPhase` 仍显示 `PENDING_KERNEL_REGISTRATION`，但实例已经就绪并完成
真实调用。Container 的上线判断应结合实例状态和数据面探测，不能单靠旧 Kernel 注册字段。

## 联调修复与证书条件

第一次请求只带 Studio 的模型凭证变量，控制面误判为未提供模型 Key，尝试自动申请 AICP
Key 后被账号限制拒绝。已在 Node 部署端把冻结默认模型的同一个 Key 同步映射到
`OPENAI_API_KEY`，保留原模型名称、地址和原始凭证引用，第二次创建成功。未新建模型 Key，
未改账号身份，未修改平台策略。第一次失败的 Agent 已删除并确认 GetAgent 返回 404。

预发 Gateway 当前使用私有 CA 签发的证书，默认 Node 信任库拒绝该证书链。本次通过
**开启 TLS 校验的 Kubernetes API** 读取 Gateway 配置的证书链，核对服务器证书指纹，
再仅为测试进程配置 CA。未关闭 TLS 校验、修改系统信任库或替换预发共享证书。
证书未被默认信任的问题仍需通过受控 CA 分发或环境证书配置解决，不能宣称默认客户端可直连。

## 未覆盖

- 共享基础镜像配合私有运行包上传/下载及只读挂载；当前为专用验收镜像内置 ZIP。
- Studio 部署页、部署回执驱动的云端 Agent 列表和原生远程会话。
- DSH Native、Codex 在预发的真实模型调用及所有运行时的资源绑定。
- PVC 权限、重启后的会话恢复、跨副本路由、升级和回滚。
- Linux Skill 命令沙箱；本机 Docker 的完整 DSH 沙箱检查仍为 `SANDBOX_UNAVAILABLE`。

本轮不将候选镜像设为全局默认。平台没有独立停止 Action，测试结束使用限定 Agent ID 的
软删除，不联动删除共享 KS3、KCR 或日志。成功 canary 的删除回执确认 `deleted=true`、
`deleted_resources.runtime=true`，随后 GetAgent 返回 404；两个本轮测试 Agent 均已清理。
平台订单退订的独立账单状态不在该回执中，本轮没有将删除回执扩大为账单核销证明。
