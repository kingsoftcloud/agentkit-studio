Native 子任务文件工作区已接入 Studio Host。父 Agent 显式绑定的十个 workspace 工具可以授予子角色；包含写工具的角色使用隔离目录，且不能声明 `concurrentSafe: true`。命令、Browser、Memory 等工具不因此获得子角色授权，Skills/MCP 继承还在独立接入。

新子 Session 复制真实父工作区的当前文件，包括未提交及未跟踪文件，忽略 `.git`、`.agentkit`、`.harness-tools`、`.artifacts`。后续 Run 继续使用同一隔离目录和最初基线，不重新复制父目录。模型不能选择隔离路径；scope、Session、角色及父目录共同决定隔离身份。冻结配置保存 `hostRecoveryBinding.childWorkspace`，契约为 `agentkit.native-child-workspace-binding/v1`。恢复时核对原身份、路径摘要、角色摘要和基线；缺失目录不会重新准备。

子任务仍通过 Studio Native 工具网关进入 DSH 工具注册和权限边界。文件读取状态存储按隔离身份及子 Session 单独保存。工作区观察与确定性文件验收读取子目录，子任务写入不会提前发布到父目录。子任务宿主契约升级为 `agentkit.studio-native-children/v2`。

目录层提供三方文件比较和增量发布。父目录独立删除而子任务修改的文件属于冲突；发布前检查全部冲突，冲突时不写文件。目录层与生产 workspace builtin 共用 SQLite 进程锁，进程退出即释放。租约检查失败会释放锁；如果已写入部分文件，异常保留 `effectStarted` 和 `applied`，供上层记录不确定结果。只有可信的已提交合并凭证才能授予后续增量比较基线，磁盘 inventory 本身不授予权限。

当前验证：Node 26 和 Node 22 各自的目录层 34 项、Host 组装及子任务流程 36 项、持久目录重开绑定 3 项通过，共各 73 项。Host 用真实 NativeKernel、SqliteRunStore、AgentStore、模型适配器与注册的工具验证：子任务实际写入、父目录保持原状、同 Session 新 Run 读取原子目录、原始凭证和工作区版本保留。模型响应和 DSH registry 外壳为确定性测试设施；这组测试不等于完整安装后的 DSH 进程验收。Node 22 的 Host 文件运行约 39 秒，使用 `--test-timeout=60000`，原先 30 秒的文件总时限不足。

尚未完成：模型可调用的 `native_child_merge` 生产入口、已提交合并凭证的恢复解析与 Host 接入、写子任务的完整进程退出冷恢复、Skills/MCP 继承及端到端安装验收。当前代码不会自动把隔离目录变更复制回父目录。隔离目录限制 SDK 文件工具的读写范围，不能作为任意宿主命令的操作系统沙箱；文件发布也不提供跨文件原子事务。
