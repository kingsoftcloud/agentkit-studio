# DSH v0.2.0-rc.2 补丁集

本目录保存 AgentKit Studio 对官方 DSH `v0.2.0-rc.2` 的**可审计、版本锁定的临时兼容补丁**。补丁不是 Studio 的运行时依赖，也不会被浏览器直接加载；它们只在官方 DSH 尚未提供等价公开扩展点时，供宿主构建或本地复现使用。

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
| `001-chat-thinking-copy.patch` | 将思考态文案改为产品中性的"正在思考中"（v0.2.0-rc.2 上游沿用 locale key 迁移为 `chat.deepDiving`/`chat.deepDivingFor`，补丁已按新基线重新生成） | 上游提供可配置文案或 Studio 公共 locale slot |
| `002-generated-conversation-copy.patch` | 调整会话输入占位文案 | 上游提供可配置 placeholder |
| `003-generated-locale-brand.patch` | 移除 DSH 默认 Hero 品牌文案 | 上游提供稳定品牌 slot 并覆盖所有 fallback locale |
| `004-sidebar-panel-lifecycle.patch` | 修复动态面板注册后的侧栏选择 | 上游侧栏生命周期修复进入发布版本 |
| `005-studio-fallback-brand.patch` | 宿主启动慢时不闪现 DSH Hero 品牌 | 上游 fallback 已提供产品级品牌扩展点 |
| `006-desktop-plugin-package-set.patch` | 让官方 Desktop package-set 接受额外的 Studio tarball，并把 Studio bundle 写入内置 Profile | 上游支持外部产品 bundle 的 Desktop package-set/profile 配置 |
| `007-sidebar-session-filter.patch` | 在 `ui-workspace/tree.ts` 新增模块级 `registerSessionFilter` API，让插件按 Agent 过滤侧栏会话列表 | 上游提供 `sidebar.workspaces.session.filter` 公共 slot |
| `008-agent-session-without-workspace.patch` | 允许已有 Agent 会话在未选择 Workspace 时直接使用原生 composer；Workspace 仍可作为 cwd/文件工具上下文 | 上游把 Workspace 从会话发送前置条件改为可选上下文 |
| `009-local-macos-package.patch` | 显式 `--unsigned` macOS 本地测试包复用官方离线运行时流水线；根 manifest 保留产品 bundle，干净 Profile 使用该 bundle，启动器从根 manifest 解析插件；Studio 跳过仅适用于 DeepSeek 的 welcome。支持产品名称和 macOS 图标覆盖，保留普通 DSH 默认品牌；正式签名、公证与发布门禁保持启用 | 上游提供 macOS 本地验收包、产品首次配置和打包插件解析的等价合同 |
| `010-session-model-default.patch` | 为公开 `session.selectModel` 增加可选 `saveDefault: false`，Agent 绑定和自动化只修改自己的会话模型；普通模型选择器仍保存默认值 | 上游提供会话模型选择与全局默认值分离的合同 |
| `011-cjk-autolinks.patch` | 原生 Markdown 的裸网址在中文标点前结束，避免加粗结束符及说明被拼进地址；复用 GFM 解析和既有流式渲染，保留显式链接、Unicode 路径及源位置 | 上游修复中文标点相邻的自动链接 |
| `012-preset-roster-invalidation.patch` | 注册表声明激活或移除后发布目录事件，经现有 Remote 转发让原生预设界面刷新；会话标签合并请求期间的变更，启动恢复后自动显示 Agent 名称 | 上游提供动态预设目录失效通知和请求合并 |
| `013-existing-product-profile.patch` | 已有 Desktop Profile 首次遇到新的产品 bundle 时补齐激活项，保留现有插件、设置和锁文件；记录已见默认项，保留后续用户或恢复操作的禁用选择 | 上游支持已有桌面 Profile 的产品默认项迁移 |
| `014-desktop-product-brand.patch` | 原生菜单、“关于”和恢复提示使用安装产品名称，修复图标已更新但仍显示 DeepSeek Harness 的混合品牌；保留默认 DSH 文案、模型提供方名称和用户数据目录 | 上游提供原生 shell 的产品品牌合同 |
| `015-compatibility-docs.patch` | 补齐会话过滤 API 的双语说明与 JSDoc，并通过官方生成器同步事件、Cordis API 与持久化目录；持久化类型摘要未改变 | 上游提供等价过滤、模型选择和预设目录事件合同，并同步对应生成目录 |
