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
for patch in "$PATCH_ROOT"/*.patch; do
  git -C "$DSH_ROOT" apply --check "$patch"
done
for patch in "$PATCH_ROOT"/*.patch; do
  git -C "$DSH_ROOT" apply "$patch"
done
```

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
