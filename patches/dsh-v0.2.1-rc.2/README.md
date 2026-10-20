# DSH 0.2.1-rc.2 产品补丁

当前唯一构建基线为官方 `dsh-v0.2.1-rc.2`：`687f282e8625c6b8d11ff58211a90524be2e4317`。

40 项活动补丁由 [manifest.json](manifest.json) 声明，以 [source.json](source.json) 和 [维护归档](../../host-source/dsh-v0.2.1-rc.2/README.md) 固定来源。原 018 合并入 017；041 记录当前版本集成修正。完整影响与处理见 [升级记录](../../docs/dsh-0.2.1-upgrade.md)。

修改维护分支源码后，按 `source.json` 中的 `branchRef` 导出。标准引用可用 `make patch-source-export DSH_MAINTENANCE_ROOT=<checkout>`；当前隔离集成分支使用 `scripts/dsh-maintenance-source.mjs` 导出的 `exportMaintenanceSource({ source, branchRef })`，显式传入维护工作树和该引用。`make patch-source-verify DSH_ROOT=<clean-baseline>` 校验 Git 祖先、提交顺序、补丁摘要和最终源码树。桌面构建会再次验证上述身份。

旧版本目录仅作发布追溯，不为当前运行时提供回退。

043 保留本地原生权限菜单，增加远端策略展示位置，并修正自动化审批的错误用户归因；展示位置不携带授权。

044 为独立 Conversation 实例提供文件上传、内存草稿和仅入队提交策略，保留原生会话的默认行为。

045 将工具分发绑定到准备阶段的定义与执行函数身份；依赖 043，保留自动审批的中性拒绝归因，且不重复消费权限守卫或单次批准。

046 提供原生任务管理 root factory 与 ScheduleService 所拥有的工具身份校验，保留当前 Session 范围和原生投递语义。

047 提供独立浏览器 root factory，复用原生控制器与工具栏，以临时身份和固定 iframe 沙箱释放每次实例。
