# Changelog

## 0.0.25 - 2026-11-27

### 修复
- 托管 Agent（`dsh-native` / `harness` / `codex`）的原地更新不再报 `DEPLOYMENT_UPDATE_SCOPE_CHANGED`：更新预览会沿用回执自己的 `DeploymentType`，不再回落到容器计划，`bucket` 与 `storageEndpoint` 也不再凭空出现；「内容未变」对托管部署比较运行声明，改过的提示词不会再被误判成「已在运行」。
- 云端声明漂移的回执不再死锁：预览先把它落到 `ACTION_REQUIRED`，之后「用所选版本修复」会以平台观测版本为并发保护，把冻结声明真正写回云端；作用域错误只点名字段，不再回显账号桶名与存储地址。
- 同一网关的多个模型在 portable 运行包里被误报为 `PORTABLE_MODEL_ROUTE_COLLISION`：`portable-resources.mjs` 投影 profile 时丢弃了 `connectionId`，身份退化成 `profile.id`，与路由的 `provider|baseUrl` 口径不一致。现在 `connectionId` 随 `MODEL_RUNTIME_OPTION_KEYS` 一起进入运行包，同一网关的模型合并为一条 DSH 路由并在选择器里同时出现。
- 模型能力目录的后台刷新在插件释放时不再泄漏定时器：每个在途请求的控制器与超时一起登记，`stop()` 同步清理句柄并中止请求，而不是让计时器活过 dispose。
- macOS 首次配置验收脚本与单步对话框对齐：标题断言改为「连接你的模型」，去掉已内嵌的「开始设置」点击，保存后引导直接关闭，不再驱动已移除的 `cloud` 三步流程。

### 工程
- 模型能力目录的新鲜度检查退出 PR 闸门：它实时拉取 models.dev，会按上游发布节奏自己变红，误伤与目录无关的改动。改由 `model-catalog.yml` 每日定时刷新并单独开 PR，`--if-stale` 保证上游没变时不产生空提交。

### 文档
- 更新配置参考中的插件版本号，补充 0.0.25 版本说明。

## 0.0.24 - 2026-11-26

### 新功能
- Studio 总览升级为可继续工作的 Agent 工作台：展示最近 Agent、24 小时运行指标与记录、待执行自动化和工作区状态；零 Agent 时改用创建与三步入门布局，不再堆叠空统计。
- 总览直接支持进入 Agent 对话，缺少模型凭证或没有可用模型时提供配置引导；模型设置、首次配置流程和能力目录同步完善，支持模型上下文窗口、视觉能力、推理档位及连接名称展示。
- 选模菜单与模型目录可展示 RouteMind 提供的模型评分、雷达图和相对价格；Star Harness 插件详情复用原生组件，支持签名版本、升级与回退。
- KSXC 网关不可达时隐藏内部运行时入口，网络恢复后自动还原；既有 KSXC Agent 保留编辑和模型绑定。

### 修复
- 中断的 Star Harness 任务可从原 Run 与事件游标续跑，避免重复执行已完成的工具调用；原生自动化与 Runtime Responses 继续保留 TokenUsage 统计，并覆盖持续网关故障后的恢复。
- ManagedRuntime 部署改为比较解析后的运行声明，不再因 JS 与 Python YAML 序列化差异误判来源不一致；真正发生漂移时进入 `ACTION_REQUIRED`，而不是永久停在「准备实例」。
- 修复 KSXC 设置首屏空白、首次模型引导重复弹出、模型预算保存误报及目录探测结果写回等问题。

### 文档
- 更新总览与 DSH Native 中英文界面说明，补充 0.0.24 版本说明及配置参考中的版本号。

## 0.0.23 - 2026-11-25

### 修复
- 从源码 checkout 加载 Studio 时，公共 Host 模块改从正在运行的 Host 入口解析：`@deepseek-ai/dsh-app-boot` 不再因不在 Studio 依赖图里而抛错，`dsh-llm` 也不再解析到第二份副本，`STUDIO_HOST_INCOMPATIBLE: DSH baseline` 误判消失。
- Anthropic 网关版本路径归一化补齐：本地 runtime 调用、Codex loopback proxy 和诊断 probe 不再把 `/messages` 直接拼到 `https://api.deepseek.com/anthropic` 上。
- 模型 transport follow-up：Anthropic Messages 协议、Codex commentary phase、DSH 凭证先写再启路由、legacy binding 不再拖掉整个模型的上下文窗口、不可读的 session header 回落到原 stream。
- Star Harness 与 Studio 解耦：生产路径不再打包 Harness 实现，改走签名插件通道；插件更新和重启保留 workspace 模型选择与原对话。
- 打包镜像的 Star Harness release 改从安装目录旁的共享目录解析，离线 smoke 与 Agent 首次启动都能找到已验签的 release。

## 0.0.22 - 2026-11-20

- 移除桌面端启动时的统计弹窗，在设置中提供基础运行、崩溃和本地 Run 统计的独立开关。升级时保留相同统计接收端和策略下的已有选择。

## 0.0.21 - 2026-11-20

- 修复桌面端校验 Star Harness 发布签名失败的问题，插件页可安装和升级到签名验证通过的 0.0.27，同时更新引擎与界面。
- 修复 Star Harness 在桌面端批准终端命令后丢失执行回执的问题。

## 0.0.20 - 2026-11-19

- 支持从 Star Harness 插件页安装和升级到 0.0.26，包含子任务结果、角色配色和验收标签修复。
- Star Harness 插件验证发布签名和兼容性，一次升级或回退同版本的引擎与任务界面。


## 0.0.19 - 2026-11-19

### 修复

