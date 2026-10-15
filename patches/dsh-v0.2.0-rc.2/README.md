# DSH v0.2.0-rc.2 补丁集

本目录保存 AgentKit Studio 对官方 DSH `v0.2.0-rc.2` 的**可审计、版本锁定的临时兼容补丁**。补丁不是 Studio 的运行时依赖，也不会被浏览器直接加载；它们只在官方 DSH 尚未提供等价公开扩展点时，供宿主构建或本地复现使用。

机器清单见 [manifest.json](manifest.json)，维护流程见 [补丁治理说明](../../docs/refactor-patches.md)。补丁由 [维护提交归档](../../host-source/dsh-v0.2.0-rc.2/README.md) 自动导出，修改宿主时应在该分支编辑源码并重新导出。`make patch-manifest-check` 检查文件、内容摘要、修改路径、基线和依赖顺序；`make patch-source-verify` 从归档重新生成并核对补丁，桌面构建前也执行完整校验。未登记或与维护提交不同步的补丁不能进入构建。

## 基线

- DSH 版本：`0.2.0-rc.2`
- 基线 commit：`639ed015397290b3745d163aafe02ffee4aa3f84`
- 上游 checkout：由 `DSH_ROOT` 指定，不能写死本机路径

## 补丁顺序

按文件名的数字顺序应用。每个补丁都只允许修改补丁头中列出的 DSH 文件；应用前先确认 checkout 没有未提交改动。

```sh
DSH_ROOT=/path/to/deepseek-harness
PATCH_ROOT=/path/to/agentkit-studio/patches/dsh-v0.2.0-rc.2

test "$(git -C "$DSH_ROOT" rev-parse HEAD)" = \
  639ed015397290b3745d163aafe02ffee4aa3f84
make patch-check DSH_ROOT="$DSH_ROOT" PATCH_ROOT="$PATCH_ROOT"
make patch-apply DSH_ROOT="$DSH_ROOT" PATCH_ROOT="$PATCH_ROOT"
```

`patch-check` 在独立临时索引中依次检查并应用补丁，以验证后续补丁对先前改动的依赖；不会修改 checkout 或当前暂存内容。`patch-apply` 在检查全部通过后才修改工作目录。

已经通过宿主分支或本地 profile 应用过的 checkout 不要重复应用。升级 DSH 版本时，复制本目录为新的 `dsh-v<version>/`，重新生成补丁并更新本说明；禁止在同一目录混放不同版本的补丁。

## 补丁清单

