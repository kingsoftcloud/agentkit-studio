# 无 Python 的 Node 安装验证

`scripts/verify-native-studio-install.mjs` 使用全新目录和全新 npm cache，从正式 registry
安装实际 Studio 归档及依赖。安装启用 lifecycle scripts，既不使用 `--ignore-scripts`，
也不链接开发目录的 node_modules。隔离 PATH 只提供 Node 和 OS shell；Host 验证额外
使用 tar/openssl 准备测试归档和证书，运行中的 Host 则使用自己的 Node 或 Node/bash PATH。
Python 配置指向不存在的解释器，安装和执行不借用 Python bridge。

仅安装组件：

```sh
node scripts/verify-native-studio-install.mjs --archive /absolute/Studio.tgz --keep
```

这条路径在 Node 26.5.0 和最低支持的 Node 22.19.0 均已验证：Studio 模块导入、SQLite
运行存储、实际记忆写入和 Ruff WASM 源码解析。它本身不证明挂载了完整 Studio Host。

Studio 需要仓库维护的宿主接口。直接安装 npm 上同版本的 DSH `0.2.1-rc.2`，实际挂载
时会明确拒绝 Agent 准入：缺少 `preset-composition`，错误为 `STUDIO_HOST_INCOMPATIBLE`。
版本号相等不能代替能力检查；该拒绝在两个 Node 版本均已复现，检查没有被绕过。

完整 Host 验证需要使用维护源码导出的独立包集合。集合的 `host-packages.json` 固定
`agentkit.node-host-packages/v1`、维护 base/head/tree、根包、各包身份及归档 SHA-256。
安装器核对仓库 `patches/dsh-v0.2.1-rc.2/source.json`，拒绝版本/源码漂移、目录逃逸、
符号链接归档、缺失/重复根包和摘要变化，再以普通 npm 安装这些归档及 registry 依赖。
同一归档同时控制直接和传递依赖，避免被同版本的公开宿主包替代。

可复用导出命令如下。源码目录须按现有[宿主维护流程](refactor-patches.md)准备并完成构建；
导出器不下载依赖、不构建源码，也不修改分支或引用。输出目录的父目录须已存在，输出
目录须尚不存在且位于源码和 Studio 目录之外。失败时保留当前输出，换一个新目录重试。

```sh
node scripts/pack-maintained-node-host.mjs \
  --source /absolute/built-maintained-dsh --studio /absolute/agentkit-studio \
  --output /absolute/new-maintained-host
```

导出器仅从 Git 已跟踪的 package.json 建立映射，沿四个根包的 production/optional/peer
工作区依赖取闭包，只导出其中修改过的包和四个根包。每包正常执行 `pnpm pack`，前后
核对 HEAD、tree 和已跟踪文件状态；忽略并保留已有未跟踪文件。输出目录为 0700，清单
为 0600，已有输出不被覆盖。归档须包含实际 lib/dist 产物、正确名称和版本及生产导出
目标；运行时通配符也须命中实际归档文件。维护源码的 `src/*` 开发导出若被明确排除在
发布 files 范围之外，则不当成已发布的运行入口；这项现有发布约定不影响 lib/dist 检查。
每包原始 pack 日志留在输出目录。清单仅在所有检查通过后生成。

```sh
node scripts/verify-native-studio-install.mjs --host \
  --host-packages /absolute/maintained-host/host-packages.json \
  --archive /absolute/Studio.tgz --keep
```

`--host` 依次执行实际组件验证、完整挂载 Host 的 DSH Native/Codex builtin 工具管线、
Native 独立整轮模型/工具执行与原进程退出后的历史恢复。模型响应使用真实 HTTP 上的
确定性服务。工具管线保留原有权限/审批、真实脚本、HTTP/HTTPS、二进制产物、Chromium
及跨 PID 回执断言；浏览器使用已经安装的测试 Chromium，不声称新下载或安装浏览器。

维护版完整路径已在 macOS arm64 的 Node 26.5.0 和 Node 22.19.0 均通过：每次使用
全新安装目录和空 npm cache，启用安装脚本，安装 31 个维护归档及其 registry 依赖，
锁文件包含 789 项且没有目录链接。两种版本均注册 34 项 Node builtin，验证 DSH Native
和 Codex 的实际工具/策略管线，原 Host 退出后新 PID 恢复原回执且不再请求远端。
Native 路径各完成两轮成功对话、一次策略拒绝、跨进程恢复和六次确定性模型 HTTP 请求。
这些验证使用提交 `3cab317` 的 Studio 正式归档；新验证脚本从当前工作区运行。
归档 SHA-256 为 `088f0d69d2375153cff22fa4930fb85821404b6aafed6fe6296578f35815a7fb`。
保留的日志和证据位于 `.artifacts/native-migration/node-only-builtins/`。
可复用导出器已实际导出同一组 31 个归档，所有摘要均与两次完整安装使用的归档一致；
复核记录位于 `.artifacts/native-migration/fresh-node-install/`。因此无需为字节相同的包
重复执行完整 Host 安装回归。

这仍不等于完整迁移验收。真实模型/Codex CLI、线上 E2B/云服务、全部自动化/Frozen/
部署/恢复界面组合及最终默认切换分别验收；完整 Desktop 开发安装中 Python/Office
资源的强制前置条件也仍待处理。当前实际结论以
[验收状态](native-migration-status.md) 和保留的具体验证记录为准。
