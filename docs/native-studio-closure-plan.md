# Native task closure and external-process protocol

Scope: local Studio task closure and a versioned external-process interface for
the existing Native npm packages. No Python SDK implementation, cloud platform,
publication, remote push or main merge.

## Acceptance

- [x] New Native Agent: explicit capability selection and visible limits; pure conversation remains valid.
- [x] Local tool catalog remains usable without the optional remote catalog, including web research.
- [x] Missing capabilities produce actionable feedback without repeated empty discovery.
- [x] Conversation termination does not claim verified task success; blocked, failed, canceled and unverified outcomes remain distinguishable.
- [x] Readable tool calls/results/errors and only actual provider-supplied display reasoning.
- [x] New Agent real-model official pi-durable research with checked sources.
- [x] New Agent real-model local file task with independently checked bytes and abnormal states.
- [x] Installed npm external process: versioned requests, durable request identity, status, event cursor, cancellation and restart/resume.
- [x] Public package dependency boundaries and focused compatibility checks.
- [x] Short usage/protocol documentation and evidence audit.

The existing modularization/standalone acceptance is a prerequisite, not proof of
these new product and protocol requirements. Claude Code handles the independent
process protocol; the primary handles Studio assembly/display and final review.

## 验收结论

证据见 [验收记录](./native-studio-closure-evidence.json)，外部进程用法见
[协议说明](./native-rpc.md)。实际模型使用本地已有的 deepseek-v4.1-flash 配置，
在隔离 Studio 中通过界面新建 Agent 并显式绑定工具，没有复制已有 Agent 充当新建验收。

调研任务读取官方固定版本的 README/spec，返回中文判断、限制和来源；
账本为 completed/unverified。人工核对了关键来源，未把模型自述当作独立语义验证。
文件任务经界面单次审批，实际创建 26 字节文件；外部读取和内部字节检查均通过。
通用语义检查仍为 not_run，所以整体是 partial，界面显示「部分已验证」。
另一次未及时响应审批的运行已经取消，未产生文件；未知写入没有自动重放。

定向检查分别为 Studio 37、发现机制 27、网页 50、Node/RPC 32、子任务 80 项通过。
最终文案修改另跑受影响的 6 项检查与客户端构建。安装验证使用真实内核、适配器和
全新 tarball 安装，对端为明确标注的受控 HTTP 模型服务，不宣称真实模型质量验证。

## 已知限制

- 调研耗时 6 分 3 秒，输入 224133 tokens；文件任务 4 分 45 秒。功能闭环已验证，
  尚不能据此宣称速度或 token 效率达标，需要另行做有基线的性能优化。
- 网页工件 URI 不自动授予 ArtifactRead/Search 权限；本次一次读取被拒绝后通过
  web_fetch 分页继续。分页可能重复获取网页，通用语义验证器仍未配置。
- 宿主文件快照可能包含并发修改和上级 Git 仓库变化，现已明确标注；它不是 Native
  修改归属的证据，文件工具回执和独立字节观察才是本次验收依据。
- RPC 是固定启动配置、单存储 owner 的本地进程接口。包保持 private；没有发布 npm、
  实际接入 Python、云端多租户、跨机器调度、推送或合并 main。
- 本轮变更未新增公共内容审计命中。修改过的文件中仍存在三条原有模式告警
  （IP 范围判断与拒绝 URL 凭证的测试），不把此次差量核对当作全仓秘密扫描通过。
