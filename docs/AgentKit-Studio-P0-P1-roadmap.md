# AgentKit Studio 新版 P0/P1 路线图

这份路线图只针对新版 Studio。Studio 依赖 DSH 的插件机制；`@kingsoftcloud/agentkit-harness` 是独立 npm 包，但它本身仍是 DSH 插件。

## P0

| 项目 | 交付物 | 依赖 | 验收证据 | 停止条件 |
| --- | --- | --- | --- | --- |
| P0-0 Runtime 合同 | `src/runtime-contract.mjs`；固定 `dsh-native`、`harness`、`codex` 和 Build/Session/Run 身份 | 无 | `tests/runtime-contract.test.mjs` 3 项通过 | 运行不能绑定到冻结 Build/Session 时必须拒绝 |
| P0-1 Harness npm 核心 | `packages/agentkit-harness`；公开入口、类型、合同和 DSH 适配器 | DSH Agent/Session/LLM | `pnpm pack:harness`；独立包 type probe | 包不能导出第二套 Session、事件或持久化实现 |
| P0-2 真正 DSH 插件 | `agentkit-harness.plugin.json`；通过 `ctx.agents`、`ctx.sessions`、`ctx.llm` 工作 | P0-0、P0-1 | `pnpm verify-harness`：真实 DSH Agent/AssistantStream/Session JSONL/resume/cancel；卸载后 DSH 服务仍可用 | DSH context 不完整时 fail closed；不回退到 Studio 自建 runtime |
| P0-3 首次启动凭证引导 | 首次打开检查脱敏状态；官方 Settings、重试、稍后、跳过、重新打开；重连自动复查 | Host credential-status RPC、DSH Modal/Settings | `tests/credential-onboarding.test.mjs`；DMG app.asar 含引导代码 | 只传状态，不把凭证写入浏览器存储；Host 失败不能误报“缺凭证” |
| P0-4 增量更新输入 | 官方 `electron-updater`；DMG/ZIP/ZIP.blockmap；显式 Studio origin、App ID、stable/preview channel；生产缺配置 fail closed | DSH 019 补丁、发布源配置 | `pnpm verify-desktop-update`；98 项 DSH 更新相关测试 | 未签名或无正式源时不得宣称可线上自动更新 |

## P1

| 项目 | 交付物 | 依赖 | 验收证据 | 停止条件 |
| --- | --- | --- | --- | --- |
| P1-1 发布流水线 | 签名、notarization、稳定/预览 feed、回滚记录 | P0-4；Apple 证书和 CDN | 正式签名 DMG、feed、安装后升级和回滚日志 | 任一身份、签名或 feed 校验失败就停止发布 |
| P1-2 独立 npm 发布 | 发布 `@kingsoftcloud/agentkit-harness`，保留 DSH peer 依赖 | P0-1/P0-2；registry 权限 | registry 安装、DSH 加载、卸载、类型检查 | 未获发布授权或公共包审计未过不得 publish |
| P1-3 版本与兼容矩阵 | Studio、Harness、DSH 版本矩阵和迁移说明 | P1-1/P1-2 | CI 对 pinned DSH 和下一兼容版本运行 | 不能证明兼容时保持版本锁定 |

## 当前状态

- P0-0、P0-1、P0-2、P0-3 已落地并有自动化证据。
- P0-4 的源码、DMG/ZIP/blockmap 打包和本地差分下载验证已通过；最新 unsigned arm64 DMG 为 `501917141` bytes，SHA256 为 `5912db44110426460ec853f1f3fa0de8cc8ffdc8337a3d61882bc0d31c8d6d74`。
- `pnpm test`：584 passed、0 failed、1 skipped；`pnpm verify-harness`：真实 DSH probe、卸载、npm pack、type probe 均通过。
- 差分验证使用官方 `GenericDifferentialDownloader` 和 blockmap v2：目标 2,097,272 bytes，实际下载 131,192 bytes，复用 1,966,080 bytes，损坏传输会拒绝。
- P1-1 的发布与验收入口已落地：`scripts/desktop-release.mjs` 复用官方 DSH upload plan/run，按 binary-first、metadata-last 发布并验证公开 feed 的完整字节和 HTTP Range；`scripts/verify-desktop-installed-update.mjs` 会挂载签名 DMG、启动真实 Electron、执行更新菜单、等待替换重启并检查数据保留。
- 当前仍未宣称 P1-1 完成：线上 origin、COS bucket/凭证和一组“旧版本 → 新版本 → 前向回滚版本”的签名产物尚未在本机具备，因此还没有真实 feed、安装后升级或回滚 JSON 证据。工作流会在这些输入缺失时停止，不把本地 loopback 或 unsigned 结果当作通过。
