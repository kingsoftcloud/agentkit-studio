# DSH Python SDK 运行时接入决策

## 结论

### rc.2 本地验证更新（2026-09-25，历史 KsADK adapter 证据）

本地验证已切换到官方 `dsh-v0.1.7-rc.2`（commit
`477b4f420553e8a52c2fbccc464d7561b239c443`），并保留 rc.1 作为历史验收基线。KsADK
此前的本地验证由 KsADK Host 使用 `DSH_RUNTIME_MODE=node` 驱动官方 rc.2 Node runtime（这是本地开发条件，生产
应使用与版本锁一致的 runtime-bin），管理工具链安装在独立的 rc.2 toolchain home。

rc.2 的真实 bound-Agent vertical slice 已跑通：Build `build_f4d6732d82960b3bc1b2` 的
`runtimeLock.version` 为 `0.1.7-rc.2`；Host 先产出 `run.created`/`run.started`，随后
官方 DSH SDK 事件经 `DshNativeRuntimeAdapter` 投影为 29 条 canonical session events，
最终 `run.completed`，assistant 文本为 `rc2-ok`。验证同时暴露并修复了两个真实问题：

1. Studio 的 provider-neutral `openai-compatible` 不能直接传给当前 SDK；dsh-native
   launch projection 现在固定发送官方协议要求的 `deepseek-official`，模型 catalog 中
   的 provider 仍保留原值；
2. Studio 设置页写入的 workspace credential 与旧版 `~/.agentengine/settings.json`
   全局模型配置现在都会在 Host 进程内按 allow-list 投影为 `DEEPSEEK_API_KEY`，不会进入
   Agent bundle 或浏览器状态。无凭证时仍 fail closed，返回 DSH 原生的 missing credential
   错误；使用无效测试 key 时会继续到模型网关并返回 `unauthorized consumer`，证明 key
   已进入 DSH provider，而不是被静默丢弃。

这条历史证据只证明 rc.2 的真实 DSH SDK → Host adapter → canonical stream 链路和凭证投影，
不改变下文关于资源绑定、审批、取消/恢复以及官方 composer AgentPreset admission 尚未
关闭的结论。

`deepseek-harness-sdk` 是接入 DSH Native Harness 的候选官方传输层，但不是
AgentKit Studio 的完整 Runtime Adapter，也不能把当前的 KsADK canonical Session
合同自动变成 DSH Session 合同。

首期保留两条清晰路径：

1. **无 Agent · DSH 原生会话**：在 Studio 使用的 DSH Host 内直接走官方
   `session.prompt`。这条路径不调用 KsADK `CreateSession/RunAgent`，也不需要桥接。
2. **绑定 Studio Agent · DSH Native Harness**：由 Studio Node Host 根据 Agent Revision
   编译 DSH profile/preset，必要时通过官方 Python SDK 启动一个独立的 DSH SDK
   runtime。SDK runtime 的事件再由 Studio Host 写入唯一的 canonical Session，Studio
   UI 从 canonical snapshot/tail 投影到 DSH node store。Agent Catalog、资源目录和
   云端会话控制面由 Studio Node Host 直接调用 `agentengine-server`；这不要求本地
   安装或启动 ksadk-python。

因此需要区分两个容易混淆的“桥接”：

- **不再需要的桥接**：在 DSH Web Host 内拦截 `SessionController` 或 `InputHub`，
  把一个带标签的 prompt 改发到 KsADK `RunAgent`。这只是当前外部 KsADK proof 的
  临时 seam，不能成为 DSH Native 默认路径。
- **仍然需要的适配**：AgentKit canonical Session 与 DSH SDK runtime 之间的
  Host adapter。它负责 Revision 装配、事件 identity/seq 映射、取消/恢复、
  interaction 回传、重启接管和 canonical 持久化。它不应侵入 DSH UI Session
  Controller，也不应让 renderer 直接读取 KsADK 私有字段。

## 已确认的 SDK 能力

固定 DSH commit 的 `python/sdk` 提供：

- `deepseek-harness-sdk` Python 包和同版本 `deepseek-harness-runtime-bin`；
- `dsh --profile sdk` 子进程；newline-delimited JSON-RPC over stdio；
- `initialize(provider, model, reasoningEffort, maxTokens)`；
- `session/prompt(sessionId, contentBlocks)`；
- `session.event` 与 `session.status` 通知；
- Python client 有 `IncomingRequest`/`respond` 接口，传输层也能解析服务端请求；但固定
  DSH `0.1.7-rc.1` 的 SDK 协议文档明确写着服务端目前不会发这类请求。因此它是未来
  审批/交互回传的扩展点，不能把当前版本当成已经打通的 HITL 能力；审批仍需走 Host
  的现有 interaction 合同；
