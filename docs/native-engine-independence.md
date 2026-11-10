# Native 引擎独立方案

目标：更新 Harness 代码不需要更新 Studio、不需要重建或重新部署 Studio 镜像；系统提示词用 Native Harness 自己的；任务过程的前端交互也用 Harness 自己的。

核心是把现在的关系反过来：**今天是 Studio 把 Harness 当库装进自己，要改成 Harness 是一个独立运行的服务，Studio 只通过协议调用它。** 只要 Harness 还是 Studio 的 npm 依赖，上面三件事都做不到。

一个现成的例子：Harness 0.0.16 已经修了“截断后假完成”（`response-boundary/v3`，[ksadk-harness#21](https://github.com/kingsoftcloud/ksadk-harness/issues/21)），但 Studio main 的 `src/host/services/native-harness.mjs` 里写死的还是 `v2`，所以修复在 Studio 上不生效，必须再改 Studio、再发版。

## 现在卡在哪四个地方

| 耦合点 | 现状 | 后果 |
|---|---|---|
| 代码打包 | Harness 是 Studio 的 `bundledDependencies`，同进程加载 | 改 Harness 必须重建 Studio 镜像 |
| 策略选择 | 用哪版恢复策略、重试、输出额度由 Studio 代码决定 | Harness 的修复要 Studio 逐项“开启” |
| 系统提示词 | Studio 调 DSH 的 `renderPrompt` 拼好再传给内核 | 提示词归 Studio 和 DSH，Harness 改不了 |
| 前端 | 时间线、审批、失败展示在 Studio 客户端里，按 Harness 内部事件类型渲染 | 加一种事件就要改 Studio 前端 |

## 目标形态

1. **Harness 独立部署。** 它自己是一个进程或容器（服务端是 sidecar 或独立服务，桌面端是单独的可执行文件），有自己的版本和镜像。Studio 里只留一个很薄的协议客户端，不含任何引擎逻辑。
2. **Studio 只配置“连哪个引擎”，不配置“引擎怎么跑”。** Studio 传的是任务、工作区、模型凭据、允许的工具和审批结果。恢复策略、重试、输出额度、压缩这些默认值全部由 Harness 自己决定，Studio 不再出现 `response-boundary/v2` 这类字符串。
3. **提示词归 Harness。** Harness 自带基础系统提示词和工具说明。Studio 只能通过固定的插槽追加内容，比如 Agent 的角色设定、工作区指令、企业规则，不能替换整段。恢复时“提示词必须逐字一致”的检查也要去掉，否则改一个字旧任务就恢复不了。
4. **前端归 Harness。** Harness 自己发布任务界面（时间线、审批卡片、失败原因、差异查看），并由引擎服务直接提供。Studio 只负责把它嵌进页面，传入会话和登录信息、主题。这样新增事件类型、改交互都只发 Harness。
5. **Studio 保留治理。** 身份、权限、凭据、MCP 连接、审批的最终决定、审计、计费留在 Studio，Harness 通过协议反向请求。

## 为了“以后不用再动 Studio”必须守住的三条规则

- **协议只增不改。** 握手时双方声明能力，Studio 按能力判断，不按版本号判断。只有协议大版本变化才需要改 Studio。
- **引擎版本是配置不是代码。** Studio 配一个发布通道（稳定版、测试版或固定版本），升级 Harness 等于换一个镜像 tag 或下载一个新文件。
- **账本和存储归 Harness。** Studio 不直接读 Harness 的 SQLite，查询都走协议。否则表结构一变 Studio 又要跟着改。

## 落地顺序

1. **先收回策略默认值**（最小、收益最快）：Harness 提供一个“官方预设”，Studio 改成只引用预设名。做完后像 #21 这类修复就不用 Studio 配合了。
2. **再收回提示词**：基础提示词搬进 Harness，Studio 改走插槽。
3. **进程拆分**：每个 Run 一个引擎进程，走协议；Studio 去掉 `bundledDependencies`。到这一步才真正不用重建 Studio 镜像，同时也解决了投递占满 Studio 主线程的问题（[ksadk-harness#18](https://github.com/kingsoftcloud/ksadk-harness/issues/18)）。
4. **前端迁移**：Harness 发布自己的界面包，Studio 换成嵌入。
5. **最后迁 Memory 和 A2A**，它们和 Studio 的数据缠得最深。

## 需要决定的取舍

- **前端独立的程度。** 完全由 Harness 提供界面，交互最自由，但 Studio 的整体风格统一要靠主题变量来保证。折中做法是 Harness 提供组件、Studio 只管外壳。建议前者，因为目标是“前端交互也用自己的”。
- **DSH 的位置。** 现在会话、投递都经过 DSH 的私有契约。完全独立意味着 Native 这条路绕开 DSH，Studio 里会并存两套会话通道一段时间。
- **代价。** 多一个进程，部署和排障会复杂一些；每次启动要多一次握手。相比每次修复都要两边发版，这个代价值得。

## 实施状态

本分支（Studio `feat/native-engine-independence`，Harness `feat/engine-independence`）已完成以下部分：

| 步骤 | 状态 | 说明 |
|---|---|---|
| 1. 策略默认值 | 完成 | Harness 新增 `agentkit.engine-preset/v1`。Studio 新建的 Native Run 只引用 `official` 预设，不再写死策略版本。预设选用 `response-boundary/v3`、`per-response/v2`、`diagnose-before-repeat/v2`，默认单次输出额度 32000（受模型上限和半个上下文窗口约束）。已有 Run 保持创建时的配置。 |
| 2. 提示词 | 完成 | Harness 新增 `engine-instructions/v1`：引擎自带基础提示词，Studio 的内容放进带边界的插槽。恢复时只比对 Studio 贡献的部分。旧 Run 保持原来的逐字比对。 |
| 3. 进程拆分 | 部分完成 | Harness 新增 `agentkit-engine` 可执行文件和 `agentkit.engine/v1` 协议（JSON-RPC over stdio）。Studio 新增实验性运行时类型 `native-engine`，通过 `AGENTKIT_ENGINE_COMMAND` 指定引擎。原有 `harness` 类型仍在进程内运行，`bundledDependencies` 尚未去掉。 |
| 4. 前端 | 完成（仅 `native-engine`） | 引擎通过 `ui/view` 交付自包含的任务视图（`agentkit.engine-view/v1`）。Studio 按哈希缓存，用只允许脚本的沙箱 iframe 嵌入并转发事件、传入主题。审批仍是 Studio 自己的卡片。 |
| 5. Memory、A2A | 部分完成 | MCP、知识库、Skill 等资源工具经协议的 `host/callTool` 由 Studio 执行；Memory 召回和回写在任务前后由 Studio 处理。A2A 尚未接入。 |

### 协议要点（`agentkit.engine/v1`）

- 宿主 → 引擎：`initialize`、`run/start`、`run/status`、`run/events`、`run/resume`、`run/cancel`、`ui/view`、`shutdown`。
- 引擎 → 宿主：`host/approveTool`（宿主声明 `approvals` 服务时）、`host/callTool`（宿主声明 `tools` 服务时）。
- `initialize` 返回引擎版本、预设、提示词策略、模型参数、`reservedToolNames`、`hostToolNamePattern` 和视图哈希；宿主据此行事，不写死引擎细节。
- `run/start` 接受 `objective`、`conversation`（之前的对话轮次，由引擎决定如何放入上下文）、`hostInstructions`、`hostTools`。
- 事件统一投影为 `agentkit.engine-event/v1`，宿主可以不理解具体类型而通用渲染。

### 已知限制

- 依赖尚未发布的 Harness 版本（0.0.16 之后）。在 Harness 发布前，Studio 的依赖校验和正式打包不会通过。
- `native-engine` 不出现在 Agent 创建表单、运行包和部署里，只能通过接口创建。
- 引擎进程按回合启动和退出；崩溃后的自动恢复走引擎自己的账本，尚未在 Studio 侧做专门的恢复入口。
- 新建 Run 的默认输出额度变大，单次请求的 token 上限和成本会上升。

### 剩余工作

1. A2A 接入协议。
2. 把原有 `harness` 类型切到进程路径，之后去掉 Studio 对 Harness 包的打包依赖。做完这一步，“更新 Harness 不用重建 Studio 镜像”才对所有 Native Agent 成立。
3. 引擎发布通道（stable / beta / 固定版本）和签名校验。
