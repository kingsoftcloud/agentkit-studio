# Changelog

## Unreleased

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
