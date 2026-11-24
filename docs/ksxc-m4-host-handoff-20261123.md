# KSXC Studio M4 Host 交接（2026-11-23）

## 交付范围

- 仓库：`kingsoftcloud/agentkit-studio`
- 分支：`feat/ksxc-studio-v2`
- 当前提交：`bcb273b9dba5dc0a9a918f78a9dea8e2caf5fd87`
- `upstream/main`：`4fea9a2f932b61739215be69ebe7c897dc138400`，已在当前提交祖先链中
- 远端分支：`origin/feat/ksxc-studio-v2` 与当前提交一致
- B 服务端功能分支只读核实：`feat/ksxc-cloud-v2` 当前 `eaa26d627f8eb1826ea8ab17c8b706c62d0e4e79`

本次只提交 Studio Host 交接文档和证据索引，没有改动 B 的服务端工作树。

## 本机 WPS 授权链路

- `kc` 配置通过 `http://mgw.proxy.ksyun.com` 访问 KSCC。
- `GET /kscc-web/auth/login/url?companyCode=kc` 返回 HTTP 200、业务 `code=200` 和非空登录 UUID。
- 未完成授权时 `login/result` 返回 `code=200/status=pending`，轮询合同正常。
- 当前 Chrome 新授权回调返回 KSCC XML `500 服务异常，请稍后再试`，因此本轮本机 Host 使用既有的 0600 授权记录恢复 WPS 账号。Studio 设置中实际显示 `1.8.0 · 已启用`、`夏雨 · kc`，KSXC Agent 创建页能读取企业模型 `kscc`。
- 本文不包含 WPS 登录链接、Cookie、SK、AK 或授权文件内容。

## Studio 本地 M4 证据

- 本地 Agent：`ar-local-db72c8e06e7b4265`
- 名称：`KSXC M4 A`
- Build：`build_f80567a94e8caaaff66c`
- Revision：`1`
- Runtime：`ksxc`
- 绑定模型：`kscc`
- 本地 Studio UI 创建并构建成功。现有本地 WPS 凭证重启后仍可复用。
- 本轮工具目录为空，因此没有把空工具目录误记为工具验收通过。

## 云端真实创建证据

使用当前 Host 的签名 `CreateAgentProduct` 路径，在 `pre-online/cn-beijing-6` 真实创建了一个 KSXC ManagedRuntime。只保留非秘密标识和状态。

- 云端 Agent：`ar-20261123132019-e0ff52db`
- Instance：`e0ff52db-c4b1-4db3-b121-0685a400e263`
- Instance 查询结果：`Pending`
- Create 回执：HTTP/业务成功，返回有效 AgentId 和 InstanceId
- Runtime：`ksxc`
- RuntimeVersion：`1.7.1-studio.0.0.22-2735f924-relay.3`
- Image digest：`sha256:48a78ae863e0daaed164265a6697286a252399b5bd4b5c5d26a97dc3a163fe9f`
- Storage：20 GiB，挂载 `/home/node`
- GetAgent 当前状态：`CREATING`，`ReadyReplicas=0`
- DeploymentPhase：`PENDING_KERNEL_REGISTRATION`
- DeploymentState：`DesiredVersionId` 已产生，`ObservedVersionId=null`，`Ready=false`
- 平台错误：`TARGET_NOT_READY / Target runtime version has not become ready`
- `/health` 和 `GetAgentUiBootstrap` 在实例未就绪时无法连接。

这证明 Studio Host 已把真实托管创建请求送到 KOP 并得到平台资源，但不能把当前预发实例写成 Ready 或端到端对话通过。

## 云端更新与清理状态

- 对同一 Agent 的 `UpdateAgent` 已按当前 Agent、更新后的提示词和固定 RequestId 发起，平台返回 HTTP 409。原因是实例仍处于 `CREATING`，必须先让目标 Runtime 版本就绪。
- 对同一 Agent 的 `DeleteAgent` 也返回 HTTP 409，平台不允许在当前创建阶段删除。该云端记录需要 B/环境负责人处理，不能通过重复请求绕过。

## Catalog 结论

当前云端 `GetClientBootstrapConfig` 返回的 KSXC release 是：

- `1.7.1-studio.0.0.22-2735f924-relay.2`
- `1.7.1-studio.0.0.22-2735f924-relay.3`

当前 Studio Host 解析器会正确接受 KSXC 合同：`runtimes:["ksxc"]`、`bundleFormat:"agentengine.dsh-manifest/v1"`。截图中的 Dashboard 将两条记录标记为非法，是 Dashboard/Server 目录校验器仍只允许 `dsh-native / harness / codex` 和 `agentkit.portable-bundle/v1`，与 Studio KSXC RFC 合同不一致。

这不是 1.8.0 目录。`1.8.0` 目前只在本机 KSXC release catalog 中可见，云端预发目录没有发布 1.8.0 image。要切到 1.8.0，需要 B/环境侧发布对应不可变 image、更新 catalog default 和 Dashboard validator，再重新创建托管实例。

## 测试证据

- 定向 Host/KSXC/部署测试：`71 passed, 0 failed`
- 完整 Studio 测试：`5517 tests, 5514 passed, 1 failed, 2 skipped`
- 唯一失败：`tests/dsh-node-browser-tools.test.mjs`，本机没有真实缓存 Chromium，测试要求 `AGENTKIT_NATIVE_TEST_CHROMIUM` 或缓存浏览器。该失败与 KSXC Host 代码无关。
- `pnpm test` 的依赖检查和客户端构建均通过。

## M4 未关闭项

1. 预发 KSXC 1.8.0 catalog 和 Dashboard KSXC metadata 校验仍由 B/环境侧修复。
2. 当前真实创建的 1.7.1 relay.3 目标未 Ready，平台拒绝 Update/Delete，无法继续真实云端更新、会话、工具和审批验收。
3. 双真实 WPS 用户验收未完成，本机只验证了一个授权账号的持久化复用。不能把本机隔离测试替代成双账号共享 Server 证据。
4. 云端实例需由环境负责人在目标 Runtime 恢复后清理或继续验收，Studio 不会重复 CreateAgentProduct。

## B 接手动作

- 修复 Dashboard/Server catalog validator，允许 `runtimes:["ksxc"]` 和 `agentengine.dsh-manifest/v1`。
- 发布并启用实际的 KSXC 1.8.0 Linux/amd64 digest，设置正确 `defaultReleaseId`。
- 确认 `PENDING_KERNEL_REGISTRATION` 的目标 Runtime 发布到预发，再按同一 Agent 的当前 `ExpectedVersionId` 重试 Update。
- 平台确认创建中的 Agent 可删除后清理 `ar-20261123132019-e0ff52db`，或明确继续使用它做 M4。
- 提供第二个已获准的 WPS 企业测试账号和共享 Server 入口后，再完成同 Agent、双用户、同会话、工具批准/拒绝和解绑后的新消息拒绝验收。
