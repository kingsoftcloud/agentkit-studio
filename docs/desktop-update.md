# AgentKit Studio Desktop 更新

新的下载目录为 `https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/<版本号>/`，其中 DMG、ZIP 和 blockmap 使用固定的 `AgentKit-Studio-mac-arm64` 文件名。更新索引放在 `studio/feeds/mac-arm64/`；同时保留同一 Bucket 下 DSH 原生 `dsh-desk/feeds/mac-arm64/` 索引入口。不再发布旧 `ksadk` Bucket 的过渡索引。内置旧源的安装版需要手动安装一次新版 DMG。

发布默认选择 `release_layout=studio`、`storage_origin=https://agentkit.ks3-cn-beijing.ksyuncs.com`、`update_mode=incremental`。需要推送全量更新时，使用递增的新版本号并设置 `update_mode=full`：签名 ZIP 发布在该版本的 `full/` 子目录，该路径不发布 blockmap，官方 updater 会回退到完整 ZIP 下载，仍核对签名和 SHA-512。普通目录中保留该版本的 blockmap，使下次增量发布可以复用这次完整下载的 ZIP 缓存。无需清理用户会话、配置或重装。

无需整体公开 Bucket，发布程序只给具体版本对象设置 `public-read`。匿名访问未创建的对象可能返回 403，发布器先用签名 HEAD 确认 404 才创建；已存在且不可公开读取的对象或内容不同的不可变文件会停止发布。

绑定本地 Agent 的图片输入修复：入口允许纯图片，模型传输通过 DSH `attachments.readImageRequest` 读取已入库的附件，保留混合内容及工具续跑历史。Codex 使用原生 `turn/start` 图片项。未构建的本地 Agent 可在其已绑定网关目录中通过原生模型选择器切换模型；切换其他网关或目录之外的模型仍会拒绝，冻结 Build 继续限定已绑定模型。`node --test tests/dsh-runtime-images.test.mjs tests/local-runtime.test.mjs tests/codex-runtime.test.mjs` 覆盖这些路径；签名安装版还需分别验证绑定“财务分析师”的纯图片、文字加图片和重启后继续对话。此前 `.20261013.10` 的 UI 验收只执行了未绑定普通会话的文字加图片、以及绑定 Agent 的创建操作，没有覆盖这个错误路径。新版安装源码摘要同时覆盖独立 Harness 包的 `src`，避免只核对 Studio 外层文件。

Desktop 沿用 DSH 官方 Electron updater 的检查、下载、校验和重启流程。Studio 只提供自己的产品输入，不能使用 DSH 默认产品源：

```dotenv
DSH_DESKTOP_APP_ID=com.kingsoftcloud.agentkit-studio
DSH_DESKTOP_UPDATE_ORIGIN=https://agentkit.ks3-cn-beijing.ksyuncs.com
DSH_DESKTOP_UPDATE_CHANNEL=preview
```

`DSH_DESKTOP_UPDATE_CHANNEL` 只用于产品发布的 `stable` 或 `preview` lane。未指定时，DSH 旧测试夹具仍使用 `nightly`，生产配置必须显式填写 Stable 或 Preview。更新源必须是 HTTPS origin；更新凭据和 KS3 配置不进入仓库。

macOS 包含 DMG、ZIP 和 ZIP blockmap。DMG 用于安装，Electron updater 通过 ZIP 及 blockmap 做增量下载；下载完成后仍由用户确认重启安装。首次检查、定时检查、下载进度、签名校验和 `quitAndInstall` 都由官方 updater coordinator 完成。

真实 macOS 重启验收使用 `verify-desktop-installed-update.mjs --native-profile`，沿用正常安装的 Electron 和 DSH 数据目录。Squirrel/LaunchServices 不继承临时的 `DSH_HOME` 和 `--user-data-dir`；自定义隔离目录只能用于启动、工具和界面验证，不能凭原文件仍在就认定重启保留通过。通过 `--retain-session-title` 指定专用验收会话，必须在实际自动重启后的会话栏看到它，同时核对会话文件、应用签名和完整 Studio 包摘要。Host 状态页和会话页分别保存真实 AX 与截图，不重新手动启动后继进程。

