# P0/P1 目标覆盖矩阵

更新时间：2026-09-28。按用户最新指令，验收基线升级为官方最新 RC `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`。rc.1 记录保留为历史；未在 rc.2 重跑的门禁不得沿用为通过。去 KsADK 依赖不改变 Studio 直连 agentengine-server 的目标，Node Host 是该接口的客户端。

> **2026-09-29 升级**：DSH 基线已从 `dsh-v0.1.7-rc.2`（commit `477b4f4…`）升级到 `dsh-v0.2.0-rc.1`（commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`）。上方 rc.2 证据保留为历史对照；`make check`（83/83）、`make patch-check`（6/6）已在 0.2.0-rc.1 重跑通过，但 rc.2 上记录的资源 Agent admission、内存基线等 P0 证据尚未在新基线重跑，不得沿用为通过。

这张表用于防止把“页面能打开”或“原生 DSH 能对话”误报成 Studio P0/P1 完成。

| 目标要求 | 当前证据 | 状态 | 剩余工作或限制 |
| --- | --- | --- | --- |
| 完整阅读方案、KsADK Studio、官方 DSH | RFC 终稿、`reuse-inventory.md`、固定 rc.2 checkout 与源码核对记录 | 已完成 | rc.1 证据仅作历史对照 |
| 官方 DSH reuse inventory | [`reuse-inventory.md`](./reuse-inventory.md) 覆盖 Desktop、Host、Web、官方 UI、Remote、Profile、Dock、评测、观测、Channel、资源和插件市场 | 已完成（清单） | 各项运行验收按下表执行，未因列出清单而自动通过 |
| 官方 Web/Host 加载 Studio plugin | 固定 rc.2 profile 安装、authenticated boot index、Studio slots、Settings slot；rc.1 仅作历史对照 | 已完成 | 仍需保持 packed artifact 与 profile manifest 同步 |
| 只有一个 React runtime | 隔离 Desktop CDP 看到 1 page target、1 application root；生产包不暴露 React DevTools hook 或 `data-reactroot` | 未签收 | 需要官方支持的可观测 renderer 证据，不能由 DOM 根节点推断 |
| P0 真实会话创建、发送、流式、恢复 | 官方 Composer 实际 `session/prompt`；rc.1/rc.2 Web 与隔离 Desktop 均完成真实文本流、刷新/重启恢复 | 已完成（DSH 原生） | 绑定 Studio Agent 的执行仍未证明 |
| P0 Browser/Files/Cmd Dock | 官方 Dock 打开、关闭、刷新恢复；未启动系统浏览器 | 已完成 | 打包 release profile 尚需重复一次同口径 smoke |
| P0 loopback Host health/capability | 本地 Host health/bootstrap/capability、浏览器真实读取与 Agent catalog；rc.2 管理工具链复装后的能力/恢复/目录证据见 [`rc2-managed-host-capabilities-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/rc2-managed-host-capabilities-2026-09-27.json) | 已完成 | 无 |
| 真实 StudioSessionAdapter | `pnpm check`、Python focused suite、SDK subprocess → canonical → DSH node store、live KsADK run | 已完成（本地/协议边界） | 外部云模型、真实资源执行和审批 UI 仍不在此证据内 |
| 独立 fixtures + 官方 node store 映射 | rc.1/rc.2 probe 通过逆序历史、迟到终态、Goal 状态投影；独立 expected nodes；rc.2 `ctx.sessions.create({ agentPreset })` 已贯通 ClientSessions service、ISessions、SessionManager；客户端、Host preset 和 registry 合计 3 个测试文件 82 项通过 | 已完成（覆盖项） | 仍需把动态 Studio Agent Revision 映射为受 Host 校验的 DSH preset/provider；packed public client API 发布承诺仍需上游确认 |
| CanonicalEventEnvelope/P1 合同 | RFC §5、TS/ Python schema、watermark/idempotency/sequence/interaction/error/locus 字段与测试 | 已完成（草案/本地 conformance） | 对外 API 版本、服务端持久化和端云协作仍待冻结 |
| Agent、Revision、Resource、Build、Deployment 合同 | RFC §4、`cloud-api-gap.md` 与 Host routes；2026-09-27 rc.2 Host 探针在真实 Agent `resource-lifecycle-agent-e193611841b2` 上扫描 63 个 Skill 候选、导入 1 个 Skill，并绑定 1 MCP、1 知识库、1 记忆库、1 Skill Center，Revision r2→r4；2026-09-28 用同一真实 Revision 复核 DSH preset admission 检出 model/MCP/Skill/plugin 并 typed fail-closed，证据见 `rc2-resource-agent-admission-failclosed-2026-09-28.json`；资源卡片展示模型/MCP/Skill/Tool/知识库/记忆库/Skill Center 计数 | 部分完成 | 本地 Agent/Revision 资源绑定、MCP 探测和 Skill 文件预览/导入已验证；DSH 运行时资源激活仍未签收，Server 仍缺独立 Build、StopDeployment、Agent 级通用 ResourceBinding 等公开合同 |
| 云端 CRUD、绑定、部署、回滚 | Server 源码路由静态核对 | 未签收 | 需要带审计身份的真实集成环境及新增 Server API |
| Web、Node Host、Python Host、Browser guest、Harness 内存基线 | `memory-baseline.md` 及 `.scratch` JSON/日志；新增 rc.1 Web/Host 真实会话两批负载（3 warmup + 10 turns、追加 10 turns、官方 Dock）、Tool/Goal 真实负载切片，以及 rc.1/rc.2 官方 SDK 3+10 固定 session 重跑 | 部分完成 | Web/Host 真实会话 A/B、Tool/Goal 和 rc.2 Harness 窄负载已有 RSS/退出残留证据（JS heap 未取得）；Approval、Browser guest、Harness 同口径工具负载及完整残留门禁仍未完成 |
| 真实测试与复现证据 | `pnpm check` 54/54；`verify-dsh` 2/2；`verify-dsh-sdk` 2/2；`make ci`；`uv run pytest tests/studio tests/runtime tests/events -q` 312 passed、8 skipped（2026-09-28 重跑）；rc.2 preset/admission 84/84；`git diff --check`；隔离 rc.2 浏览器四个运行中心页面和会话 Agent 选择器冒烟 | 已完成（当前覆盖） | 完整 P1 cloud/memory 证据仍需补齐；资源型 Agent 准入未签收 |
| UI 快速创建的 Codex / KsADK 本地 Agent | 页面真实提交两份 Revision；Codex 与修复权限后的 KsADK 均 Build `SUCCEEDED`，SSE 均收到 `message.delta`、`message.completed`、`run.completed`；带唯一 marker 的结果见 `ui-created-codex-ksadk-e2e-2026-09-27.json` | 已完成（本地模型 + Tool） | 平台知识库/记忆库、MCP/Skill 运行激活仍需各自独立证据 |
| Agent 选择器与 Agent Teams | Agent 目录通过 DSH Connection `/agentkit` 控制通道返回真实 Host Agent；浏览器显示无 Agent、Codex、KsADK Harness 与 DSH Native 选项。`agent-team-profile`、Team、持久化、投影、工具、UI 与浏览器官方测试 116/116，官方 headless E2E 1/1；Studio 实际完成 `list_agents` 和 `spawn_teammate` 委派，复跑记录见 [`verification-rerun-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/verification-rerun-2026-09-27.json)；`Agents` → `打开绑定对话` 已通过 DSH Native Host canonical SSE 实测；当前页面 AX 核对见 [`agent-selector-session-scope-2026-09-27.json`](../../../.scratch/studio-dsh-native-2026-09-24/agent-selector-session-scope-2026-09-27.json) | 部分完成（DSH Native 目录/Teams/窄准入） | 无资源 dsh-native Revision 已改为会话级 `agents/ensure-preset` + `agentPresets.select`，首轮后锁定；带模型/Tool/MCP/Skill/知识库/记忆库的 Revision 仍会 typed fail-closed。选择不会重建左侧本地会话列表，也不是中途动态切换；Codex 当前因 provider 未注册阻塞，KsADK Host Teams lifecycle 当前 `authority_profile_unavailable`，因此不能声称 Codex/KsADK Agent 流或 Host Teams 默认可用 |
| 绑定 Agent 的官方 Composer 路线 | `docs/contracts/dsh-agent-preset-admission.md` 固定 rc.2 公开 `session/create.agentPreset`、`agentPresets.select`；Studio 已把无资源 dsh-native Revision 接到官方 session-scoped hero slot，并在真实 rc.2 Web Host 中验证 selector/锁定提示；资源型 Revision 保持 typed fail-closed | 部分完成且资源执行仍为 P0 风险 | 仍需动态 Revision provider、模型/工具/平台资源物化、真实 `agents/ensure-preset` 目录 Agent、首轮资源调用和恢复证据；禁止 DOM/bridge/sink 注入 |

## 当前结论

原生 DSH 会话、官方宿主加载、资源目录读取、适配器映射和本地控制面已具备可复现证据；
“选择一个 Studio Agent 后由该 Agent 的模型/MCP/Skill/知识库/记忆真实执行”还没有满足验收条件。
因此本矩阵和 P0/P1 报告保持 **未整体签收**，直到绑定 Agent 路线、云端合同和完整内存门禁都有直接证据。