- profile patch 和独立 `DSH_HOME`。

### 已完成的 SDK 真实 smoke

固定 checkout 自带的 `python/sdk/tests/manual_sdk_agent_smoke.py` 已在无真实模型密钥的
本地 mock SSE 服务上跑通：

```sh
uv run --project python/sdk python python/sdk/tests/manual_sdk_agent_smoke.py --repo-root .
```

结果同时证明了 `initialize`、`session/prompt` 入队、`session.event`/`session.status`
收流、最终 assistant 文本聚合、模型请求的 API key/base URL 传递，以及 DSH zstd
Session 日志落盘。它使用的是 DSH 官方 SDK profile 和 mock 模型端点，不证明真实模型
凭证、Studio Agent Revision 资源绑定、KsADK canonical 写入或浏览器恢复已经完成。

SDK 的已知限制也必须保留在设计里：

- 初始化的 provider/model 是 runtime 级参数，不是当前协议里的每个 Session 独立
  Agent Revision 选择；多 Agent Revision 需要独立 runtime、扩展协议，或在 DSH
  preset 层实现明确的路由；
- `session/prompt` 返回的是入队 message id，不是一个带 Run 状态的命令回执；
- 当前协议没有独立的 per-session close 或 prompt-cancel 方法；
- SDK 事件是 DSH `SessionEvent`，不是 KsADK `RuntimeEvent`，不能直接当作评测、
  观测、Channel 或云端 Session 事实源；
- 运行时的 MCP、Skill、知识库、记忆库来自 profile/preset 组合，SDK 不会读取
  `~/.agentkit` 并自动完成绑定。

## 官方 composer 的 Agent 路由缺口（P0 未关闭）

这不是 Studio 页面没有调用某个函数的问题。rc.2 已把官方 wire 的 `agentPreset` 通过
`ctx.sessions.create` 暴露出来，但它仍然只接受 DSH Host 已注册的 preset；固定的公共
client contract 仍没有把 Studio 的 Agent Revision 动态映射为可校验的 DSH composition，
也没有把官方 composer 接到 Studio 的 `conversation:stream` 路径。源码证据固定在官方
checkout：

| 位置 | 事实 | 对 Studio 的含义 |
| --- | --- | --- |
| `packages/api/session-controller/src/client/contract/sessions.ts` + `src/client/sessions/manager.ts` + `src/client/sessions/service.ts` | rc.2 `ctx.sessions.create` 在公开 service、接口和 manager 三层接受并透传可选 `agentPreset`；41 项客户端 + 8 项 Host 合同测试通过 | DSH Client 已有合法 preset 入口，但它仍不认识 Studio AgentRevision |
| `packages/api/session-controller/src/commands.ts:105-143` | Host command 接受可选 `request.agentPreset`，并交给 DSH `AgentPresetRegistry` | 该字段只识别 DSH 注册的静态 preset，不等于 Studio `AgentRevision` 或其资源绑定 |
| `packages/client/ui-conversation/src/client/input/hub.ts:200-208` | 官方 InputHub 的唯一 sink 无条件调用 `conversation().sendSession(...)` | Studio 插件没有合法的公开输入接管点来改发 `conversation:stream` |
| `agentkit-studio/src/client.js:147-162` | Studio 保留了类型化 `streamAgentConversation` Host route | 这是未来 admission/provider 合同的窄适配入口，目前官方 composer 不会调用它 |

因此，下列结果**不能用来验收“绑定 Agent 已执行”**：

- 会话上下文显示了某个 Agent 名称；
- `ClientSessions.create` 的底层 wire 请求带了一个 DSH preset；
- DSH composer 返回了正常的 assistant 文本；
- Studio Host 暴露了 `streamAgentConversation`，但没有一条公开 DSH admission/provider
  路径调用它。

当前可接受的实现边界只有两种：

1. 无 Agent 对话继续由官方 DSH `session.prompt` 承载；
2. 绑定 Agent 先由上游提供公开 admission/provider 合同，或由 Host 装配合法的 DSH
   provider/preset，再接入现有窄 Host route。

禁止通过 DOM、浏览器事件、`InputHub` 私有字段、`session.append` 或自建 sink/bridge
绕过这个缺口。后一类路线已经在 rc.1/rc.2 临时 profile 中实测失败，且会重新制造两套
会话事实源。该缺口在上游合同落地前保持 P0 阻塞，不能以 UI 可用或 mock SDK smoke
替代。

### 当前 Host 侧实现状态

