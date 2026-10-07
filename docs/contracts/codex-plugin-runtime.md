# Codex 插件与桌面依赖

## Studio 的实际调用链

1. 插件目录通过固定官方 CLI 启动 `codex app-server --stdio`，调用公开 `plugin/list`，
   读取市场、已安装状态、界面名称、说明、图标和 `featuredPluginIds`。仅投影展示字段，
   不把账户信息、原始配置或本地路径发给浏览器。目录读取与模型目录共用有界、可清理的 RPC 连接。
2. 不支持完整目录时回退到 `codex plugin list --available --json`。`--available` 不可省略：
   省略会漏掉未安装条目。大目录输出上限 16 MiB；仍失败时仅显示本机缓存并标明状态未确认。
3. 用户点击安装或输入 `plugin-name@marketplace` 后，Host 执行
   `codex plugin add plugin-name@marketplace --json`；卸载使用 `plugin remove`。
   需要官方安装确认或当前账户不可安装的条目不提供直接安装按钮。
   CLI 返回值必须是有效 JSON 且包含本次完整 pluginId，退出码为零不能单独确认成功。
   安装结果保留 authPolicy 和 appsNeedingAuth；不向浏览器回传原始 stdout 或安装路径。
4. 新建 Codex Agent 会话后，Codex App Server 从同一 `CODEX_HOME` 加载插件。未指定时使用
   默认 Codex 用户目录，因此与该目录的其他 Codex 客户端共享安装状态。

列表中的“已启用”来自 Codex 配置，不能当作外部连接器 OAuth 已完成或工具已执行成功。
Studio 当前未完整复刻官方客户端的账户、连接器授权、个人市场发布及全部插件界面能力。
官方本地市场与通用公开目录的说明见
[Package your plugin](https://developers.openai.com/plugins/build/plugins)。

## 能力、授权与实际调用

详情通过 `plugin/read` 查询声明的 Skill、MCP 和连接器；本地市场路径只在 Host 内解析。
连接器状态使用 `app/installed` 的实际快照，按连接器 ID 精确匹配 enabled/callable。
页面区分可调用、已禁用、尚不可调用、未连接或未加载和状态未确认，并提供官方返回的 HTTPS
授权地址；用户完成授权后可刷新。读取失败不会伪装为未安装或可调用，也不会自动修改权限。

`plugin/list` 和 `plugin/read` 在官方文档中仍标注为开发中；当前集成限定于固定 CLI 0.159.2，
须经真实协议验证后才能升级，不把这组接口当作稳定的公开产品兼容保证。生命周期继续使用 CLI，
未扩展到实验性的 plugin/install。参见 [App Server](https://developers.openai.com/codex/app-server)。

Codex 原生 mcpToolCall 的开始、成功、失败事件转发为 Studio 工具进度和 trace 事件，
调用仍由 Codex 执行，不把这些事件重新交给 DSH 执行。当前此类插件工具输入/输出尚未映射为
DSH 独立工具卡；进度和实际调用证据不能被写成原生工具卡已经完整复用。

`node scripts/verify-codex-plugins.mjs --execute` 可在独立 CODEX_HOME 中执行真实模型验收：
复用现有 auth.json、不复制个人插件配置，安装只含测试 Skill/MCP 的插件，询问普通测试卡片问题。
工具生成随机校验值，断言服务端实际收到调用、Studio 收到完成事件、回答含校验值，然后卸载并清理。
此模式需要有效 Codex 登录并消耗模型用量；不带参数的默认模式仅检查安装、加载和卸载。

## DMG 内容

Studio 固定依赖 `@openai/codex@0.159.2`。macOS ARM 离线包同时包含该 npm 启动包装、
`@openai/codex-darwin-arm64` 原生可执行文件及内置 Node；正常启动优先使用包内文件，
不要求用户先安装系统 Node、npm 或 Codex。`AGENTKIT_CODEX_BIN` 可显式覆盖执行文件。

打包 CLI 不等同于打包用户个人插件、账户凭证或外部服务。全新环境仍需要配置 Codex 登录，
按需联网下载插件并完成服务授权。离线可安装、启动 Studio，不表示云模型和联网插件离线可用。

## 2026-10-07 核验

- 固定 CLI 的实际 `plugin list --json` 返回 27 个已安装、0 个可安装；加入 `--available`
  后返回 27 个已安装、5412 个可安装条目，JSON 约 2.46 MB，超过 exec 默认缓冲上限。
- 同一 CLI 的实际 `plugin/list` 返回 3 个市场、5439 个条目、23 个精选条目。投影后 5423 个
  条目有图标，22 个条目保留账户或安装确认限制。这是本次账户和市场快照，不保证其他账户同样可见。
- 使用真实 DMG 中的原生 Codex 可执行文件，在独立 CODEX_HOME 中完成测试插件安装、已启用
  状态确认、App Server skills/list 加载与卸载。该测试不会修改用户个人插件；不证明所有连接器授权可用。
