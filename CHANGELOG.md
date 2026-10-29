# Changelog

## 0.0.8

- 云上实例已被删除时，本机残留的绑定按“过期”处理并清理，不再整体判定为授权失败：页面能正常显示“未开通”并给出开通引导，而不是只剩一条 401/403 错误。
- 个人助理创建改走产品化的部署动作（`CreateAgentProduct`），不再调用 Studio 通用 client 白名单之外的 `CreateAgent`；平台拒绝时透出真实原因（版本不支持、404 未注册、422 参数不符），不再统一提示“请稍后再试”。
- 内网账号 IAM 把 API 密钥报为 `Inactive`、且 `ListAllUserAccessKeys` 对子账号返回空列表时，通过有界 `ListUsers` 扫描定位密钥属主；属性缺失或存在多个候选时仍保持未验证，不猜测身份。

## 0.0.7

- 云端平台暂时无法返回个人助理实例详情时，设置页退回本机记录的配置清单并说明原因，不再把平台 5xx 当成用户操作失败。
- 创建个人助理时记录配置清单，使后续设置修改可以复用同一实例身份；旧实例可在本机补齐清单后继续编辑。

## 0.0.6

- 个人助理设置页支持在线配置：模型、系统提示词、运行时版本与环境变量注入；保存时提交一次平台更新，由云端滚动应用到实例，不需要用户手动重启，也不是每个字段都重启一次。
- 读取设置时敏感环境变量只回显“已配置”，值不出 Studio Host；旧实例缺少本机配置清单时明确提示无法在线修改，而不是用猜测的默认值覆盖云端实例。
- 云端平台暂不支持个人助理配置更新时，给出可读的原因与建议，不把原始 400 错误直接抛给用户。

## Unreleased

- Register the plugin market's `plugins/dsh-discover` bridge endpoint (and the previously missing `plugins/dsh-index-refresh`) in the Studio operation allowlist so the Host accepts them instead of rejecting them as unknown control endpoints.
- Turn the DSH plugin market into a discovery surface instead of a mirror of the official installed list: aggregate npm (`keywords:dsh-plugin`) and GitHub (`topic:dsh-plugin`) metadata over a curated offline shelf, with category filters, download/star/update sorting, detail cards and one-click install, while installed lifecycle management stays as a second tab. Discovery uses a 10-minute memory+disk cache and keeps serving the last good catalog when the network fails.
- Add a DSH plugin market as a row inside the official 插件 page (public `plugins.item` slot, no sidebar entry or second plugin center): curated offline catalog, optional HTTPS remote index refreshed without a release, search/category filters, manual spec install, and install/enable/disable/update/uninstall through the official plugin manager with row/service readiness probes and honest failure reporting.
- Fix the market lifecycle on the real Host: the DSH plugin surface mounts the plain product client, so the install/enable/disable/update/uninstall methods now live on that client instead of only the compatibility extension. Install, enable and disable were verified end-to-end against the packaged DSH 0.2.1-rc.2 Host.
- Generate the installed `dsh` terminal launcher from the packaged product name instead of a hardcoded `DeepSeek Harness`, restoring the CLI for product builds while official builds keep the upstream default (DSH patch 051).
- 云端镜像目录出现当前 Studio 尚未实现的能力声明时，只停用该镜像版本并回退到最新的兼容镜像，同时给出升级提示；不再因一次新镜像发布拒绝整个目录，导致旧客户端无法部署任何 Agent。
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
