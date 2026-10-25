# Native Harness 迁移交接

目标分支为 `feat-ksadk-harness`。Python 行为参考固定为 `ksadk-python` 的
`feat-ksadk-harness-2` / `355059d78e47ed764bbdb3606304cdf34e9838a3`。
没有旧 Python 会话或数据库迁移要求。

## 当前可交付内容

- `packages/agentkit-harness-core/`：不依赖 Studio UI 或 DSH 对象的 TypeScript
  Native 状态机、完整执行循环、预算、重试和恢复契约。
- `packages/agentkit-harness/src/native/`：Node 模型协议、SQLite、Workspace、
  Artifacts、Browser、子任务和其他端口。
- Studio Host：复用 AgentKit Harness 产品入口及 `runtime.type = "harness"`，
  接入对话、流式事件、历史、审批、取消、自动化、Frozen Build 和观察面板。
- 新 Revision / Build 默认 Native；旧 Frozen 引擎 pin 保留。
  DSH Native 和 Codex 继续走各自的执行路径。

Native 管理完整模型→工具→结果循环；DSH 提供 Session、工具权限、宿主服务和展示。
Native 的持久化 Run 与 DSH 的产品会话各有职责，不由两个引擎重复执行同一回合。
普通 builtin 的 Python fallback 已移除，安装及执行使用 Node，不需要 Python 或 uv。

## 安装与启动

开发环境按[入门说明](getting-started.md)运行 `make setup` / `make dev`。
需要仓库维护的 DSH 源码和补丁；固定来源见
`patches/dsh-v0.2.1-rc.2/source.json`，当前维护提交为
`c7e4398390cdd0cf2604ce48acd40d84bd896068`。同版本的公开 DSH npm 包缺少所需
宿主接口，不能替代维护包；能力不足会拒绝准入。

独立归档安装、维护 Host 包导出和已验证的 Node 版本见
[无 Python 安装](native-node-installation.md)。部署使用根目录 Studio 包，包含
TS 核心产物和 Node 适配层；`pnpm pack:harness` 只打包旧有独立 facade，不能
用它单独安装 Studio Native 引擎。正式归档的 `prepack` 会构建核心和客户端。

在 Studio 配置模型及凭据，新建使用 AgentKit Harness 的 Agent，绑定需要的工具、
MCP、Skills 和工作区后开始对话。无需 Native 启用开关。凭据在可信 Host 解析，
不写进 Build 或复制到代码仓库。现有桌面发布包不自动包含本分支的迁移。

## 切换与恢复

[默认策略](native-default-runtime.md)说明 `AGENTKIT_STUDIO_NATIVE_HARNESS`：
未设置或空值选择 Native，`legacy` 回退新准入的默认引擎。切换后重启 Host。
该选项不转换已有 Run，也不改变已有 Frozen Build 的引擎身份。

恢复使用原 Session、Run、版本化 ownership 和原配置。外部副作用执行前保存意图，
结果、状态和事件按明确事务提交；进程中断后结果未知的写入不能自动重跑，也不能
新建替代任务伪装恢复。核对原操作并使用对应恢复控制，见
[恢复边界](native-harness-migration.md)、[工具恢复](native-tool-recovery.md)和
[云记忆核对](native-cloud-memory.md)。

## 证据和交付结论

[能力对照](native-capability-status.md)是当前实现、证据及差异的主表；
[参考清单](native-reference-capabilities.md)保留正式、可选和历史兼容分类。
[集中验收](native-final-acceptance.md)列出实际命令、初次失败、修复及定向复查，
不能把历史检查冒充为最终提交整套全绿。

已有证据覆盖确定性行为对照、并发/取消、真实进程故障与数据库重开、未知副作用
不重放、无 Python 的真实安装/Host 执行，以及 DSH Native/Codex 相关路径。
默认 Revision 和 Frozen Build 的完整挂载 Host 路径已通过。

**迁移主干已实现并默认启用，完整无损交付尚未证明。** 剩余事项明确保留：

1. Studio 的对话、允许/拒绝、历史、流式刷新、取消和原运行收尾已有
   [真实界面证据](native-web-session.md)；子任务指导、转后台、结果、停止、历史保留和
   远端问答允许/拒绝也已闭环，未穷举嵌套组合。
2. 可选 E2B、云 Skills/KB/Memory 和正式 Server/Gateway 的完整线上互操作缺少证据。
3. 有界 YAML、归档路径和公开 HTTPS 重定向策略与 Python 保留差异，见能力主表。
4. 完整 Electron、其他 OS 和共享 Server 部署能力尚未闭环；Server/AgentKernel
   扩展不能直接算作 Native 核心缺失，也不能宣称当前实现已经提供它们。
5. 内嵌推理、OpenAI 请求兼容、长流 idle 续期和独立 thinking 显示已补齐并冻结
   到 Run 配置；高级 Anthropic 指令/回放投影已接入并通过 10 项本地定向检查，
   正式供应商互操作仍待线上证据，见[模型请求兼容](native-provider-compatibility.md)
   和[流式等待](native-stream-timeouts.md)。

剩余事项不作为继续扩大本地回归轮次的理由；后续只处理具体能力缺口及对应证据。
