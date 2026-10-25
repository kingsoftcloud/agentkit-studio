# Native 迁移实现与验收对照

参考：`ksadk-python` 分支 `feat-ksadk-harness-2`，提交
`355059d78e47ed764bbdb3606304cdf34e9838a3`。目标分支 `feat-ksadk-harness`。
本表对照[原能力清单](native-reference-capabilities.md)的十组能力及产品入口，
区分已有实现、已有行为证据与尚未验收，不能把一项专项通过推广为全部组合完成。

以下核心文件相对于 `packages/agentkit-harness-core/src/`；Node 适配文件相对于
`packages/agentkit-harness/src/native/`；Host 文件相对于 `src/`。
“已有验证”采用已执行的[集中与增量记录](native-final-acceptance.md)和各专项证据，
本次没有重复全仓测试。核心契约与 Node 适配契约使用新的版本化格式，不兼容 Python 旧数据库。

| 原能力组 | 当前实现及组装 | 已有验证 / 明确边界 |
| --- | --- | --- |
| 1. 运行状态机、完整模型→工具→结果循环 | 核心 `machine.mts`、`kernel.mts`；Node `dsh-turn-runtime.mjs`；Host `host/services/native-harness.mjs` | 两条无开关的完整打包 Host 路径通过；Native 控制循环，维护版 DSH 负责 Session 和工具权限，见[执行边界](native-harness-migration.md) |
| 1. fork、通知轮次、不可逆终态 | 核心 `store.mts`、`background-notification.mts`、`child-runtime.mts` | `store.test.mjs`、`background-notification.test.mjs`、`kernel.test.mjs`；通知使用原身份与账本，不启动替代任务 |
| 2. 上下文构建、来源、摘要封存与回放 | 核心 `context-planning.mts`、`context-view.mts`、`context-contributions.mts`；Host `providers/native-context-sources.mjs` | `context-planning.test.mjs`、`context-view.test.mjs`、`studio-native-context-sources.test.mjs`；来源不授予执行权限 |
| 2. micro-compact、历史工具输出清理、工作集及读取预算 | 核心 `context-microcompact.mts`、`source-read-budget.mts`、`source-working-set-group.mts`、`artifact-request-capacity.mts` | [源码读取](native-source-read.md)、[Artifacts](native-artifacts.md)；清理投影，不改工具事实 |
| 2. 媒体、私有协议数据、执行和最终交付预留 | Node `model-media.mjs`、`model-replay.mjs`；核心 `deadline-delivery.mts`；Host `providers/native-task-policy.mjs` | [交付时限](native-deadline-delivery.md)、协议/媒体测试；不自动获取任意媒体 URL |
| 3. 工具元数据、模型披露、只读并行与预算 | 核心 `contracts.mts`、`configuration.mts`、`machine.mts`、`tool-input.mts` | Python oracle 与核心行为测试；写入、浏览器、审批调用保留串行边界，模型不获得 Host 私有控制元数据 |
| 3. 工具权限、审批、原 interaction 继续 | Host `providers/native-host-interaction.mjs`、`providers/native-dsh-tools.mjs` | `native-host-child-approval.test.mjs`、Host 权限拒绝及真实浏览器允许一次/拒绝写入；[浏览器证据](native-web-session.md)说明范围 |
| 3. 错误重试、连续错误终止、被打断工具及回执核对 | 核心 `tool-error-recovery.mts`、`tool-receipt.mts`、`recovery.mts`；Host `host/services/native-recovery.mjs` | [错误恢复](native-tool-error-recovery.md)、[工具恢复](native-tool-recovery.md)；未知副作用不自动重跑 |
| 4. 目标契约、独立验证、最终输出结构 | 核心 `task-contract.mts`、`verification.mts`、`final-submission.mts`；Host `providers/native-verification.mjs` | 验证/修复及真实进程丢失回执测试；模型声称或格式检查不能证明语义目标已通过 |
| 4. 交付 review、checkpoint、受限修复和输出续接 | 核心 `delivery-review.mts`、`output-recovery.mts`、`deadline-delivery.mts` | [交付 review](native-delivery-review.md)与对应进程测试；原模型/工具/时间预算不因修复补充 |
| 5. 前后台子任务、指导、取消、提升和审批 | 核心 `child-runtime.mts`、`child-control.mts`；Node `owned-child.mjs`；Host `providers/native-subagents.mjs` | 子任务实际 Host 与故障专项；[子工作区](native-child-workspaces.md)；核心取消 Promise 问题已修复并定向验证 |
| 5. 子任务/任务链预算、结果与通知 | 核心 `child-budget.mts`、`child-runtime.mts`、`background-notification.mts`、`store.mts` | 子预算、终态结算、父级通知及持久重开测试；父级账本拥有额度 |
| 5. 后台命令与空闲会话唤醒 | Node `local-background.mjs`、`background-command-port.mjs`；Host `host/services/native-background-watcher.mjs` | 真实 supervisor、进程退出和打包 Host 恢复，见[迁移记录](native-harness-migration.md) |
| 5. 活动资源恢复、浏览器恢复和纯推理接管 | 核心 `recovery.mts`、`browser-runtime.mts`；Node `dsh-turn-runtime.mjs` | 进程恢复/浏览器重观察专项；接管授权不适用于未知写入 |
| 6. Pre/PostToolUse、PreCompact、Stop 与 Context 来源 | 核心 `hook-runtime.mts`、`context-contributions.mts`；Host `providers/native-hooks.mjs` | [Hooks](native-hooks.md)、Host/Frozen 证据；回调结果不能决定审批、接受或扩展预算 |
| 6. operator guidance、边界 steer | 核心 `guidance.mts`、`machine.mts`、`kernel.mts` | `guidance-boundary.test.mjs`、取消/steer 优先级及跨进程专项 |
| 7. 命令去重、优先级、暂停恢复、CAS 与 lease/fence | 核心 `store.mts`、`machine.mts`；Node `sqlite-store.mjs` | 原 Python 命令排序 oracle、SQLite 并发与进程故障测试；Node 另有显式回执核对命令，不修改原优先级 |
| 7. 意图先提交、回执/状态/事件事务、未知结果 | 核心 `kernel.mts`、`store.mts`；Node `sqlite-store.mjs` | SQLite 实际进程中断、重开、旧 fence 拒绝、未知效果不重跑；不承诺外部副作用 exactly-once |
| 8. 单次模型请求、流式、finish reason、用量和重试 | Node `model-port.mjs`、`model-openai-chat.mjs`、`model-responses.mjs`、`model-anthropic.mjs`；核心 `retry.mts` | 三种协议与实际 HTTP；provider/malformed 预算分开，Retry-After 及原 continuation 有专项 |
| 8. 精确整数、Schema、MCP 结果和回放 | 核心 `model-json.mts`、`exact-integer-schema.mts`；Host `providers/native-mcp-schema.mjs` | 默认 Frozen 完整 Host 验证精确模型 Schema、MCP 副作用与重启；依赖维护版 DSH 数值传输契约 |
| 9. Workspace、文件约束、独立子工作区和受控合并 | Node `workspace-tools.mjs`、`workspace-editing.mjs`、`child-workspaces.mjs`；Host `providers/native-child-merge.mjs` | [子工作区](native-child-workspaces.md)、真实进程锁竞争及崩溃专项 |
| 9. Artifacts 存储/目录/分页/搜索与消费回执 | 核心 `artifact-runtime.mts`、`scoped-artifact-search.mts`；Node `artifact-store.mjs` | [Artifacts](native-artifacts.md)及对应进程/容量测试 |
| 9. Browser 连续页面、DOM/视觉、验证和释放 | Node `browser-workspace.mjs`；核心 `browser-runtime.mts`；Host `providers/native-verification.mjs` | [Browser](native-browser.md)、真实 Chromium/DSH 专项；这不替代 Studio 产品界面的交互验收 |
| 10. 本地对话、流式、历史、恢复、取消和审批接入 | Node `session-delivery.mjs`；Host `host/services/native-harness.mjs`、`host/services/native-recovery.mjs` | 默认 Revision/Frozen 完整 Host、持久会话及跨进程恢复；真实浏览器对话、审批、刷新活动前缀、取消和原运行收尾已验证，见[界面接入](native-web-session.md) |
| 10. 模型/工具/MCP/Skills/工作区与 Build 固定 | Host `agent-preset-admission.mjs`、`host/bootstrap.mjs`、`build-engine.mjs` | [默认策略与回退](native-default-runtime.md)；新 Revision/Build 默认 Native，旧 Frozen pin 不重解释 |
| 10. 自动化、定时、评测、Frozen HTTP 和 portable 部署 | Host `host/services/automation.mjs`；现有 Frozen/portable runtime | [自动化](native-automation.md)、[portable 工具](native-portable-tools.md)及打包 Host 专项；周期触发不重放未知 occurrence |
| 10. 托管命令、A2A 出入站、问答与人机审批 | Host `host/services/native-managed-kernel.mjs`、`providers/native-a2a-host.mjs`、`providers/native-a2a-inbound-server.mjs` | [托管执行](native-managed-kernel.md)、[入站](native-a2a-inbound.md)、[Host 决定](native-a2a-host-decisions.md)；生产 Server/线上认证与浏览器人工操作仍待验收 |
| 10. 事件、用量、诊断、Trace 与展示 | Host `providers/native-trace-projection.mjs`；现有恢复、A2A 和子任务面板 | 默认完整 Host Trace 路由通过；[A2A Session 观察](native-a2a-session-events.md)、[Skill 诊断](native-skill-events.md)；A2A 投递状态现已进入任务面板 |
| Node builtin 与本地/远程适配 | Node 工具目录、Host `providers/native-dsh-tools.mjs` 和 `providers/dsh-node-builtins.mjs` | [builtin 对应](native-node-builtins.md)；31 项普通及 3 项平台工具已有 Node 路径，Python fallback 已移除；不能以工具名相同证明全部线上后端已验收 |
| Skills 搜索/下载/工作流与配置 | Host Skill Service/GitHub 连接、本地/E2B Node 工作流 | [Skill 管理](native-skill-management.md)、[输入](native-skill-inputs.md)、[诊断](native-skill-events.md)；ZIP64 已补齐，其他格式/安全差异仍明确保留 |
| KB、长期记忆与回合写入 | Host AICP 连接、local Memory 与云 Memory 持久提交 | [AICP](native-aicp-connections.md)、[本地 Memory](native-memory.md)、[云提交](native-cloud-memory.md)；服务受理不等于抽取完成，未知提交保留原标识人工核对 |
| 无 Python 安装、执行，保留 DSH Native/Codex | 独立 TS 核心、Node 适配、维护版 DSH、Node builtin/Office | [安装](native-node-installation.md)；macOS arm64 Node 22/26 真实 Node-only 安装/Host 证据及真实 Codex CLI 回归；完整 Electron 和其他 OS 尚未证明 |

