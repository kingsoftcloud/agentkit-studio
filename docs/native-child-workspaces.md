Native 子任务文件工作区已接入 Studio Host。父 Agent 显式绑定的十个 workspace 工具可以授予子角色；包含写工具的角色使用隔离目录，且不能声明 `concurrentSafe: true`。命令、Browser、Memory 等工具不因此获得子角色授权。`inheritMcp: true` 另外继承父 Agent 已绑定的全部 MCP 工具，Skills 继承仍待接入。

新子 Session 复制真实父工作区的当前文件，包括未提交及未跟踪文件，忽略 `.git`、`.agentkit`、`.harness-tools`、`.artifacts`。后续 Run 继续使用同一隔离目录和最初基线，不重新复制父目录。模型不能选择隔离路径；scope、Session、角色及父目录共同决定隔离身份。冻结配置保存 `hostRecoveryBinding.childWorkspace`，契约为 `agentkit.native-child-workspace-binding/v1`。恢复时核对原身份、路径摘要、角色摘要和基线；缺失目录不会重新准备。

子任务仍通过 Studio Native 工具网关进入 DSH 工具注册和权限边界。文件读取状态存储按隔离身份及子 Session 单独保存。工作区观察与确定性文件验收读取子目录，子任务写入不会提前发布到父目录。子任务宿主契约升级为 `agentkit.studio-native-children/v2`。

写角色会为父 Agent 暴露 `native_child_merge`。该工具通过 DSH 注册和权限边界，独立验证当前 Native intent、完整调用、冻结定义、Session、lease/fence、子任务原始归属及用量结算；只有当前子 Session 最新且已完成的写子任务可合并。目录层提供三方文件比较和增量发布。父目录独立删除而子任务修改的文件属于冲突；发布前检查全部冲突，冲突时不写文件。目录层与生产 workspace builtin 共用 SQLite 进程锁，进程退出即释放。租约检查失败会释放锁；如果已写入部分文件，异常保留 `effectStarted` 和 `applied`，上层记录不确定结果。

增量基线只来自实际 `effect.prepared` 对应的 committed 成功工具结果，结果 schema 为 `native.child-file-merge/v2`，工具参数必须精确等于原子任务 ID，子版本和 publication 摘要必须匹配。解析器沿当前父 Session 的终态祖先查找凭证，并证明它属于当前子 Session 的真实 continuation 祖先；父 Run 后来才发布的凭证同样有效。模型文本、单独磁盘 inventory、失败/uncertain 结果、参数夹带及跨 Session 记录不授予发布权限。

当前验证：Node 26 和 Node 22 各自的目录层 34 项、Host 组装及子任务流程 36 项、持久目录重开绑定 3 项通过，共各 73 项。Host 用真实 NativeKernel、SqliteRunStore、AgentStore、模型适配器与注册的工具验证：子任务实际写入、父目录保持原状、同 Session 新 Run 读取原子目录、原始凭证和工作区版本保留。模型响应和 DSH registry 外壳为确定性测试设施；这组测试不等于完整安装后的 DSH 进程验收。Node 22 的 Host 文件运行约 39 秒，使用 `--test-timeout=60000`，原先 30 秒的文件总时限不足。

后续受控合并验证：Node 26 和 Node 22 各 77 项相关测试通过（合并端口 8、Studio 子任务 Host 37、网关 32）。真实进程在发布文件之后、返回 ToolResult/提交凭证之前退出，重开数据库等待原 lease 到期后进入 `interrupted`，原 effect 记录 uncertain，重复发布次数为零。另一组实际 Host 两轮对话证明：第一轮的子任务由第二轮父 Run 发布，随后子任务续跑修改文件，仍从第二轮的原始 committed 凭证还原增量基线；额外 SQLite 连接重开读取同样成功。日志位于本地进度目录的 `child-merge-final-node26.log`、`child-merge-final-node22.log`。

