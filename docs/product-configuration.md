# 产品配置

`src/product.json` 是 Studio 产品输入的定义，`scripts/product-config.mjs` 是构建侧解析接口。插件品牌、Makefile 默认值、隔离桌面打包、可卸载的产品文案和发行工作流使用这些输入。产品文案扩展由补丁 035 提供，替代 001、002、003、005 的直接源码修改。侧栏名称、侧栏图标和首页图标使用 DSH 已声明的插槽；宿主及安装包的验收范围仍按各项记录判断。

| 输入 | 维护位置与解析规则 |
| --- | --- |
| 产品名称、简称 | `brand`，插件展示与桌面标题共享 |
| 产品文案 | 可选 `copy`，按 namespace 和 locale 贡献部分词条，支持 `{productName}` 模板；早期 schema 1 未声明此项时不贡献文案 |
| 插件版本 | `package.json#version`，配置只声明来源，不再维护第二份版本号 |
| 桌面版本 | 显式 build version 优先，否则使用固定 DSH 版本；仍由官方打包 CLI 接收 |
| App ID | `desktop.appId`，进入临时平台配置 |
| 更新源和通道 | `desktop.updates` 提供默认值；平台发行文件可显式选择 HTTPS origin、stable/preview 与环境，统一由解析接口校验 |
| 默认 bundle、插件入口包 | `desktop.defaultBundles`、`desktop.pluginRoots` |
| 图标和平台输入 | `desktop.platforms`，相对路径解析至当前源码目录，拒绝目录逃逸 |

发布签名、证书和凭证继续由 `.env.macos` / `.env.windows` 持有。临时配置将公开产品设置与原有发行设置组合，保留凭证值和相对证书路径的既有处理；不将签名材料写入产品 JSON、报告或客户端。打包结束清除临时发行文件。

配置只声明桌面默认 bundle。已有 Profile 的安装、用户禁用与迁移仍由 DSH 的产品默认 bundle 机制处理，不能通过重新写入 bundle 列表来强制启用用户已禁用的插件。`scripts/verify-studio-product-profiles.mjs` 用真实打包 runtime 验证新 Profile、已有 Profile 迁移、用户禁用后重启，以及只启用原生 bundle 的情况。每种情况启动两次，并检查用户配置保留、已有插件的运行和释放、Studio Host 接口、客户端挂载以及 IPC 正常退出。默认 DSH 的未配置构建另由 `verify-dsh-product-presentation.mjs --mode native` 验证。

`node scripts/build-product-host.mjs --source <DSH> --script build:official` 将公开产品输入交给官方构建入口。候选宿主接口保留 `DSH_CLIENT_LOCALE_OVERRIDES` 和 `DSH_CLIENT_BRAND_MARK_URL`，并写入客户端构建记录；未传入这些值时保留 DSH 原生文案和动画图标。官方构建的初始 HTML 标题仍遵循 DSH 默认值，Studio 挂载后通过有生命周期归属的文档标题贡献显示产品名称。直接运行 DSH 的 `build:official` 不会自动读取 Studio 配置。

运行时通过 `locale.override()` 贡献部分词条，并由插件的 effect 持有 disposer。后注册者只覆盖自己声明的 locale/key；卸载时恢复仍在生效的贡献或原生词条，不修改语言偏好和会话数据。构建输入负责插件激活前的文案与图标，运行时贡献负责插件自身的生命周期。

宿主没有可选的 `locale.override()` 时，插件保留原生文案，不注册同名词典或修改 DOM 文本。该展示层回退不放宽 Agent 预设、自动化和冻结运行时的准入检查。当前 DSH 基线和验证边界见[插件展示与 Host 兼容性](upstream-plugin-compatibility.md)。

两平台工作流使用工作流提交中的解析工具，读取已核验 App 源码的产品定义；名称、App ID、版本、更新源和 Windows 图标再传给后续任务。解析工具版本与签名 App 源码分别固定，不能把工具自身的产品默认值当成历史 App 的配置。macOS 的 `publish_feed` 仍默认关闭，Windows 诊断模式继续跳过签名与安装验收。

产品接口出现前的 0.0.1/0.0.2 源码，由只读的 `src/legacy-workflow-product.json` 记录原有产品身份；复用必须显式提供原 build version、channel 和 update origin。新源码若缺少产品配置、现有 JSON 无效或历史版本不在支持范围内，解析失败。该历史定义不参与当前产品构建，不应随当前品牌调整而改写。

Windows PowerShell 和完整工作流执行、历史签名产物复用及最终安装更新仍需实际平台验收。每次删除补丁继续要求原行为用例及最终宿主和安装包验收。

Profile 验收命令为 `node scripts/verify-studio-product-profiles.mjs --source <对应的已构建-DSH源码> --runtime <安装包组装出的dsh目录> --node <打包附带的Node可执行文件> --report <报告.json>`。命令使用独立临时 home，通过安装包的 `dsh-desktop-host` 入口启动；该入口以完整 runtime 的 package.json 解析产品依赖。普通 `dsh` CLI 使用自己的依赖图，不能替代这个桌面验收入口。报告记录源码指纹、runtime 描述文件及实际插件入口和客户端文件哈希；该检查不替代 Electron 外壳启动或真实安装更新。
