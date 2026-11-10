# Changelog

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

## Unreleased

- 修复托管 DSH 实例“更新后会话消失”：每次被接受的 UpdateAgent 都会生成新的平台 VersionId，而 Host 曾把 `DSH_HOME` 放在 `versions/<sha256(VersionId)>/dsh`，新版本因此从空会话目录启动，旧日志仍留在旧版本目录。托管运行时的 `DSH_HOME` 改为每个 Agent 一份 `<state>/dsh`（DSH 原生会话、storages、凭证与 Settings 跨版本延续），Studio 的不可变 receipt 与模型配置仍按版本隔离；升级到该布局后的首次启动会用硬链接接管**最近写入**的一份旧版本目录（旧目录原样保留，供旧镜像回滚），记录 `.dsh-adopted.json`，并把旧 profile 的用户 Settings 种子到新 profile。范围仅限 DSH 原生会话历史；平台侧 managed session 注册表仍按版本隔离，跨版本复用需另行评审。
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
