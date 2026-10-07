# 插件安装与加载合同

Studio 插件市场通过 Host bridge 执行插件生命周期。右上角“添加插件”输入安装源，
刷新按钮只重读目录。DSH 与 Codex 使用各自原生管理接口。

## DSH

- 复用 `pluginManager.listBundles/listPlugins/inspect/installBundle/setBundleEnabled/removeBundle`。
- `BundleInfo.installed=false` 表示 DSH 安装本身提供了该 bundle，并非需要下载。
  这类 bundle 在 Studio 显示为内置，选配 bundle 直接启用；基础宿主组件不能在 Studio 停用或卸载。
- `ChangeResult.application=failed/cancelled/overridden` 或包含 `error` 时，Host bridge 返回明确错误。
  `restart-required` 保留在成功结果中，页面提示重启 Host，不把保存配置解释为已加载。
- 安装源的 `inspect.status=refused` 会在下载前拒绝。更新直接安装新版本并保留当前启用选择，
  不先删除原有依赖。构建脚本审批和版本豁免继续由 DSH 原生管理流程处理，Studio 不自动批准。
- 详情中的“已加载”要求全部声明行的实际 `fiberPhase=active`；仅部分条目活跃时显示“部分加载”，
  配置选中但无法确认活跃行时显示“已选择”。
  清单保留 bundle 错误、条目失败、移除权限和宿主必需标记。目录刷新同时更新正在看的详情。

## Codex

- 使用 `codex plugin list --json` 的权威清单，以及 `codex plugin add/remove plugin@marketplace --json`。
  完整插件标识和市场名贯穿浏览器、Host 和 CLI；配置的 `CODEX_HOME` 与运行可执行文件保持一致。
- CLI 清单为空时保持真实空态。CLI 不可用时，缓存只作为只读记录展示，不声称插件已启用。
- 插件由新建的 Codex Agent 会话加载；连接器仍需要 Codex 原生授权。安装不会把连接器授权或
  Codex 专用 MCP 自动移植给本地 Harness。其他 Harness 可使用 Studio 的 Skill 导入和 MCP 绑定。

## 回归

`node --test tests/studio-plugins.test.mjs tests/studio-codex-plugins.test.mjs tests/marketplace-actions.test.mjs`
覆盖安装失败、检查拒绝、内置启用、失败状态、更新保留原版本、完整 Codex 标识、真实空清单、
缓存退化，以及页面操作后的状态刷新、错误和重启提示。

`node scripts/verify-codex-plugins.mjs` 使用临时 `CODEX_HOME`，通过真实 CLI 安装并卸载测试插件，
同时调用真实 App Server 的 `skills/list` 验证 Skill 已加载。它不触及用户的已安装插件或连接器授权。

## 2026-10-07 真实验证

- 旧安装流程在 rc.2 宿主上重复安装了 npm 的 Schedule rc.1，导致服务被兼容性检查禁用，
  只有 UI 入口活跃；原生任务页报“无法加载任务”。移除重复的 profile 依赖后，通过修复后的
  安装表单直接启用宿主自带的 rc.2 bundle，三条声明行全部活跃，原生任务页返回真实空列表。
- 网页添加 `yaml` 时，Host 明确拒绝 `declares no dsh.bundle`，未执行安装；错误保留在安装表单内。
- Codex 临时市场的测试插件通过真实 CLI 安装后，权威目录返回 installed/enabled；App Server
  返回该插件的 Skill，随后真实卸载成功。此验证覆盖本地 Skill 插件，不代表第三方连接器已授权。
