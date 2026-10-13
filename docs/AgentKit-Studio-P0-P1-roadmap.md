# AgentKit Studio 新版 P0/P1 路线图

这份路线图只针对新版 Studio。Studio 依赖 DSH 的插件机制；`@kingsoftcloud/agentkit-harness` 是独立 npm 包，但它本身仍是 DSH 插件。

## P0

| 项目 | 交付物 | 依赖 | 验收证据 | 停止条件 |
| --- | --- | --- | --- | --- |
| P0-0 Runtime 合同 | `src/runtime-contract.mjs`；固定 `dsh-native`、`harness`、`codex` 和 Build/Session/Run 身份 | 无 | `tests/runtime-contract.test.mjs` 3 项通过 | 运行不能绑定到冻结 Build/Session 时必须拒绝 |
| P0-1 Harness npm 核心 | `packages/agentkit-harness`；公开入口、类型、合同和 DSH 适配器 | DSH Agent/Session/LLM | `pnpm pack:harness`；独立包 type probe | 包不能导出第二套 Session、事件或持久化实现 |
| P0-2 真正 DSH 插件 | `agentkit-harness.plugin.json`；通过 `ctx.agents`、`ctx.sessions`、`ctx.llm` 工作 | P0-0、P0-1 | `pnpm verify-harness`：真实 DSH Agent/AssistantStream/Session JSONL/resume/cancel；卸载后 DSH 服务仍可用 | DSH context 不完整时 fail closed；不回退到 Studio 自建 runtime |
| P0-3 首次启动凭证引导 | 首次打开检查脱敏状态；官方 Settings、重试、稍后、跳过、重新打开；重连自动复查 | Host credential-status RPC、DSH Modal/Settings | 凭证状态自动化测试；签名安装版已验证重新打开、动画暂停/播放、跳转配置 | 只传状态，不把凭证写入浏览器存储；Host 失败不能误报“缺凭证” |
| P0-4 增量更新输入 | 官方 `electron-updater`；DMG/ZIP/ZIP.blockmap；显式 Studio origin、App ID、stable/preview channel；生产缺配置 fail closed | DSH 019 补丁、发布源配置 | `pnpm verify-desktop-update`；98 项 DSH 更新相关测试 | 未签名或无正式源时不得宣称可线上自动更新 |

## P1

| 项目 | 交付物 | 依赖 | 验收证据 | 停止条件 |
| --- | --- | --- | --- | --- |
| P1-1 发布流水线 | 签名、notarization、稳定/预览 feed、回滚记录 | P0-4；Apple 证书和 CDN | 正式签名 DMG、feed、安装后升级和回滚日志 | 任一身份、签名或 feed 校验失败就停止发布 |
| P1-2 独立 npm 发布 | 发布 `@kingsoftcloud/agentkit-harness`，保留 DSH peer 依赖 | P0-1/P0-2；registry 权限 | registry 安装、DSH 加载、卸载、类型检查 | 未获发布授权或公共包审计未过不得 publish |
| P1-3 版本与兼容矩阵 | Studio、Harness、DSH 版本矩阵和迁移说明 | P1-1/P1-2 | CI 对 pinned DSH 和下一兼容版本运行 | 不能证明兼容时保持版本锁定 |

## 当前状态

- P0-0、P0-1、P0-2、P0-3 已落地并有自动化证据。
- P0-4 已产出签名、公证的 arm64 DMG/ZIP/blockmap，并通过公网更新源和真实安装差分验证。最新安装版本为 `0.2.0-rc.2.20261013.10`，签名应用源码固定为 `bfd04a57f2f1896fec5669964dd52fad2e7d0528`。
- 2026-10-13 最终本地检查：616 passed、0 failed、0 skipped；完整 public-gate 通过，包内 318 个文件通过校验。此前 `pnpm verify-harness` 的真实 DSH 加载、执行、卸载、npm pack 和类型检查均通过。
- 差分验证使用官方 `GenericDifferentialDownloader` 和 blockmap v2：目标 2,097,272 bytes，实际下载 131,192 bytes，复用 1,966,080 bytes，损坏传输会拒绝。
- P1-1 Preview 发布与安装验收已完成。`release-desktop.yml` 使用 Studio 自己的 Apple/KS3 Environment，签名候选可复用发布；真实 KS3 三块上传、公网摘要、删除验证和隐藏证据归档均通过。[最终发布 CI](https://github.com/kingsoftcloud/agentkit-studio/actions/runs/38350039590) 成功，[Studio Release](https://github.com/kingsoftcloud/agentkit-studio/releases/tag/desktop-0.2.0-rc.2.20261013.10) 的 5 个附件摘要与签名候选全部一致。
- KS3 多段 Range 返回 416，`022-ks3-single-range-updates.patch` 改用官方单段 Range 差分。真实 `.5 → .6` 前向回滚和 `.6 → .10` 恢复最新版都通过：每次只下载完整 ZIP 的 13%，由更新程序自动重启，签名校验通过，原有配置、Agent revision、压缩会话文件字节均保留。
- 新图标已验证包含在签名 DMG 和安装后的原生“关于”窗口；旧 Deepseek 会话真实发送图片成功。模型设置自动读取网关能力，保存、重新读取、关闭后再打开都保留图片状态，浅色和深色主题已检查。凭证引导已在真实安装版打开并完成暂停/播放与配置跳转；本机已有凭证，“全新缺凭证”场景目前以自动化测试为证据。
- P1-2 的 npm registry 发布、P1-3 的下一 DSH 版本兼容矩阵仍未完成。P1-3 还需统一旧插件版本展示与包版本；实际桌面安装版本以原生“关于”窗口为准。当前线上验收使用 Preview 通道，尚未发布 Stable 版本。