## 必须保留的差异与未闭环项

OpenAI Chat 的内嵌推理过滤已按参考实现补齐：GLM/Z.AI 和 KSPMAS
使用版本化策略，兼顾 Kimi Code 例外、跨 chunk 标记、非流式和未闭合推理段。
新 Run 保存策略及兼容指纹，恢复沿用原策略；没有策略的旧 Run 保持原行为。
`KSADK_MODEL_COMPAT_RULE` 在 Host 准入时解析，不在请求或恢复中重新读取。
厂商 thinking/effort、压缩专用策略、required tool choice、usage 和私有回放清洗
已进入实际请求及冻结配置，25 项定向检查通过，见[模型请求兼容](native-provider-compatibility.md)。
该页保留长流 idle 续期、独立 thinking 显示及其余高级投影差异，不能宣称逐项无损。

1. **Studio 浏览器流程**：普通对话、允许/拒绝、历史重开、刷新活动流、取消和原运行
   收尾已有[真实浏览器证据](native-web-session.md)。远端问答、子任务控制和其他错误
   组合尚未全部实际操作，不能从已覆盖路径推广为产品 UI 全部完成。
2. **可选线上后端**：E2B 成功执行、重连/清理，以及真实云 Skills/KB/Memory、正式
   Server/Gateway 认证和互操作仍缺完整线上证据。Node SDK 和确定性 HTTP 路径已有实现；
   连接被拒绝的测试只能证明错误和恢复边界。
3. **格式与安全差异**：GitHub 重定向限于公开 HTTPS origins；YAML 别名展开和归档
   有界，符号链接/冲突路径等被拒绝。ZIP64 已不再是缺失能力。这些差异不能悄悄写成逐项无损。
4. **平台与持久后端**：完整 Electron、其他 OS、共享 managed 存储、跨 Host 永久订阅和
   Server recovery scanner 仍未闭环。参考 Native RunStore 位于 `ksadk/harness/stores/`；
   `ksadk/kernel/postgres_store.py` 是 Server/AgentKernel 存储，不能把它的缺失说成
   Native 状态机缺少事务，但现有实现也不能宣称具备共享 Server 的部署能力。

默认切换已经完成。上述事项没有全部关闭，因此当前结论仍是**迁移主干已实现，完整无损交付尚未证明**。
旧 Python 数据库、序列化字节、历史摘要算法不在本任务兼容范围；原 Native 本身不支持的
inject、checkpoint/time-travel 和任意 resume.input 也不作为新增要求，依据见原能力清单。
