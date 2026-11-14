# Native 引擎独立方案

将 Native Harness 作为独立服务发布。Studio 继续负责会话、身份和业务资源，Harness 负责运行、模型连接、工具账本和任务过程视图。同一协议内更新引擎时，宿主可以继续使用原来的构建和镜像。

## 目标形态

1. **Harness 独立部署。** 它自己是一个进程或容器（服务端是 sidecar 或独立服务，桌面端是单独的可执行文件），有自己的版本和镜像。Studio 里只留一个很薄的协议客户端，不含任何引擎逻辑。
2. **Studio 只配置“连哪个引擎”，不配置“引擎怎么跑”。** Studio 传任务、允许的宿主工具和审批结果。托管模型连接和工作区由部署绑定。恢复策略、重试、输出额度、压缩这些默认值全部由 Harness 自己决定，Studio 不再出现 `response-boundary/v2` 这类字符串。
3. **提示词归 Harness。** Harness 自带基础系统提示词和工具说明。Studio 只能通过固定的插槽追加内容，比如 Agent 的角色设定、工作区指令、企业规则，不能替换整段。旧 Run 从账本恢复创建时的提示与策略。
4. **前端归 Harness。** Harness 自己发布任务界面（时间线、审批卡片、失败原因、差异查看），并由引擎服务直接提供。Studio 只负责把它嵌进页面，传入会话的公开展示事件和主题。这样新增事件类型、改交互都只发 Harness。
5. **Studio 保留治理。** 身份、权限、凭据、MCP 连接、审计和计费留在 Studio。本地会话的审批由 Studio 决定。

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
| 本地会话切换 | Studio 按会话持久化的工作区目录连接该项目的独立服务。未绑定的工作区会提示配置。 |
| 审批与恢复 | 通过原 Run 的 `run/status` 和 `run/approve` 恢复工具及子任务审批。引擎替换后继续使用原账本。 |
| 本地 A2A | 独立服务将已绑定的 A2A 工具交回当前 Studio 会话的 ToolRegistry。发送沿用原有的 A2A 授权与持久账本。发送结果未知时暂停 Run，原远端任务仍可通过 Studio A2A 控制查询。 |
| 本地团队 | 新团队的 Harness 角色使用独立服务。各成员保留自己的会话、模型绑定与工作区，团队消息和任务板沿用 DSH 的权限与持久记录。已建立的团队按原预设恢复。 |
| 展示 | 引擎交付带内容哈希的 `agentkit.engine-view/v1`。Studio 和 Hosted UI 在沙箱 iframe 中展示，历史使用原 Run 的视图版本。 |
| 打包 | Studio 保留工具适配和 UI 的 npm 依赖。执行入口由独立服务或外部引擎命令提供。 |

### 托管接口的信任边界

- 托管视图由服务端带运行时 bearer、目标版本 ID 和 manifest 摘要读取。浏览器通过自己的宿主访问视图，运行时凭据留在服务端。
- 如果启用 Studio 的托管 Kernel 转发入口，部署须配置目标身份和 Server 公钥解析器。Studio 在转发前验证 Server 签发的 permit，Harness 在落账前再次验证。使用平台绑定审批的部署，两端都开启 `platformApprovals`。
- Studio 按会话权限和 Agent 策略决定宿主工具是否可直接执行，明确拒绝的工具始终拒绝。托管回调默认拒绝需额外审批的工具。只有部署者明确设置 `resources.approvalAuthority: 'trusted-engine'`，才由可信 Harness 核对已落账的审批决定。该配置要求 Harness 与 Studio 属于同一受控部署，回调凭据仅供该引擎持有。

### 仍需验收

- 托管 A2A，以及远端任务完成后接续原 Harness Run。
- 云端 Runtime 自动绑定以及在真实集群中只升级或回滚 Harness 镜像。

### 本地多项目

为每个项目启动一个 Harness 服务，分别配置工作目录、状态目录、端口和服务令牌。Studio 启动环境中的 `AGENTKIT_ENGINE_SERVICE_WORKSPACES` 接收一组绑定：

```json
[
  {"workspace":"/projects/alpha","endpoint":"http://127.0.0.1:8791","tokenEnv":"HARNESS_ALPHA_TOKEN","model":"deepseek-v4.1-flash"},
  {"workspace":"/projects/beta","endpoint":"http://127.0.0.1:8792","tokenEnv":"HARNESS_BETA_TOKEN","model":"deepseek-v4.1-flash"}
]
```

`tokenEnv` 填各自服务令牌所在的环境变量名。HTTPS 可选填 `caFile`。运行中应用的侧边预览可在绑定中设置 `previewOrigin` 和 `previewEntry`。同一 Studio 进程选择多项目或原有单服务配置其中一种。


`AGENTKIT_DSH_ROOT=<已验收的 DSH 源码目录> node scripts/verify-independent-workspace-host.mjs <Studio.tgz>` 会挂载实际打包的 Studio，验证两个独立 HTTP 服务的写入、历史及切回原项目后的隔离，并确认未绑定目录不会落到另一个服务。模型使用本地测试响应；真实模型和侧边交互仍须单独验收。冻结版本、MCP 调用与重启回放的集成验证也使用独立引擎进程。