KsADK 已有一个最小 `DshNativeRuntimeAdapter`（`ksadk/runtime/dsh_native.py`）：它懒加载
官方 SDK、按 `StartRequest.session_id` 调用 `session/prompt`，把真实
`session.event` 交给 `ksadk.events.adapters.dsh`，并产出 canonical `run/item` 事件。
`scripts/run_dsh_sdk_canonical_probe.py` 已用本地 mock SSE 验证了子进程、API key/base URL、
事件游标和 `run.completed` 终态。

Studio 侧现在也有一条**无资源绑定的真实 Host vertical slice**：
`FrameworkRunSpecResolver` 会为 `dsh-native` 解析固定的 SDK profile、隔离 `DSH_HOME`、
工作目录和模型配置；Builder 会把 Agent Revision 的 system/task/soul 指令写成 bundle
根目录的 `AGENTS.md`，供官方 `agent-instructions` 插件发现；`StudioService` 再把运行结果
写入 canonical session store。`tests/studio/test_dsh_native_framework_run.py` 覆盖了
Build/resolve、`AGENTS.md` 和 canonical run store 的闭环（SDK 调用在该测试中使用确定性的
fake facade，官方 SDK 进程边界另由上面的 real SDK probe 验证）。因此这条路径已经不是
单纯页面或 `CreateSession/RunAgent` 的演示，但还不能称为完整的 Studio Agent。

当前仍有一个刻意的边界：KsADK 的 MCP、Skill、知识库、记忆库和 resource build 声明尚未
物化为 DSH SDK profile/preset。Resolver 对这些声明会 fail closed，并返回明确的
`DSH_NATIVE_RESOURCE_ADAPTER_UNAVAILABLE`，不会静默运行一个没有绑定资源的默认 DSH Agent。
因此 Studio 创建页只把 `dsh-native` 作为无资源的最小运行目标展示；模型、MCP、Skill、
知识库和记忆绑定仍需在资源页或 Agent 详情完成，带这些声明的 Revision 在 Host 侧明确
fail closed，不会静默运行一个没有绑定资源的默认 DSH Agent。`cancel`、审批、checkpoint、
run resume 在固定 SDK 上均明确报告 unavailable，不能把 DSH session 日志当作 KsADK run 恢复。

`~/.agentkit/config.yaml` 由 KsADK Host 在启动时读取并投影为 SDK 进程环境变量；API key
不会写入 Agent bundle 或浏览器 launch config。DSH SDK 本身不会自动读取该文件，避免把
Host 的全局配置约定误认为 DSH 的原生配置发现。

## 运行时矩阵

| 运行目标 | 执行 owner | UI 入口 | 是否使用 DSH SDK | 是否需要 Host adapter |
| --- | --- | --- | --- | --- |
| 无 Agent | DSH Host 内的官方 Agent Loop | DSH `session.prompt` | 否 | 否 |
| DSH Native Agent | DSH SDK runtime 或同进程 DSH Agent Loop | Studio Agent 会话 | 可选 | 是，负责 Revision/canonical |
| KsADK Harness | KsADK Python Host | Studio Agent 会话 | 否 | 是，负责 KsADK→DSH projection |
| Codex | Codex App Server | Studio Agent 会话 | 否 | 是，负责 Thread/Turn/Item projection |

## 选择原则

如果只交付 DSH Native Agent，优先使用 DSH 原生 Agent/Session API，并去掉当前
`agentkitStudioPromptBridge` 默认路径。只有当 Agent Revision 必须由 KsADK Host
统一管理资源、canonical 事件、评测、观测、Channel、重启恢复和云端同步时，才
启用 DSH SDK runtime + Host adapter。

下一步验收顺序：

1. 先证明无 Agent 的 DSH 原生会话不经过桥接；
2. 用一个固定 Agent Revision 通过 DSH SDK 子进程完成真实 prompt、事件接收、
   canonical 写入、刷新恢复和资源 profile 装配；取消语义要么补上 DSH 原生协议，
   要么在产品上明确显示“不支持”，不能把上面的 mock smoke 当作完成证明；
3. 再决定是“一 Agent 一 SDK runtime”还是扩展 SDK 协议支持 per-session
   Revision；
4. 已把旧的直接 session/run bridge 从 Studio 插件移除。Host 客户端保留了类型化
   `conversation:stream` 调用和幂等键，但官方 DSH composer 当前没有公开输入接管点，
   因而绑定 Agent 的浏览器提交尚未接到这条路由；现有 rc.2 浏览器证据只证明 DSH
   原生 `session/prompt`。只有上游公开 admission/provider 合同或 Host-owned DSH
   provider 落地后，才能验证绑定 Agent 的创建、流式接收和刷新恢复。
