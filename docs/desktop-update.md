# AgentKit Studio Desktop 更新

Desktop 沿用 DSH 官方 Electron updater 的检查、下载、校验和重启流程。Studio 只提供自己的产品输入，不能使用 DSH 默认产品源：

```dotenv
DSH_DESKTOP_APP_ID=com.kingsoftcloud.agentkit-studio
DSH_DESKTOP_UPDATE_ORIGIN=https://updates.example.com
DSH_DESKTOP_UPDATE_CHANNEL=preview
```

`DSH_DESKTOP_UPDATE_CHANNEL` 只用于产品发布的 `stable` 或 `preview` lane。未指定时，DSH 旧测试夹具仍使用 `nightly`，生产配置必须显式填写 Stable 或 Preview。更新源必须是 HTTPS origin；更新凭据和 COS 配置不进入仓库。

macOS 包含 DMG、ZIP 和 ZIP blockmap。DMG 用于安装，Electron updater 通过 ZIP 及 blockmap 做增量下载；下载完成后仍由用户确认重启安装。首次检查、定时检查、下载进度、签名校验和 `quitAndInstall` 都由官方 updater coordinator 完成。

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

当前 Apple 凭证仍保存在旧 `kingsoftcloud/ksadk-python` GitHub Environment：`studio-signing`。只复用以下 Secret 名称，不读取或复制 Secret 值：

- `STUDIO_APPLE_P12_BASE64`
- `STUDIO_APPLE_P12_PASSWORD`
- `STUDIO_APPLE_ID`
- `STUDIO_APPLE_APP_PASSWORD`
- `STUDIO_APPLE_TEAM_ID`

签名任务模板位于旧仓库的 `.github/workflows/release-agentkit-studio.yml`，只允许 `workflow_dispatch`，要求输入新版 Studio 固定 commit、DSH 固定 commit、`stable/preview` channel 和 HTTPS update origin。它会临时创建 keychain，生成 DSH `.env.macos`，调用本仓库的 `make desktop-package-mac-arm64`，验证签名/公证后的 DMG、ZIP、ZIP blockmap 和 channel metadata，最后只上传 Actions artifact 并清理证书、keychain 和配置。

因为新版 Studio 仓库是私有仓库，旧仓库的 `GITHUB_TOKEN` 不能默认跨仓库读取它。工作流还需要在 `studio-signing` Environment 增加一个只读 `AGENTKIT_STUDIO_SOURCE_TOKEN`；这个 Token 只用于 checkout 指定 commit，不参与签名或发布。

旧仓库的 workflow 不自动发布更新源。正式发布还需要单独配置 Studio 更新源的上传凭证，并按“不可变 DMG/ZIP/blockmap 先上传、channel metadata 后发布”的顺序完成。旧 Studio 的 App ID 是 `com.kingsoftcloud.agentkit.studio`，新版是 `com.kingsoftcloud.agentkit-studio`，两者不能直接当作同一安装实例做差分升级。