| 文件 | 作用 | 删除条件 |
| --- | --- | --- |
| `004-sidebar-panel-lifecycle.patch` | 修复动态面板注册后的侧栏选择 | 上游侧栏生命周期修复进入发布版本 |
| `006-desktop-plugin-package-set.patch` | 让官方 Desktop package-set 接受额外的 Studio tarball，并把 Studio bundle 写入内置 Profile | 上游支持外部产品 bundle 的 Desktop package-set/profile 配置 |
| `008-agent-session-without-workspace.patch` | 允许已有 Agent 会话在未选择 Workspace 时直接使用原生 composer；Workspace 仍可作为 cwd/文件工具上下文 | 上游把 Workspace 从会话发送前置条件改为可选上下文 |
| `009-local-macos-package.patch` | 显式 `--unsigned` macOS 本地测试包复用官方离线运行时流水线；根 manifest 保留产品 bundle，干净 Profile 使用该 bundle，启动器从根 manifest 解析插件；Studio 跳过仅适用于 DeepSeek 的 welcome。支持产品名称和 macOS 图标覆盖，保留普通 DSH 默认品牌；正式签名、公证与发布门禁保持启用 | 上游提供 macOS 本地验收包、产品首次配置和打包插件解析的等价合同 |
| `010-session-model-default.patch` | 为公开 `session.selectModel` 增加可选 `saveDefault: false`，Agent 绑定和自动化只修改自己的会话模型；普通模型选择器仍保存默认值 | 上游提供会话模型选择与全局默认值分离的合同 |
| `011-cjk-autolinks.patch` | 原生 Markdown 的裸网址在中文标点前结束，避免加粗结束符及说明被拼进地址；复用 GFM 解析和既有流式渲染，保留显式链接、Unicode 路径及源位置 | 上游修复中文标点相邻的自动链接 |
| `012-preset-roster-invalidation.patch` | 注册表声明激活或移除后发布目录事件，经现有 Remote 转发让原生预设界面刷新；会话标签合并请求期间的变更，启动恢复后自动显示 Agent 名称 | 上游提供动态预设目录失效通知和请求合并 |
| `013-existing-product-profile.patch` | 已有 Desktop Profile 首次遇到新的产品 bundle 时补齐激活项，保留现有插件、设置和锁文件；记录已见默认项，保留后续用户或恢复操作的禁用选择 | 上游支持已有桌面 Profile 的产品默认项迁移 |
| `014-desktop-product-brand.patch` | 原生菜单、“关于”和恢复提示使用安装产品名称，修复图标已更新但仍显示 DeepSeek Harness 的混合品牌；保留默认 DSH 文案、模型提供方名称和用户数据目录 | 上游提供原生 shell 的产品品牌合同 |
| `015-compatibility-docs.patch` | 通过官方生成器同步事件、Cordis API 与持久化目录；持久化类型摘要未改变 | 上游提供等价模型选择和预设目录事件合同，并同步对应生成目录 |
| `016-informational-session-events.patch` | 为 Session.append 的非模型事件开放现有 ignorable 标记，修复下游插件展示记录在磁盘重开时被拒绝的问题；禁止消息事件使用，保留默认 required 和官方静态事件清单，附带单测与双语说明 | 上游公开可写入纯展示事件 ignorable 标记的等价接口 |
| `017-ungrouped-new-session.patch` | 接通“未分组”加号，并在工作区名称旁提供取消叉号；显式空工作区不再回退到当前或最近目录，取消目录沿用草稿迁移，复用导航取消与错误提示 | 上游支持从未分组创建无工作区会话及取消所选目录 |
| `018-preserve-agent-on-workspace-clear.patch` | 取消空白会话的目录时，通过公开 create preset、model selection 与 permission command 保留 Agent 和模型；Workspace-scoped 自定义访问模式回落到新会话默认命名模式，恢复成功后才迁移草稿，切换或失败不抢占页面 | 上游公开等价的无工作区会话配置继承合同 |
| `019-studio-product-update-feed.patch` | 把 Desktop 更新源、Stable/Preview 通道和 metadata 文件名变成显式产品输入；生产构建不再回退到 DeepSeek 下载源，Studio 使用自己的 App ID/更新源，仍保留 Nightly 仅用于旧测试夹具兼容 | 上游提供产品 App ID、更新源和 Stable/Preview 配置接口，并且可由产品包直接传入 |
| `020-studio-signed-product-name.patch` | 让正式签名、公证和签名后 smoke 沿用产品 bundle 名称，而不是硬编码查找 `DeepSeek Harness.app`；默认 DSH 品牌保持不变 | 上游签名和公证路径统一使用 `DSH_DESKTOP_PRODUCT_NAME` |
| `022-ks3-single-range-updates.patch` | 签名前封装官方 Generic Provider 的 `useMultipleRangeRequest: false`；KS3 公网多段 Range 返回 416，使用官方单段 Range 下载器完成差分，并在打包校验中拒绝默认多段配置 | 上游产品更新配置允许显式关闭多段 Range |
| `023-codex-code-mode-signing.patch` | 为 Codex 的 Code Mode 执行助手保留官方 `allow-jit` 和 `allow-unsigned-executable-memory` 权限；只匹配 Codex macOS 平台包中的该助手，不扩大其他运行时文件权限 | 上游运行时签名识别 Codex Code Mode 助手，并验证其所需权限 |
| `024-desktop-build-version.patch` | 用 Electron `app.getVersion()` 向 Host 注入实际桌面构建版本，Studio 设置页不再误用固定的 `DSH_CLIENT_VERSION` 宿主基线 | 上游向产品插件提供实际桌面 App 版本；设置页、Info.plist 和 updater 当前版本一致 |