- **`supportsStore` 按线路条件设置**：0.0.18 把它写在每条路由的 `compat` 上，而它是 `openai-completions` 独占的键。profile 声明 `protocol: openai-responses` 时，DSH 直接拒绝整个模型配置：

  ```
  llm-pi-ai: provider "agentkit-studio-default" sets compat "supportsStore",
  but no model on the route speaks a protocol that takes it;
  it exists on openai-completions
  ```

  也就是说 0.0.18 加的 Responses 支持救不了自己 —— 切到 Responses 反而保存不了配置。现在两个 bridge 都只在 `openai-completions` 线路上发这个键；`supportsDeveloperRole` 不受影响。新增两条测试钉住分界（Responses 线路断言该键不存在，chat 线路断言存在），回滚修复会让前者变红。

### 说明

- 0.0.18 的 npm 包与桌面端候选都含此缺陷。不声明 `protocol` 的 profile 不受影响（仍走 Chat Completions），本补丁只为让 Responses 线路可用。

## 0.0.18 - 2026-11-19

### 功能：模型线路与推理档位

- 模型设置新增「DSH 接口」探测：星流的 `/v1/models` 不声明任何能力位（没有 `native_endpoints`，没有 Responses 支持标记），所以表单改为**问一下**——「探测接口」按钮发一个最小的 Responses 请求，**只把 404 判为「只支持 Chat」**，超时 / 401 / 5xx 一律「无结论」，绝不可达的网关写成事实。判定后给出「让 DSH 走 Responses」或「改回 Chat Completions」的一键应用，探测本身只读、不写配置。配套 `scripts/verify-model-wire.mjs` 报告整个网关。
- `providerWireApi()` 让 DSH 路由跟随 profile 的 `protocol` 声明。**`codexApi` 刻意不参与**：它是「Codex 模型接口」选择器且默认 `responses`，拿它定 DSH 线路会把所有 profile 翻到 42/59 模型 404 的线上——这正是这个方向之前被回退的原因。
- 推理档位表按实测修正：`ksyun` / `deepseek` 从 `low/high/max` 改为 `low/medium/high/xhigh/max`（7 个模型 × 2 条线实测，`low` 到 `max` 全部 200），选择器补上「中」「极高」。`minimal` 明确排除——`glm-5.3` 把它当「关闭思考」直接拒，`kimi-k3.1-pro` 在 Chat 线接受、Responses 线拒绝。
- 新增 `scripts/verify-model-efforts.mjs` 逐模型逐档探测实际可用的推理级别。
- profile `compat` 补上 `supportsStore: false`：代理是无状态的（`previous_response_id` 直接被拒），只实现旧请求形状的网关（LiteLLM 一类）可以白拿这个键的移除。

### 修复

- **不再把 `developer` 角色发给网关**：OpenAI 接受两种拼写，但多数 OpenAI 兼容网关只实现 `system`，收到 `developer` 回 `400 Invalid request: role 'developer' is not allowed`。代理在发送前统一改写，DSH provider 声明 `compat: { supportsDeveloperRole: false }` 让 pi-ai 一开始就发 `system`。
- **路由默认值不再落到目录里的 sibling 模型**：目录路由把每个模型都发布成 sibling，而 DSH 把路由级 `reasoning` 默认值应用到全部模型；配过 `reasoning: max` 的 profile 切到 `kimi-k3.1-pro-highspeed` 这类模型时，每一轮都在请求离开 DSH 之前以 `UNSUPPORTED_REASONING_EFFORT` 失败。默认值现在只写给独占路由，且默认思考等级写到「默认模型选择」而不是继承上一个 profile 残留的值。
- 注册 `models/probe` 与 `models/wire` 两个控制端点：`models/wire` 一路实现到 RPC 却没进白名单，按钮点下去只回「无效 Server Action」；`models/probe`（「读取模型」）从引入起就一直没注册过。
- 恢复原生会话里的 Codex 工具卡片。
- 恢复 ManagedRuntime Agent 的云端会话，并把 Harness 引擎启动契约转发给 Host 子进程。
- Studio 卸载时取消默认 bundle 的定时器；首次引导中的 profile 不再被默认 bundle 对齐抢写。

### 测试

- 新增 `control-endpoint-registration`：对比浏览器 `studioCall` 字面量与 `STUDIO_OPERATION_IDS`，把「调用了但没注册」变成门禁失败（手动回滚注册验证过两个用例都会红）。
- 新增 `verify-studio-model-settings-web.mjs`：真实浏览器打开隔离 Studio web，断言推理档位选择器渲染全部五档、「探测接口」按钮可达、判定回显、无 console 错误（7/7）。
- 生命周期验收改在 `AGENTKIT_STUDIO_DEFAULT_BUNDLES=0` 下跑，默认 bundle 对齐不再是插件自有状态。

### 已知问题

- 星流 59 个模型里只有 17 个实现 `/v1/responses`，其余 42 个（图像 / 视频 / 语音 / embedding）会 404；`providerWireApi` 因此只按显式 `protocol` 走 Responses，未声明的 profile 保持 Chat Completions 不变。
- `qwen3.7-plus` 拒绝 `xhigh` / `max`，但它的 400 报文含 `reasoning_effort`，会命中代理的自动降级重试；精确档位请用 `scripts/verify-model-efforts.mjs` 逐模型确认。
- 桌面端自动更新在有运行中任务时，第一次安装可能被 Squirrel 的 ShipIt 以 `App Still Running Error` 放弃；升级前先停掉运行中的任务。

## 0.0.17 - 2026-11-17

### 修复：恢复 0.0.16 丢失的功能

