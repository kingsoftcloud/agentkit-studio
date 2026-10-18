# DSH 0.2.1-rc.2 产品补丁

当前唯一构建基线为官方 `dsh-v0.2.1-rc.2`：`687f282e8625c6b8d11ff58211a90524be2e4317`。

34 项活动补丁由 [manifest.json](manifest.json) 声明，以 [source.json](source.json) 和 [维护归档](../../host-source/dsh-v0.2.1-rc.2/README.md) 固定来源。原 018 合并入 017；041 记录当前版本集成修正。完整影响与处理见 [升级记录](../../docs/dsh-0.2.1-upgrade.md)。

修改维护分支源码后，用 `make patch-source-export DSH_MAINTENANCE_ROOT=<checkout>` 导出。`make patch-source-verify DSH_ROOT=<clean-baseline>` 校验 Git 祖先、提交顺序、补丁摘要和最终源码树。桌面构建会再次验证上述身份。

旧版本目录仅作发布追溯，不为当前运行时提供回退。
