# DSH 0.2.1-rc.2 产品补丁

当前唯一构建基线为官方 `dsh-v0.2.1-rc.2`：`687f282e8625c6b8d11ff58211a90524be2e4317`。

44 项活动补丁由 [manifest.json](manifest.json) 声明，以 [source.json](source.json) 和 [维护归档](../../host-source/dsh-v0.2.1-rc.2/README.md) 固定来源。原 018 合并入 017；041 记录当前版本集成修正；046 把 Studio 产品身份扩展到 macOS；047 提供原生任务管理与工具身份校验；048 提供隔离的原生浏览器工厂；049 修复 Linux libc 探测的网络采集；050 对齐维护源码目录与校验；051 让安装后的 `dsh` 启动器按构建产品名启动应用可执行文件。完整影响与处理见 [升级记录](../../docs/dsh-0.2.1-upgrade.md)。

修改维护分支源码后，按 `source.json` 中的 `branchRef` 导出。标准引用可用 `make patch-source-export DSH_MAINTENANCE_ROOT=<checkout>`；当前隔离集成分支使用 `scripts/dsh-maintenance-source.mjs` 导出的 `exportMaintenanceSource({ source, branchRef })`，显式传入维护工作树和该引用。`make patch-source-verify DSH_ROOT=<clean-baseline>` 校验 Git 祖先、提交顺序、补丁摘要和最终源码树。桌面构建会再次验证上述身份。


043 保留本地原生权限菜单，增加远端策略展示位置，并修正自动化审批的错误用户归因；展示位置不携带授权。

044 为独立 Conversation 实例提供文件上传、内存草稿和仅入队提交策略，保留原生会话的默认行为。

045 将工具分发绑定到准备阶段的定义与执行函数身份；依赖 043，保留自动审批的中性拒绝归因，且不重复消费权限守卫或单次批准。

046 将 Studio 的独立 Electron 名称与 `desktop-agentkit-studio` 插件 profile 扩展到 macOS，使官方 DSH 与 Studio 可同时运行；会话、凭证与工作区保留共享 DSH Home。依赖 032、039、040、041。

047 提供原生任务管理 root factory 与 ScheduleService 所拥有的工具身份校验，保留当前 Session 范围和原生投递语义。

048 提供独立浏览器 root factory，复用原生控制器与工具栏，以临时身份和固定 iframe 沙箱释放每次实例。

049 在 Linux 原生锁首次探测 libc 时排除诊断报告的网络采集，避免已有 MCP 连接触发同步反向 DNS，并在成功及失败路径恢复调用方设置。原生测试通过 `verification.nativeTests` 注册，`verify-patched-dsh-host.mjs` 在 POSIX 构建后编译独立 C oracle 并执行；Linux 需要 `cc` 和 `musl-gcc`，macOS 需要 `cc`。报告单列平台，macOS 的通过不替代 Linux libc 用例。

050 同步维护源码的生成目录、双语记录及类型检查；引用检查只豁免 uv.lock 的未加引号整数制品字节数，仍拒绝真实提交引用，不修改既有工具定义身份或权限选择行为。

051 在打包时按 `DSH_DESKTOP_PRODUCT_NAME` 生成安装后的 `dsh`/`dsh.cmd` 启动器，使其启动本产品实际打包的可执行文件（如 `AgentKit Studio`），而不是固定 `DeepSeek Harness`；上游默认构建的启动行为不变，参数、cwd、环境、标准输入输出和退出码保持原样。`apps/desktop/tests/cli-launcher.spec.ts` 覆盖产品名与默认名两条路径。