活跃写子任务的完整 Host 冷恢复已另行验证：`scripts/verify-studio-native-child-write-recovery.mjs` 解包实际 Studio 包，使用固定维护版 DSH SDK、真实 `mountStudioHost`、注册工具、AgentStore、SQLite 和 SessionController。子任务写入自己的隔离目录后，父子模型请求均已发出且未返回，宿主以 exit37 退出，不执行清理。等待原租约自然到期，启动新宿主，通过鉴权恢复 RPC 接回原父子 Run，保留原配置、Session 事件前缀和隔离绑定，最后只发布一次文件。重复恢复请求不增加模型调用。父子丢失的推理尝试均保留 uncertain 回执和用量不完整诊断；子任务工具执行次数仍为 1。

Node 26.5.0、22.19.0 均通过这条打包验证；相关 Host/模型模块各 114 项定向测试通过。原有打包只读子任务的两轮执行、宿主重启、同子 Session 续跑和历史查询也通过。重启时的模型配置按核心 `configure()` 的默认值归一化后核对，避免把已持久化的默认重试字段误判为配置漂移。实际命令为：

```sh
node scripts/verify-studio-native-child-write-recovery.mjs --source .artifacts/dsh-native-numeric --archive .artifacts/native-migration/kingsoftcloud-agentkit-studio-0.0.2.tgz --keep
```

当前 Host 只对其普通 HTTP 推理绑定启用 `pure-inference/v1`：受支持的 OpenAI Chat、Responses 或 Anthropic 协议，且模型扩展参数为空。工具调用由模型提出，由 Native 本地调度；模型请求本身不能执行 Studio 工具。带扩展参数的配置保留 `manual`，不将未知提供方行为自动重跑。推理重试仍可能产生额外计费，丢失尝试不会被抹去或视为免费。

MCP 继承默认关闭。启用后，子配置固定工具定义、资源绑定及 Schema 的摘要，恢复必须仍匹配原绑定。借用父连接不会转移连接所有权；子任务继续通过父 Agent 的 DSH 权限管线，但调用必须符合子任务自身的 scope、Run、Session、原始 intent、完整参数及定义、当前 lease/fence。权限管线等待后和连接初始化等待后都复查，派发前失效不调用远端；远端已执行后发生权限漂移则保留原回执并标为 uncertain。未知远端效果不能凭目录 read-only 提示取得安全重试或并行权限，因此当前继承 MCP 的角色不能声明 `concurrentSafe: true`。工作区隔离不会隔离 MCP 的外部资源。

继承 MCP 的 Host/网关两个相关模块在 Node 26.5.0、22.19.0 各通过 73 项测试，使用实际 AgentStore、NativeKernel、SQLite 和注册网关，远端及 DSH 外壳为确定性设施；覆盖连续两次 MCP 调用、未声明继承、跨身份和已完成调用重放拒绝、派发前请求漂移与执行后 uncertain 原回执。资源适配器另验证真正 MCP 客户端等待后的权限复查和异步校验拒绝。

打包 Host 冷恢复还覆盖继承 MCP：上述脚本增加 `--mcp`，使用生产资源适配器和真正 MCP HTTP 客户端连接测试服务。子任务的隔离文件写入和远端回执都提交后退出 Host；新进程接回原父子 Run，远端效果、文件写入和受控发布各一次，重复恢复不重放。增加 `--mcp --mcp-unknown` 则让独立服务执行效果后扣留响应，再退出 Host；冷恢复将原工具回执保留为 uncertain，父子 Run 中断并要求 reconciliation，不再次调用远端，也不发布文件。两种场景均在 Node 26.5.0、22.19.0 通过，保留原配置、隔离目录及子任务事件前缀。

尚未完成：Skills 继承和端到端全新安装验收。前述打包验证复用固定本地依赖图和确定性模型/MCP 服务，Host PATH 只提供 Node；不代表全新依赖安装、在线模型、在线第三方 MCP 或 E2B 验收。合并只由显式工具调用触发，读取历史不会发布文件。隔离目录限制 SDK 文件工具的读写范围，不能作为任意宿主命令的操作系统沙箱；文件发布也不提供跨文件原子事务。