2026-10-13 Mac `.23`（源码 `b8ee6be7910d0a9f6fc48bb963d41e4430d5c5f4`）已通过签名、公证、本地 Gatekeeper 和真实 Codex 文件交付验收：SVG/PNG 落盘、会话交付卡片、内嵌 PNG 和右侧预览均已确认。该版已发布到新 Bucket，当前 feed 使用 `full` 模式；[下载签名 DMG](https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/0.2.0-rc.2.20261013.23/AgentKit-Studio-mac-arm64.dmg)。`.22` 的真实更新提示及全量下载已确认；增量下载、正常目录的数据保留及前向回滚仍需独立的安装验收结果。

KS3 的多段 Range 会返回 416。`022-ks3-single-range-updates.patch` 在签名前把官方 Generic Provider 的 `useMultipleRangeRequest: false` 写入 `app-update.yml`，改用官方单段 Range 差分下载。首次通过 DMG 安装且没有旧 ZIP 缓存时，官方 updater 可能先下载整包；完成一次更新后会保留 ZIP，供后续差分使用。

在「设置 → AgentKit Studio → 桌面更新」点击「检查更新」可手动刷新更新源；发现更新后，下载和重启仍需在官方更新窗口确认。凭证引导中的三步配置演示可暂停或播放，并遵守系统的减少动态效果设置。

提交前检查源码合同：

```sh
AGENTKIT_DSH_ROOT=/path/to/deepseek-harness pnpm verify-desktop-update
node --test tests/desktop-update-contract.test.mjs
node scripts/check-dsh-patches.mjs /path/to/deepseek-harness patches/dsh-v0.2.0-rc.2
AGENTKIT_DSH_ROOT=/path/to/deepseek-harness node scripts/verify-desktop-differential.mjs
```

本地 unsigned 产物如果 DMG 和 ZIP/blockmap 在不同目录，额外传入 DMG 路径：

```sh
AGENTKIT_DESKTOP_DMG=/path/to/AgentKit-Studio.dmg \\
  node scripts/verify-desktop-artifact.mjs /path/to/unsigned-artifacts
```

证据边界要分开记录：`verify-desktop-update` 和补丁检查只证明源码输入及补丁可应用；本地 unsigned DMG 只证明可启动的产品包和内置插件，不证明签名、公证、线上 feed 或真实增量下载。正式发布还必须保存已签名 DMG/ZIP、对应 blockmap、Stable/Preview metadata、App ID、更新源和签名/公证结果。

`verify-desktop-differential` 使用 pinned `electron-updater` 的官方 `GenericDifferentialDownloader` 和 `buildBlockMap`，在临时 loopback HTTP Range 服务上重建 ZIP，并验证 SHA-512、ZIP 完整性、差分字节小于完整包，以及损坏传输被拒绝。它不安装应用、不签名、不访问线上 CDN；系统禁止回环监听时应记录为环境阻断，不能改写成通过。

## 正式签名入口

正式入口是 `kingsoftcloud/agentkit-studio` 的 `.github/workflows/release-desktop.yml`，Environment 为这个仓库自己的 `studio-signing`。以下配置已通过目标 Environment 公钥加密迁移；明文没有写入仓库或下载产物：

- `STUDIO_APPLE_P12_BASE64`
- `STUDIO_APPLE_P12_PASSWORD`
- `STUDIO_APPLE_ID`
- `STUDIO_APPLE_APP_PASSWORD`
- `STUDIO_APPLE_TEAM_ID`

工作流只允许 `workflow_dispatch`，要求 Studio 固定 commit、DSH 固定 commit、`stable/preview` channel 和 HTTPS origin。它临时创建 keychain，生成 DSH `.env.macos`，调用本仓库的 `make desktop-package-mac-arm64`，验证签名、公证和产物。默认暂存 Actions artifact；显式开启 `publish_feed` 后发布 KS3 feed，并把同一份签名文件放入 Studio GitHub Release。最后清理证书、keychain 和配置。

