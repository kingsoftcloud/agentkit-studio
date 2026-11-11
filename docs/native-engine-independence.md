# Native 引擎独立方案

将 Native Harness 作为独立服务发布。Studio 继续负责会话、身份、业务资源和审批，Harness 负责运行、模型连接、工具账本和任务过程视图。同一协议内更新引擎时，宿主可以继续使用原来的构建和镜像。

## 目标形态

1. **Harness 独立部署。** 它自己是一个进程或容器（服务端是 sidecar 或独立服务，桌面端是单独的可执行文件），有自己的版本和镜像。Studio 里只留一个很薄的协议客户端，不含任何引擎逻辑。
2. **Studio 只配置“连哪个引擎”，不配置“引擎怎么跑”。** Studio 传任务、允许的宿主工具和审批结果。托管模型连接和工作区由部署绑定。恢复策略、重试、输出额度、压缩这些默认值全部由 Harness 自己决定，Studio 不再出现 `response-boundary/v2` 这类字符串。
3. **提示词归 Harness。** Harness 自带基础系统提示词和工具说明。Studio 只能通过固定的插槽追加内容，比如 Agent 的角色设定、工作区指令、企业规则，不能替换整段。旧 Run 从账本恢复创建时的提示与策略。
4. **前端归 Harness。** Harness 自己发布任务界面（时间线、审批卡片、失败原因、差异查看），并由引擎服务直接提供。Studio 只负责把它嵌进页面，传入会话的公开展示事件和主题。这样新增事件类型、改交互都只发 Harness。
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

| 入口 | 当前行为 |
| --- | --- |
| 本地独立进程 | `AGENTKIT_ENGINE_COMMAND` 指向单独安装的 `agentkit-engine`。Studio 走 `agentkit.engine/v1`。 |
| 独立服务 | 本地或托管 Studio 配置 `AGENTKIT_ENGINE_SERVICE_URL`、`AGENTKIT_ENGINE_SERVICE_TOKEN` 和 `AGENTKIT_ENGINE_SERVICE_WORKSPACE` 后，Studio 通过协议连接。模型凭据只配置到 Harness。 |
| 本地会话切换 | 配置服务后，普通新建 Harness 会话登记独立预设并绑定服务工作区。已有会话按原预设恢复。 |
| 审批与恢复 | 通过原 Run 的 `run/status` 和 `run/approve` 恢复工具及子任务审批。引擎替换后继续使用原账本。 |
| 展示 | 引擎交付带内容哈希的 `agentkit.engine-view/v1`。Studio 和 Hosted UI 在沙箱 iframe 中展示，历史使用原 Run 的视图版本。 |
| 历史兼容 | 未配置独立服务的旧 `harness` 仍使用已有的 0.0.17 SDK。旧路径保留原策略与状态格式。独立服务的预设、提示词和自适应输出额度由引擎维护。 |

### 仍需验收

- 旧运行路径迁移、A2A 等宿主工具的独立协议覆盖。
- 云端 Runtime 自动绑定以及在真实集群中只升级或回滚 Harness 镜像。