- 模型与凭证设置的「请求预算与请求头」回到界面：按模型配置最大输出 Token、上下文窗口、请求超时（毫秒）与自定义请求头（可增删的键值行）。请求头随「读取模型」的目录读取一起发送（配置的 `Authorization` 优先于凭证生成的 Bearer），名称按 RFC 7230 token 校验、值拒绝换行等控制字符，空行与重复名称在保存时丢弃；预算必须是大于 0 的整数，留空沿用网关默认值。字段随 `modelProfiles` 持久化，`config.yaml` 与导出的运行包往返都保留。
- 恢复经 magpie 等严格网关的 `400 Invalid assistant message: content or tool_calls must be set` 与 `400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` 修复：发送前丢弃只有推理的轮次、既无文本也无工具调用的空 assistant 轮次，以及孤立的工具回执（回执与调用按 `call_id` 配对），两者都只在网关拒绝后重试一次。
- 流式 Action（`RunAgent` 等 SSE 接口）恢复按真实状态码抛 `AgentEngineError`：网关返回 `{ Code, RequestId, Error }` 信封或非 `text/event-stream` 响应时（429 → `SERVER_RATE_LIMITED`，信封错误 → `SERVER_ACTION_FAILED`，其余 → `SERVER_INVALID_RESPONSE`），不再显示为 SSE 解析失败或卡住。
- 恢复共享的请求头校验契约（`HEADER_NAME` / `HEADER_VALUE` / `HEADER_LIMITS` / `headerEntryProblem` / `requestHeaders`）与 `modelRuntimeOptions` 的 `headers` 投影；`config.yaml` 层同样校验（64 条上限、大小写去重、空表删除字段）。
- 以上功能由 #176 引入、被 #177（文档站）在 rebase 时整片回滚；本次从 #175 逐字恢复 10 个源文件与 6 个测试文件（108 个用例）。

### 功能

- Studio 默认启用两个官方 bundle：「自定义插件索引」与 Computer Use（`@deepseek-ai/dsh-cua-bundle`）。Host 首次以某个 DSH 版本启动时按 profile 对齐一次——随包安装的直接 `setBundleEnabled`，按需安装的先安装再启用；同一版本内不重复应用，用户关闭后不会被重新打开，`AGENTKIT_STUDIO_DEFAULT_BUNDLES=0` 可整体关闭。

- 删除 Studio 自建的插件市场，插件市场交还 DSH 官方：移除「插件市场」`plugins.item` 行、发现插件 UI、`studio-plugins` 适配层、npm 搜索 + GitHub 搜索聚合（一次市场页从 16 个外部请求、最坏 24 s 降到「每个索引源 1 次 GET」）及 `plugins/dsh-*` 控制端点。市场现在是官方「插件」页的「已安装 / 发现」两个 tab，索引由 Host 的 `pluginMarket` 服务读取；Studio 只保留随包内置的社区插件索引（`pnpm build:plugin-index` 生成、`pnpm check:plugin-index` 在 CI 校验，Host 在 `/api/agentkit.plugin-market/index.json` 提供给官方读取器）并在 profile 没有索引源时添加为默认源。

### 已知问题