同仓库 checkout 使用自己的 `GITHUB_TOKEN`，无需跨仓库 `AGENTKIT_STUDIO_SOURCE_TOKEN`。每个阶段先取包含目标 commit 的分支，验证 ancestry 后 detach 到同一个 SHA；后续分支继续提交不会改变已派发的构建。旧 ksadk-python 工作流保留兼容入口，日常发布无需再切换仓库。

从 Studio 仓库运行签名构建：`STUDIO_UPDATE_ORIGIN` 设为实际 HTTPS 更新源，`STUDIO_BUILD_VERSION` 设为尚未发布且递增的 semver 版本。先从已审核源码创建不可变 tag，再派发工作流：

```sh
studio_commit=$(git rev-parse HEAD)
git push upstream HEAD:refs/heads/codex/agentkit-studio-p1-1
studio_tag="desktop-$STUDIO_BUILD_VERSION"
if ! git show-ref --verify --quiet "refs/tags/$studio_tag"; then
  git tag "$studio_tag" "$studio_commit"
fi
test "$(git rev-parse "$studio_tag^{commit}")" = "$studio_commit"
git push upstream "refs/tags/$studio_tag"
gh workflow run release-desktop.yml --repo kingsoftcloud/agentkit-studio --ref main \
  -f studio_ref="$studio_commit" -f studio_checkout_ref=codex/agentkit-studio-p1-1 \
  -f dsh_ref=dsh-v0.2.0-rc.2 -f dsh_commit=639ed015397290b3745d163aafe02ffee4aa3f84 \
  -f channel=preview -f update_origin="$STUDIO_UPDATE_ORIGIN" \
  -f build_version="$STUDIO_BUILD_VERSION" \
  -f publish_feed=false -f qualify_installed_update=false
```

这条命令生成签名、公证候选；构建成功后用 `gh run download <run-id> --repo kingsoftcloud/agentkit-studio --dir .artifacts/signed-desktop` 下载到本地。已暂存的候选可再次派发同一工作流，设置 `candidate_run_id=<签名 job 成功的 run-id>` 和 `publish_feed=true`，并填写完全匹配的 source SHA、版本和 channel。即使原始 run 的发布失败，只要签名 job 成功、run 已结束，就可以复用。工作流核对签名 job、候选身份和 `SHA256SUMS` 后发布，不重复签名，也不改变签名文件字节。

修复发布工具后，可指定 `release_tools_ref=<新的工具 commit SHA>`，但 `studio_ref` 仍填原来签名的源码 SHA；`studio_checkout_ref` 必须包含这两个 commit。未填写时，工具沿用 `studio_ref`。这只更新上传和验证工具，不能把未签名的新应用代码混入既有候选。