| `025-windows-certificate-store-signing.patch` | 支持经验证的 Windows 证书存储签名，保留时间戳和发行者检查 | 上游支持等价证书存储签名输入 |
| `026-preset-composition-reuse.patch` | 从官方预设注册表取得独立组合快照，复用已验证的原生工具和 PTC 指引 | 上游提供经注册表校验的组合快照 API |
| `027-windows-installed-path-smoke.patch` | 在完整 App 的短安装路径执行签名、模块与 Office 检查 | 上游打包检查使用实际安装长度的目录 |
| `028-smoke-plugin-readiness.patch` | 等待异步注入的插件路由，仍要求真实 HTTP 200 和指定正文 | 上游 smoke 等待插件实际可用 |
| `029-full-update-blockmap-cache.patch` | 全量更新完成后清除与新 ZIP 不匹配的旧 blockmap 索引 | 上游全量下载同时正确更新或失效缓存索引 |
| `030-plugin-smoke-diagnostics.patch` | 隔离打包失败记录插件导入、执行、共享 Context、依赖服务和脱敏诊断 | 上游提供等价的打包失败诊断 |
| `031-canonical-windows-smoke-paths.patch` | 测试安装和 profile 使用统一真实路径，避免 Windows 短路径别名造成重复模块身份 | 上游在启动打包检查前统一安装与 profile 路径 |
| `032-windows-studio-product.patch` | Windows 产品 App ID、用户数据目录、NSIS 品牌与安装完成后启动输入，保留 DSH 默认产品路径 | 上游 Windows 产品配置提供等价 App ID、数据路径、安装品牌和完成后启动合同 |
| `033-windows-single-range-evidence.patch` | Windows Studio 的 Generic Provider 使用 KS3 单区间请求；保留原生下载实际字节数用于增量验收，差分计划日志不能单独证明通过 | 上游 Windows 产品配置支持单区间请求和实际下载字节记录 |
| `034-product-windows-tray.patch` | 托盘图标独立使用产品输入，Studio 不再复制官方鲸鱼 ICO；保留官方默认值 | 上游支持产品托盘资源输入 |

| `035-public-product-presentation.patch` | 通过可释放的 locale 覆盖和显式构建输入配置产品文案与图标，保留默认 DSH 行为 | 固定上游基线提供等价的产品文案与首次渲染接口 |
| `036-preset-composition-generated-api.patch` | 由生成器同步已有 pluginsFor 方法的双语 API 引用和 Host 检查目录 | 固定上游 API 目录包含该方法 |
| `037-web-editor-snapshot-ready-state.patch` | 通过真实输入及删除建立空编辑器段落，再采集 Hero ARIA；保留日志和回放断言 | 上游场景建立等价稳定的编辑器初始状态 |
| `038-prompt-request-fingerprint.patch` | 将请求指纹保存在首次接收的原生消息来源中，跨领取、取消和重启拒绝冲突重试；提供能力版本 | 固定上游基线提供等价的持久化指纹与冲突检查合同 |
| `039-exclude-package-ci-metadata.patch` | 在运行时清单封存前及普通桌面包、安装更新验证包的归档阶段排除第三方 Coveralls CI 配置，保留运行代码、许可证及模型数据清单 | 固定上游文件策略、打包规则和完整归档校验提供等价行为 |

`023` 的权限来自 [Codex 0.159.2 官方签名配置](https://github.com/openai/codex/blob/rust-v0.159.2/.github/scripts/macos-signing/codex-code-mode-host.entitlements.plist)。真实安装包的助手被通用签名规则重签后没有这两项权限；同一版本官方原包以及仅修复助手签名的本地副本都可实际创建并校验文件。正式产物还须通过 `node scripts/verify-codex-signing.mjs <App路径>`，并在实际安装后重跑文件执行验收。

007 会话过滤补丁已移除。Studio 完全复用 DSH 的分组、平铺、搜索和归档列表，选择 Agent 仅决定当前会话执行绑定，不改变列表可见性。

021 手动检查补丁已在阶段 5A 移除。官方实现已在空闲或检查失败时强制刷新，并按 available / ready 状态下载或安装；原补丁无条件强制检查会干扰后两种动作。恢复官方实现后，`main-startup.spec.ts` 的 114 项行为测试全部通过，6 个原失败场景恢复。平台安装更新仍另行验收。保留历史补丁编号，加入包内容治理的 039 后当前共 33 项。

001、002、003、005 在阶段 5B 移除，由 035 的产品接口承接；文案和图标值由 Studio 产品配置提供。默认 DSH 与配置后的 Studio 页面、打包 Desktop Host 的四类 Profile 均已完成本地验证。036 保留生成文档同步，037 保留独立的回放测试修复；这两项不与产品接口混成一个补丁。最终 Windows 和真实安装更新验收仍需独立完成。