- 桌面端自动更新在**有运行中任务**时，第一次安装可能被 Squirrel 的 ShipIt 以 `App Still Running Error` 放弃：ShipIt 只等约 3.4 秒，而「退出 AgentKit Studio？当前正在运行的任务将会中断」确认弹窗会吃掉这个窗口。**升级前先停掉运行中的任务**即可一次成功；第二次点击时更新包已在 `pending/` 缓存里，会直接安装完成。上游修复见 [Squirrel.Mac#339](https://github.com/Squirrel/Squirrel.Mac/pull/339)。

## 0.0.16 - 2026-11-17

- Star Harness 使用 Studio 随包发布的固定摘要校验运行时及其依赖，通过校验后再启动。插件只接管已绑定的工作区。

- 流式 Action（`RunAgent` 等 SSE 接口）不再把「HTTP 200 + JSON 错误信封」当成事件流：网关在流式接口上返回 `{ Code, RequestId, Error }`（例如 `Code: 409` 运行时就绪）或非 `text/event-stream` 的响应时，客户端按真实状态码与 `requestId` 抛出 `AgentEngineError`（429 → `SERVER_RATE_LIMITED`，信封错误 → `SERVER_ACTION_FAILED`，其余 → `SERVER_INVALID_RESPONSE`），界面显示真实原因而不是 SSE 解析失败或卡住；未带 content-type 的响应保持原有行为，KOP inner-account 403 回退不变。

- 修复经 magpie 等严格网关时的 `400 Invalid assistant message: content or tool_calls must be set`：Responses 线只接受「带文本的 assistant 消息」或「带工具调用」的轮次，而重放的 `reasoning` 项会在模型上一轮没有产出文本与工具调用时形成只有推理的轮次。代理现在把这种轮次的 `reasoning` 项整体丢弃（有文本或工具调用的轮次保持原样，推理连续性不变），并顺手丢弃既无文本也无工具调用的空 assistant 轮次；两者都只在网关拒绝后重试一次。此前「去掉 `content: null` 再重试」的修复对这类请求是无效的（重试体同样被拒）。同一条链路上还会出现 `400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`（历史里只剩工具回执、对应调用已被裁掉）：代理现在同样在发送前丢弃孤立回执，回执与调用按 `call_id` 顺序配对。

- 模型与凭证设置的「高级」段新增默认收起的「请求预算与请求头」：按模型配置最大输出 Token、上下文窗口、请求超时（毫秒）与自定义请求头（可增删的键值行）。请求头随「读取模型」的目录读取一起发送（配置的 `Authorization` 优先于凭证生成的 Bearer，不同请求头各自读取一次目录），名称按 RFC 7230 token 校验、值拒绝换行等控制字符，空行与重复名称在保存时被丢弃，全部清空即移除该字段；预算必须是大于 0 的整数，留空沿用网关默认值。字段随 `modelProfiles` 持久化，`config.yaml` 与导出的运行包往返都保留；未配置时请求与历史行为完全一致。
- 托管 `RunAgent` 用平台 `SessionId` 继续同一会话；可选的 `UserId` 和 `BusinessSessionId` 分别透传为绑定 MCP 工具的 `businessUserId` 和 `businessSessionId`，通过 `_meta` 和 HTTP 头发送。业务归属不参与平台鉴权，也不进入模型请求或 transcript。`AGENTKIT_MCP_BUSINESS_IDENTITY=require` 只要求业务用户；旧记录中从平台会话复制的业务 ID 不再发送。详见 `docs/mcp-invocation-identity.md`。


- 升级 Studio Harness 到 0.0.25：原生消息保留已发送图片与纯图片消息（缩略图、放大、历史刷新），纯回答的每轮耗时改用已提交起止时间；新增转发事件唤醒与浏览器绘制合并，真实模型正文更新可测量。
- 多工作区独立 Harness：Studio 按会话持久化的工作区各自连接独立 Harness 服务，切换 Alpha/Beta 后模型、工作目录和历史跟随各自服务；未绑定目录明确拒绝，不回落到其他项目。
- 移除生产进程内 Harness：删除进程内 Harness 启动、执行/工具工厂桥、旧 `sessions/native-*` 控制入口和三个 bundledDependencies，执行只走独立服务或显式外部命令；锁定 npm Harness Core/Node/UI 0.0.25（同步 lockfile、Core override 与逐文件 registry pins）。
- 交互修复：显式依赖完整会话展示接口，移除重复引擎 iframe；过程默认折叠、用量保留在输入框底部、失败以中性色摘要展开查看完整原因；保留带请求身份、游标和偏移的正文增量、图片能力握手、按账本期限等待重试和按请求回执去重的用户气泡；独立引擎读取搜索提供方配置，未配置时不向模型提供无效的 `web_search`；Ezone 安装超时由独立进程组监管。
- 验证：三个 npm 包均核对发布来源和归档摘要，安装后校验 541 个 Harness 文件与 551 个 Studio 归档文件；真实打包 Studio 使用 DeepSeek V4.1 Flash 完成联网搜索，只有一个 Native 视图，升级前后 45 个 Run 记录逐一保持不变。
- 发布门禁跟上新的 Agent 列表交互：「手动配置」改为从「更多创建方式」菜单进入，运行时改由 radiogroup 选择，客户端页面验收重新走通创建与编辑绑定流程。

## 0.0.15 - 2026-11-16

- Studio 连接独立 Harness 服务并恢复任务投递：原生会话、Team 角色和绑定的 A2A 任务都交给独立服务执行，审批决策、排队引导和原始 A2A receipt 随 Run 回传；桌面端重新连回原始 Run 与 A2A receipt，任务进度和交付网站在侧栏直接打开。浏览器工具改走 Host 批处理执行器，启动错误与匿名轮次分开处理，折叠的失败轮次在 hydration 后仍能展开；托管 transport 边界与 Run 引擎补齐集成测试。Studio 固定已发布的 Harness 0.0.20 包。
- ManagedRuntime 统一交付 Studio bundle：portable bundle 改用托管 MCP 的 env 名，云端资源跳过托管 bundle 上传；CI 复用 Playwright Chromium 缓存。

- 托管运行时把 `AGENTKIT_CODEX_*` 调整项（`TIMEOUT_MS` / `IDLE_TIMEOUT_MS` / `STREAM_IDLE_TIMEOUT_MS` / `MODEL_IDLE_TIMEOUT_MS` / `MODEL` / `SANDBOX` / `APPROVAL_POLICY` / `REASONING_SUMMARY`）加入 Host 子进程的 env 白名单：之前 `codex-runtime` 会读这些变量，但白名单没放行，长任务的超时预算实际上是硬编码的，只能靠发新镜像调整。
- 托管 DSH 的 Hosted UI 会话注册表改为 **Agent 作用域**（`<state>/managed-sessions`），不再放在版本目录下：此前每次被接受的 UpdateAgent 都会换到一个空的注册表目录，Hosted UI 于是列不出、也打不开更新前的会话，尽管 DSH 原生 transcript 一直保留。首次启动会把最近写入的一份旧版本注册表复制过来（旧目录保留供旧镜像回滚），`AGENTKIT_MANAGED_SESSIONS` 由 Host 显式导出，未提供时回退到旧的版本目录。
- 一个 Agent 的 DSH home、用户 home 与工作区跨部署版本保持：只有不可变 receipt 和导入的 running bundle 按版本隔离，接受 UpdateAgent 后不再从空的 DSH home 启动；最近一份带会话状态的旧版本目录用硬链接一次性接管（源目录原样保留供回滚），profile marker 改用 Agent 身份。
- 从 Agent 作用域会话注册表解析资源身份：Host 同时读取 `AGENTKIT_MANAGED_SESSIONS`，版本目录只在未显式提供路径时回退，并加 wiring guard 防止两份注册表再次漂移，修复更新后 Hosted UI 列得出会话却以 `MANAGED_RESOURCE_IDENTITY_UNAVAILABLE` 失败。
- Codex 多轮 400 修复：`local_shell_call` 与其输出现在参与 Responses→Chat 转换，缺失 `call_id` 的输出按顺序与待处理调用配对；重放的 reasoning item 原样转发，只有 provider 真的拒绝时才去掉 `content: null` 重试一次，未相关的 400 保持原样。超出 yield 预算的命令按运行中继续（带 `sessionId`），并观察 `write_stdin` 输出，长命令不再以 `RUNTIME_RUN_FAILED` 收场。
- 资源重试与 MCP 会话恢复落地第一批安全修复：托管 Memory 写入不再自动重试，MCP 首次并发建连使用 single-flight，已有 session 明确返回「session not found」时清理缓存并重建、最多重放一次；资源事件、UI 动作与 safe-read 仍按后续阶段验收。
- 恢复冻结 host 的 MCP 轮次并延长 deadline：冻结运行时请求预算改为 15 分钟（`AGENTKIT_RUNTIME_TIMEOUT_MS` 可调），首次 turn 的 schema 以冻结契约为准，不再因预设晚挂载丢工具或整轮失败。
- 浏览器 bundle 尺寸预算成为门禁：`scripts/verify-client-modules.mjs` 接入 `pnpm check`，基线与其允许增量一起入库；只统计 allowlist 之外的 `node_modules` 输入，第三方包内部循环降级为报告，Studio 自身模块必须无环。
- 部署面展示冻结运行时镜像 tag：部署记录的 meta 行与详情显示镜像 tag，更新检查预览拆成当前镜像与目标镜像（tag + digest），只改展示不改部署行为。
- MCP 资源页的「认证 Header / 环境变量凭证」改为可折叠的进阶区块：默认收起，识别到自定义 Header 时自动展开；仍可直接填 Header 名称与凭证名称添加凭证行。JSON 输入框随内容自动增高，多服务配置不再挤在 5 行里。
- 修复浅色主题下主按钮 hover 时文字不可见：全局 hover 规则不再把白色标签的主按钮改成浅色底，`.sq-btn.primary` 等类样式按钮与凭据引导弹窗一并覆盖；禁用态主按钮的标签改用次要文字色。
- 新建 Agent 默认运行时改为 DSH Native，并在创建流程中暂时隐藏 Star Harness（编辑既有 Star Harness Agent 不受影响），待该运行时稳定后再开放创建。
- Studio 界面按 DSH 设计系统统一：Agent 表单改用共享表单原语并合并为三步（运行时在绑定能力之前选择，切换不再静默重置已绑工具），Agent 列表入口页改为分段控件加「更多创建方式」菜单，资源库、交付与运行中心等页面统一 DSH 设计 token；macOS 图标按 Apple 824px 网格留白，Windows 使用全出血图标。
- 桌面端本地 Host 认证与 Chromium 隔离，并用 bundled pnpm 恢复插件 profile；专家分组以原生 DSH team 运行，冷启动 team 保留 native lead；Codex reasoning 与托管会话正确渲染；预留 native team 工具与默认模型；Agent 会话绑定到作用域 preset；恢复打包技能与托管运行时管理。
- 保留被拒绝的上游请求的诊断信息（原始 name、数字 code、受限 message 与调用点），run 失败在 code 归一化前记录原始信息；长 AbortSignal 截止时间在进程入口与创建时追踪并记录 abort 来源；组合后的 Agent preset 日志让 bash 超时能点出具体工具。CI 的 mounted Studio Native Host proof 改为非门禁项。
- 重新固定官方 DSH Windows 安装器摘要。

## 0.0.14 - 2026-11-10

- 将 Host 云端配置与 AgentEngine client 以通用 `agentkitHostCloud` 能力提供给独立 DSH 插件；Studio 不再包含个人助理运行时、Host 路由或产品私有服务。
- 修复长时间 Codex 模型调用与 OTLP trace 的稳定性，保留会话、运行时和可观测性状态。
- 合并自 0.0.13 以来的 MCP 自定义 Header、原生审批恢复、部署存储、更新车道、资源降级与 DSH 0.2.2 兼容性修复，完整门禁与 patched DSH Host 均通过。


- 修复托管 DSH 的 OTLP 证书信任：支持 OTel 标准的 `OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE` / `OTEL_EXPORTER_OTLP_CERTIFICATE`（PEM 路径），并把证书**追加**到平台默认信任库，而不是替换——旧的 `DSH_OTEL_CA_PEM_BASE64` 直接覆盖 `ca`，会把 CloudMonitor 次路一起打挂。Host 的托管可观测 env 白名单同时转发这两个变量；预发 Langfuse 换成受信任证书后 DSH trace 即可正常上报。
- 修复托管 DSH 实例“更新后会话消失”：每次被接受的 UpdateAgent 都会生成新的平台 VersionId，而 Host 曾把 `DSH_HOME` 放在 `versions/<sha256(VersionId)>/dsh`，新版本因此从空会话目录启动，旧日志仍留在旧版本目录。托管运行时的 `DSH_HOME` 改为每个 Agent 一份 `<state>/dsh`（DSH 原生会话、storages、凭证与 Settings 跨版本延续），Studio 的不可变 receipt 与模型配置仍按版本隔离；升级到该布局后的首次启动会用硬链接接管**最近写入**的一份旧版本目录（旧目录原样保留，供旧镜像回滚），记录 `.dsh-adopted.json`，并把旧 profile 的用户 Settings 种子到新 profile。范围仅限 DSH 原生会话历史；平台侧 managed session 注册表仍按版本隔离，跨版本复用需另行评审。
- 桌面更新不再让历史安装“每次只前进一版”：`desktop-release.mjs publish` 在 feed 校验通过后自动把同一份 feed 字节镜像到兼容 `preview` 车道（macOS 默认只写发布布局本身，Windows 两个发布脚本同时写 `studio` 与 `dsh-desk` 旧入口），幂等、不重复上传、不改动任何签名二进制；`latest`/`stable` 车道改为在版本带 prerelease 时于打包前直接拒绝，产品默认车道保持 `nightly`。
- macOS 桌面端的总览、资源库、运行中心三页补一条统一的顶部拖拽条：只在 Electron + `data-platform='darwin'` 的文档上，把透明 `-webkit-app-region: drag` 条（左 80px 避开红绿灯、右 0、高 40px）插到 React 根之前，DSH 侧栏开关等后续 `no-drag` 控件自动从拖拽面中扣除；仅 Studio chrome 页挂载，DSH 原生会话页和「智能体」页不受影响，全屏时随原生标题带一起隐藏。
- 托管运行时的模型上下文窗口改为从模型网关 `/v1/models` 的 `context_length` 读取，不再固定为 128000：模型实际声明 1024k 时，长会话不会再在远低于真实上限处触发上下文压缩，减少压缩时的工具结果裁剪及其引发的会话投影读取失败（输出预算仍保留 8192，目录不可达时回退原默认值）。
- Register the plugin market's `plugins/dsh-discover` bridge endpoint (and the previously missing `plugins/dsh-index-refresh`) in the Studio operation allowlist so the Host accepts them instead of rejecting them as unknown control endpoints.
- Turn the DSH plugin market into a discovery surface instead of a mirror of the official installed list: aggregate npm (`keywords:dsh-plugin`) and GitHub (`topic:dsh-plugin`) metadata over a curated offline shelf, with category filters, download/star/update sorting, detail cards and one-click install, while installed lifecycle management stays as a second tab. Discovery uses a 10-minute memory+disk cache and keeps serving the last good catalog when the network fails.
- Add a DSH plugin market as a row inside the official 插件 page (public `plugins.item` slot, no sidebar entry or second plugin center): curated offline catalog, optional HTTPS remote index refreshed without a release, search/category filters, manual spec install, and install/enable/disable/update/uninstall through the official plugin manager with row/service readiness probes and honest failure reporting.
- Fix the market lifecycle on the real Host: the DSH plugin surface mounts the plain product client, so the install/enable/disable/update/uninstall methods now live on that client instead of only the compatibility extension. Install, enable and disable were verified end-to-end against the packaged DSH 0.2.1-rc.2 Host.
- Generate the installed `dsh` terminal launcher from the packaged product name instead of a hardcoded `DeepSeek Harness`, restoring the CLI for product builds while official builds keep the upstream default (DSH patch 051).
- 云端镜像目录出现当前 Studio 尚未实现的能力声明时，只停用该镜像版本并回退到最新的兼容镜像，同时给出升级提示；不再因一次新镜像发布拒绝整个目录，导致旧客户端无法部署任何 Agent。
- 云端镜像目录把预发候选（`channel=preview`）发布到非 `pre-online` 环境时，同样只退役该版本并回退到已发布镜像，同时提示目录维护问题；不再因一次误把预发目录复制进线上就让整个环境的创建、升级和回滚全部不可用。显式选择被退役版本时以 `DEPLOYMENT_IMAGE_RETIRED` 说明原因。
- 云端 Codex 运行时默认以 `danger-full-access` 启动（部署可用 `AGENTKIT_CODEX_SANDBOX` 收窄，审批默认 `never`）：容器本身已经是隔离边界，而 Codex 自带的 bubblewrap 沙箱在只读 rootfs + drop ALL 的 Pod 里根本无法启动，此前写死的 `read-only` 只是把 Agent 变成只读。
- 托管运行时把 HOME 指向挂载的家目录（默认 `/home/node`），`~/.codex` 与 `~/workspace` 随家目录持久化；部署持久化目录从 `/var/lib/agentkit` 改为 `/home/node`，Studio 自身状态仍按版本隔离。云端自动化在没有收到权限模式时按镜像声明的默认档执行，不再回落到 `read-only`；权限选择器（本地 Studio、Studio 云端与 Hosted UI 共用同一份会话预设）现在逐轮作用于 Codex 的沙箱，而不是只改 DSH 侧的工具权限。
- 绑定资源部分不可用不再让整个 Agent 无法对话：默认按降级运行（缺失的 MCP/Skill 不进工具集，并在系统提示词里点名），只有设置 `AGENTKIT_STRICT_RESOURCES=1` 的部署才保持原 fail-closed 行为，且报错会带上是哪个资源、什么错误码。
- 部署记录目录不支持目录 fsync 时（网络主目录、同步盘、部分安全软件过滤）不再让「确认创建云端实例」以裸 `EPERM: operation not permitted, fsync` 失败：目录 fsync 降级为尽力而为（记录内容本身仍按文件 fsync 落盘），其余本地 I/O 错误改为带路径与处置建议的 `DEPLOYMENT_STORE_IO_FAILED`；磁盘在检查部署阶段即预检，不再等用户点了确认才暴露。
- Raise the development and CI Node.js baseline to 22.23.4 (or 24.22.1 / 26.12.1) for the October 2026 security release, and fail fast in `pnpm check`, the development doctor and CI when the runtime predates the fix.
- Adapt generic Hosted UI Actions to frozen Studio runtimes with verified account isolation, native DSH history recovery, and explicit stream failures; retain existing personal assistant data and permissions.
- Keep the assistant conversation quiet: one native attachment picker, concise errors and on-demand connection diagnostics.
- Open assistant links in an instance-scoped native Studio browser pane with explicit external opening and cleanup on close or assistant change.
- Replace the one-shot delay form with the native DSH task manager, recurring rules, complete-record editing and delivery history; admit only trusted native schedule tools scoped to the current assistant Session.
- Add a secret-free Ubuntu PR browser acceptance stage. Full-access cloud execution still requires a separately isolated executor; current deployment and existing Session permissions are unchanged.

- Fix normal portable assistant cold startup and process-restart scheduling through profile-owned plugin resolution and native runtime readiness dependencies; add an installed CLI startup/restart CI smoke.

- Connect personal assistants to an isolated native cloud conversation with durable submission, scoped retry and cancellation, paginated tool history, and verified image and file attachments.
- Add explicitly provisioned managed assistant workspaces with bounded file tools and live single-action deletion approval; preserve existing assistants and their stored permissions.
- Stage verified uploaded files into a managed assistant's own workspace so it can read attachments without access to the private attachment store.
- Wait for the authenticated cloud Session catalog before opening its native composer, and grant catalog reads only for that exact Session.
- Give each explicitly saved memory fact its own completed ingestion batch, preserving the assistant conversation and memory partition across successive saves.
- Add a cloud-only file picker to native assistant input and keep redacted message history compatible with the complete native view registry.

- Keep automatic titles and other auxiliary model requests out of bound resource execution and long-term memory writes by checking the running DSH Agent loop request marker.

- Display verified cloud execution policy independently of the local permission picker, retain unknown policy for older runtimes, and stop attributing automated approval rejections to a user action.

- Keep cloud Node 22 resource, model and MCP POSTs on DSH's Undici transport so the first web fetch cannot break subsequent requests with an invalid content-length header.

- Prevent plugin inspection snapshots from terminating the Host when their retained-record envelope reaches the frame limit.
- Show personal assistant task failures with an explicit retry action, omit empty tool-only replies, and bind personal assistant conversations to the verified cloud instance instead of its local configuration.

- Publish accepted Windows installers and blockmaps to KS3 before advancing the canonical and compatibility feeds; require original signing, actual installation and native UI evidence when reusing candidates.

- Align the cloud HTTP transport with the Host's Undici version and pair its fetch with its dispatcher, preserving both the sealed archive and the packaged Node runtime contract.

- Show an assistant setup failure once, stop the progress spinner, and keep the cloud settings and deployment recovery actions available.

- Allow self-signed runtime certificates only for explicit pre-online Agent connections, with redirects disabled. Keep production, control-plane and download TLS verification unchanged.

- Give deployment test background operations a bounded ten-second wait with terminal-state diagnostics; cover slow uploads so busy CI workers do not fail a valid deployment after 1.5 seconds.
- Fetch Ezone's checksum-pinned offline worker tools from a dedicated CI cache so deleting obsolete development branches cannot break clean-clone gates.
- Keep native DSH copy when the optional product locale extension is absent, and remove the undeclared hero-name slot without weakening execution admission.
- Read signed candidate job logs with both current and older GitHub CLIs; retry only an unsupported output flag and preserve source, version and artifact checks on macOS and Windows.

- 修复安装包指纹测试未等待 ASAR 输出流写完的竞态，避免 Linux 门禁读取尚未落盘的归档。

- 同步新版 DSH 本地打包测试：验证 ad-hoc 签名、公证关闭及更新策略元数据缺省行为，修复完整 Host 门禁中的过期断言，不改动正式签名流程。

- 修复 macOS 更新发布与公网校验仍使用旧 feed 目录的问题，统一使用 App 内置的 `studio/feeds/mac-arm64/`，并清理新版 Host 的旧调度组合包配置。

- Upgrade the Host, desktop packaging, Harness contract and plugin manifests to official DSH 0.2.1-rc.2. Migrate the maintained patch series to the pinned source and require this DSH version at runtime.
- Adapt team message forwarding to direct Inbox delivery so member reports reach the lead model. Install missing official plugin bundles through their exact Host-provided target, and use the new built-in scheduling service.
- Require a valid packaged update source before accepting signed desktop artifacts. Support signing with an explicitly selected existing macOS keychain without exporting private keys.
- Show the environment and region when a cloud runtime image catalog is absent, with an entry to the cloud settings. Preserve the user's selected environment.
- MCP 资源页的 JSON 识别不再只认 `mcpServers`：同时支持 VS Code 的 `servers`、裸名称映射、单个/多个服务配置和数组；`type: sse` 不再被当成 HTTP 处理。自定义认证 Header（如 `X-Service-Token`）会转成 Host 凭证引用（`server.envRefs`），字面量密钥只写入本机凭证服务、不落资源目录；本地 MCP 存储现在也拒绝非 `env://` 的凭证引用，避免明文密钥被写进记录文件。新增识别摘要、多服务选择和按 Header 的凭证输入行，可配置和轮换非 Authorization 认证 Header。

## 0.0.13

- Remove Personal Assistant runtime, Host routes, contracts, documentation and tests from Studio so the package remains a generic DSH plugin.
- Keep the Studio surface compatible with DSH 0.2.2 public APIs and add a standalone DSH plugin purity gate.
- Verify the decoupled package with the complete Studio gate: 5180 tests, 5178 passed, 0 failed, 2 skipped.

## 0.0.12

- Upgrade Studio's pinned DSH baseline to `dsh-v0.2.2-rc.1`; the maintained series now has 43 active patches and 7 retired entries.
- Add native prompt prediction with bounded Host context, ghost-text acceptance (Tab/Right Arrow), Escape dismissal, a local Settings toggle, and fail-closed behavior when history or model state is unavailable.

- 去掉覆盖在窗口顶部 30px 的全宽透明拖动条：它把页面顶部的按钮盖在拖拽区下面，点击被吞掉、必须点得非常精准才生效；窗口拖动改由标题行/页头的 `data-studio-drag-region` 承担，交互元素保持 `no-drag`。
- 桌面端启动对齐改为“物化”而不是“退役”：把运行时内置的产品插件连同其依赖闭包按文件写入 profile（Electron 的 asar 没有目录句柄，`cpSync` 会把 `.6` 直接拷崩），钉住版本，并在原生恢复清空 `dsh.profile.bundles` 后把 `@kingsoftcloud/agentkit-studio` 补回——此前正是这一项缺失导致界面只剩默认 DSH、插件根本不参与加载。
- 装完必须“可加载”才算成功：每个非安装自带的依赖都要从 profile 锚点解析成功、每个相对导出入口都要存在；校验不过就回滚 `package.json` 与旧副本，绝不删除原本可用的插件。同一版本连续失败两次后停止尝试。
- Host 侧对齐不再搬迁/删除 profile 副本，只补齐 bundle 选择并校验可加载性；`.alignment-attempt` 预算保留。

## 0.0.11

- 桌面端启动时的插件对齐不再把运行时自带的插件复制到 profile：改为备份并移除旧的 profile 副本，让 DSH 的安装锚点直接解析 `app.asar` 内的插件，避免搬出 asar 后缺失 `@deepseek-ai/*` 依赖；改写前逐一校验 bundled 依赖，失败立即还原 `package.json` 与旧副本，同一版本连续失败两次后停止尝试并降级启动。

## 0.0.8

- 云上实例已被删除时，本机残留的绑定按“过期”处理并清理，不再整体判定为授权失败：页面能正常显示“未开通”并给出开通引导，而不是只剩一条 401/403 错误。
- 个人助理创建改走产品化的部署动作（`CreateAgentProduct`），不再调用 Studio 通用 client 白名单之外的 `CreateAgent`；平台拒绝时透出真实原因（版本不支持、404 未注册、422 参数不符），不再统一提示“请稍后再试”。
- 内网账号 IAM 把 API 密钥报为 `Inactive`、且 `ListAllUserAccessKeys` 对子账号返回空列表时，通过有界 `ListUsers` 扫描定位密钥属主；属性缺失或存在多个候选时仍保持未验证，不猜测身份。
- 新建个人助理时默认运行时版本跟到 `0.1.41`（与平台 catalog 默认版本一致）：该版本修复云桌面浏览器窗口超出屏幕导致的标题栏/输入框被裁，并预置可在插件市场直接启用的 Studio 插件。

## 0.0.7

- 云端平台暂时无法返回个人助理实例详情时，设置页退回本机记录的配置清单并说明原因，不再把平台 5xx 当成用户操作失败。
- 创建个人助理时记录配置清单，使后续设置修改可以复用同一实例身份；旧实例可在本机补齐清单后继续编辑。

## 0.0.6

- 个人助理设置页支持在线配置：模型、系统提示词、运行时版本与环境变量注入；保存时提交一次平台更新，由云端滚动应用到实例，不需要用户手动重启，也不是每个字段都重启一次。
- 读取设置时敏感环境变量只回显“已配置”，值不出 Studio Host；旧实例缺少本机配置清单时明确提示无法在线修改，而不是用猜测的默认值覆盖云端实例。
- 云端平台暂不支持个人助理配置更新时，给出可读的原因与建议，不把原始 400 错误直接抛给用户。

## Desktop 0.2.0-rc.2.20261016.2 - 2026-10-16

- Integrate the expert catalog, resource templates, MCP transports and local teams on official DSH Agent Teams. Keep templates, resource bindings and ordinary Agent editing in the existing revision model.
- Add the cloud personal assistant conversation panel with durable acceptance, history recovery, reminders and explicit memory management.
- Show real Host device connection details, open native local sessions, move assistant configuration into native Settings, and render assistant Markdown with the official DSH renderer.
- Add confirmed assistant shutdown that erases dedicated runtime history and assistant memory before removing the owned cloud deployment. Shared resource collections remain available.
- Persist assistant and owner names in native Settings, display the assistant name in conversation and device details, and supply the identity through native system prompts after restarts.
- Preserve scheduler inputs and team reports in model transport while excluding unrelated internal context.
- Retain the scoped lifecycle, native unfiltered DSH sidebar, ES module frontend, split Host services and maintained compatibility source.
- Cancel template background work with its owning Host and retain cleanup during MCP connection and credential rotation.
- This Mac preview requires Apple Silicon. Windows and production cloud deployment are outside this release acceptance.

## 0.0.2

- Generate the browser bundle during development, checks and packaging instead of tracking `dist/`; verify macOS client bytes by rebuilding the exact signed source commit.
- Add an explicit first-use flow for a persistent cloud DSH personal assistant, with resumable provisioning, a durable welcome, conversation recovery, official scheduled reminders and editable long-term memory.
- Preserve Container storage through deployment admission and report interrupted creation without replaying a paid cloud request.
- Replace the credential guide with a native-themed welcome and interactive model setup preview; remove the independent DSH account welcome/recharge flow from Studio profiles.
- Configure models directly in fullscreen onboarding, allow skipping cloud credentials, and share API-key visibility controls and endpoint completion with Settings.
- Use the Nexus mark for the Windows system tray at all supported display scales.
- Keep one Skill resource tab with local/cloud source filtering before pagination.
- Use single-range Windows differential downloads on KS3 and require completed native byte counters for differential qualification.
- Give Windows Studio its own Electron identity, plugin profile and Host port so it can run beside official DSH Desktop.
- Replace Windows installer welcome and finish artwork with Nexus and AgentKit Studio branding.
- Publish signed Windows installers, blockmaps and channel metadata under the Studio KS3 directory; preserve a migration feed for already installed Windows builds.
- Add native Windows online update qualification covering download, installation, automatic restart and retained conversations.
- Align Studio settings, model credentials and Agent forms with native DSH typography, spacing and dark-mode colors.
- Keep optional overview configuration checks collapsed until opened; preserve the separate first-use credential guide.
- Add Windows NSIS packaging, certificate-store signing and installed App qualification.
- Clear stale macOS blockmap indexes after full releases before subsequent differential updates.
- Organize public usage, architecture and development guides; keep team plans and private evidence outside the source tree.

- Display the installed desktop build separately from the Studio plugin and pinned DSH versions.
- Pass the official DSH Session workspace to each Codex child and thread instead of writing in the system temporary directory.
- Preserve native DSH tool-mode and file-delivery guidance for Harness steps; expose the official present tool to Codex through scoped native/PTC dispatch.
- Bound model stream silence instead of terminating active local Harness/DSH replies after three minutes.
- Preserve the official macOS Code Mode host entitlements required for actual Codex tool execution.
- Preserve image-only and mixed image input for bound local Agents through DSH attachment storage, Harness model requests and native Codex image inputs.
- Preserve multimodal model capabilities advertised by nested `/v1/models` metadata.
- Keep long-running Codex turns alive while progress continues, with idle and explicit total budgets.
- Keep the in-app browser registration active and ship the independent Harness plugin verification path.

## 0.0.1

- Initial AgentKit Studio plugin package for the public DSH host.
- Agent authoring, resource binding, native conversations, deployment, automation, and channel surfaces.
- Codex and DSH plugin lifecycle integration.
- Curated official DSH plugin entries with post-install Host capability verification.