GitHub Release 会先校验 tag 指向签名源码，再用 `--verify-tag` 创建草稿，逐个核对附件摘要，最后公开。已存在的 tag 不再重复传 off-main `target_commitish`，避免对普通 job token 引入额外的 Workflows 写权限要求。该权限规则见 [GitHub Release API 文档](https://docs.github.com/en/rest/releases/releases#create-a-release)。

已在本机配置 DSH `.env.macos` 与 Apple 签名凭证时，可直接运行：

```sh
DSH_DESKTOP_BUILD_VERSION=0.2.0-rc.2.20261012.3 \
  make desktop-package-mac-arm64 DSH_ROOT=/path/to/deepseek-harness PACK_DIR=.artifacts/signed-desktop
```

正式发布还需要下方 KS3 配置，并按“DMG/ZIP/blockmap 先上传、channel metadata 后发布”的顺序完成。旧 Studio 的 App ID 是 `com.kingsoftcloud.agentkit.studio`，新版是 `com.kingsoftcloud.agentkit-studio`，两者不能直接当作同一安装实例做差分升级。

## P1-1 真实发布与安装验收

签名工作流通过 `publish_feed=true` 才会写线上 KS3。Studio 发布器使用 KS3 KSS 签名和 AK/SK：大于等于 32 MiB 的文件按 5 MiB 分块、最多四块并行上传，单块超时 300 秒、最多尝试三次，失败后等待在途请求结束再取消分块任务；小文件及 feed 使用单次 PUT。分块完成不会修改签名文件内容，接口依据 [KS3 分块上传协议](https://docs.ksyun.com/documents/42468)。

发布前，Ubuntu job 用同一配置上传一个 11 MiB 临时对象，核对三块上传、公网完整字节及 SHA-256，并删除临时对象。验证失败不推进 feed。不可变安装包若已存在，只在完整公网摘要和大小一致时复用；同名不同内容必须拒绝。

发布顺序是 DMG、ZIP、ZIP blockmap，然后是 `mac-arm64-release.json` 和 `stable-mac.yml` 或 `preview-mac.yml`。Ubuntu 发布 job 完成后立即用公开 HTTPS origin 做 HEAD、全量 SHA-512 和 `Range: bytes=0-0` 检查，并把 JSON 证据作为 Actions artifact 保存。证据目录 `.desktop-release` 使用 `include-hidden-files: true`，缺失时 job 报错。工作流使用以下 Environment Secret 名称，值不进入仓库：

- `STUDIO_DOWNLOAD_PROD_KS3_BUCKET`（如果 origin 使用 `<bucket>.ks3-*.ksyuncs.com`，可省略）
- `STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY`
- `STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY`

兼容读取 `KS3_BUCKET`、`KS3_ACCESS_KEY`、`KS3_SECRET_KEY` 和 `KSYUN_ACCESS_KEY`、`KSYUN_SECRET_KEY`。这些值是金山云 KS3 凭证，不是腾讯云 COS 凭证。

候选 artifact 必须同时包含 `mac-arm64-release.json`；这个记录把 feed 版本、目标、origin 和 DSH commit 绑定起来，缺失时发布会停止。发布前可填写 `expected_previous_version`，脚本会先读取当前 feed，版本不匹配就不写远端对象。

本地或 CI 的公开 feed 检查：

```sh
node scripts/desktop-release.mjs verify-feed \
  --origin https://<studio-update-origin> --channel preview \
  --version 0.2.0-rc.2.20261012.1 --output .artifacts/desktop-release
```

真正的 macOS 验收会挂载签名 DMG，或用 `--app` 指定已有安装，执行 `codesign` 和 `spctl` 并启动真实 Electron。操作者通过可见的官方更新界面检查、下载和重启；脚本本身不会模拟 UI 点击。它等待安装版本替换及新进程 `workspace-ready`。macOS LaunchServices 重启不继承环境变量时，使用 CUA 保存实际工作区的 AX 状态和截图到验收目录的 `successor-ui.json`；脚本独立检查原进程退出、新安装进程启动、截图时间和 Host 已连接状态，不自行启动新进程。随后检查 `DSH_HOME` marker 和 `--retain-file` 指定的真实会话、配置文件原始字节，保存 journal 和实际差分下载日志。`--require-differential` 会拒绝整包回退。

验收默认使用隔离的 Electron 数据目录。连续升级、回滚时，显式传入同一组 `--app`、`--data-home` 和 `--user-data-dir`，并通过 `--retain-file` 指定真实持久化文件；脚本以单个 `--user-data-dir=<path>` 参数启动，避免误连已运行的个人 App。

报告分别记录 Runtime 源码摘要 `studioSourceSha256` 和完整 Studio npm 包摘要 `studioPackageSha256`。只改变发布脚本或文档时，Runtime 摘要可以相同；回滚仍须用 `--expected-studio-package-sha256` 核对实际安装的完整包恢复为指定验收版本，不能仅凭版本号判定。

```sh
node scripts/verify-desktop-installed-update.mjs \
  --dmg /path/to/baseline.dmg --origin https://<studio-update-origin> \
  --channel preview --version 0.2.0-rc.2.20261012.1
```

回滚使用前向版本：把回滚代码重新打成更高的 `DSH_DESKTOP_BUILD_VERSION`，指向同一 App ID 和 feed，然后重复发布和安装验收。这样遵守官方 updater 的 `allowDowngrade=false` 和 `semver.gt` 安全约束，同时真实覆盖“新版本 → 回滚代码版本”的安装、重启和数据保留。任何 origin、feed metadata、ZIP range、签名、公证、版本替换或 marker 检查失败，都不能生成验收通过证据。

## 新 Bucket 发布与迁移

后续仅向 `https://agentkit.ks3-cn-beijing.ksyuncs.com` 发布。DMG、ZIP 和 blockmap 位于 `studio/<version>/`，正式 feed 位于 `studio/feeds/mac-arm64/`；同一 Bucket 内保留原生 updater 使用的 `dsh-desk/feeds/mac-arm64/` 路径。发布 workflow 的 `compatibility_origin` 默认留空，不再向旧 Bucket 写兼容 feed。

仍内置旧 Bucket 的安装需要手动安装一次新签名 DMG。新安装随后通过 AgentKit Bucket 检查和下载更新；不会靠改写旧 App 的签名资源切换来源。全量更新采用 `--update-mode full`，普通发布采用 `--update-mode incremental`。

## 2026-10-13 历史验收记录（旧 Bucket 已停止更新）

本次使用 Preview 通道、Apple Silicon 安装包，以及 `https://ksadk.ks3-cn-beijing.ksyuncs.com` 公网源。签名候选在 [Studio Actions 38345364168](https://github.com/kingsoftcloud/agentkit-studio/actions/runs/38345364168) 生成；应用源码为 `bfd04a57f2f1896fec5669964dd52fad2e7d0528`，后续发布工具和文档提交没有改变这份签名文件。

| 实际操作 | 结果 | 本地证据 |
| --- | --- | --- |
| `.20261013.5 → .20261013.6` 前向回滚到较早应用源码 | 差分下载 67,138.54 KiB / 完整 497,432.85 KiB，约 13%；自动重启、签名、原有数据保留通过 | `.artifacts/p1-1-ks3/real-rollback6/installed-update.json` |
| `.20261013.6 → .20261013.10` 恢复最新版 | 差分下载 66,996.62 KiB / 完整 497,323.45 KiB，约 13%；自动重启、签名、原有数据保留通过 | `.artifacts/p1-1-ks3/real-final10/installed-update.json` |
| 公网 DMG/ZIP/blockmap 和 feed | 完整摘要与签名候选一致；ZIP 单段 Range 返回 206 | `.artifacts/p1-1-ks3/local-publication10.json` |
| 实际安装后的图标和界面 | Nexus 图标出现在原生“关于”、侧边栏、会话首页及引导；产品名保留 AgentKit Studio | `.artifacts/p1-1-ks3/candidate10-local.json`、`ui-final10/app-about.jpg` |
| 旧会话图片输入和模型设置 | 原有 Deepseek 会话成功识图；自动发现图片能力，保存/重读/重新打开保留状态；浅色、深色视觉已检查 | `.artifacts/p1-1-ks3/ui-final10/acceptance.json` |
| 凭证引导 | 设置入口可打开、暂停/播放、跳转模型配置；已有凭证不会自动打断启动 | 同上；缺凭证首启场景另有自动化测试 |

真实数据保留覆盖已存在的全局配置、Agent revision 和压缩会话文件；报告记录原始字节摘要。截图与完整日志仅本地保存，未发布用户会话内容。旧安装缺少 blockmap 的暖机整包下载、此前失败和取消的 CI 都保留记录，没有算作差分验收通过。

最终 [CI 38350039590](https://github.com/kingsoftcloud/agentkit-studio/actions/runs/38350039590) 通过 KS3 发布及 GitHub Release 创建、附件上传；签名 job 复用前述已通过的候选，真实安装验收使用上表本机证据。不存在把跳过的安装 job 当作已通过的情况。

历史 `.10` DMG：[原验收下载](https://ksadk.ks3-cn-beijing.ksyuncs.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.0-rc.2.20261013.10-mac-arm64.dmg)，[对应 Studio Release](https://github.com/kingsoftcloud/agentkit-studio/releases/tag/desktop-0.2.0-rc.2.20261013.10) 的 5 个附件摘要与签名候选一致。DMG SHA-256 为 `b279b2460b048cd92be04b8ee6177e29df71a938e28c805091c31243e1e7a1a8`。本地保留摘要、截图和验收日志，旧二进制已按要求清理，需要时可从 Release 重新下载。新候选仍须通过真实 App 验收后才能更新最新下载记录。
