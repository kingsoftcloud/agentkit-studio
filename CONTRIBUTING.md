# AgentKit Studio 协作开发

这份文档是仓库内可分发的开发约定。个人机器上的 `AGENTS.md` 只用于本地自动化，不作为
项目依赖，也不应在文档中写入个人绝对路径、密钥或本机 profile 内容。

## 环境

- Node.js `22.19.0`（版本写在 `.node-version`）
- pnpm `10.33.2`（版本写在 `package.json` 的 `packageManager`）
- 官方 DSH `0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`
- macOS DMG 还需要 DSH Desktop 的签名、公证和发布配置；普通 Web/Node 检查不需要云端密钥

Studio 基于公开 DSH 源码和扩展合同二次开发，但本仓库不复制 DSH 源码；运行和宿主验证需要
固定版本的官方 checkout。通过环境变量指定官方 checkout 和用户数据目录：

```sh
export DSH_ROOT=/path/to/deepseek-harness
export DSH_HOME=/path/to/dsh-home       # 可选；默认 ~/.dsh
export AGENTKIT_HOME=/path/to/agentkit  # 可选；默认 ~/.agentkit
```

如果本机还没有 DSH checkout，可以在 Studio 仓库目录执行 `make dsh-bootstrap`。该目标从
公开 DSH GitHub 仓库拉取固定 `dsh-v0.2.0-rc.2` tag，校验 commit 并在 checkout 内安装依赖；
源码仍位于 `DSH_ROOT`，不会进入 Studio Git 历史。

## 首次 checkout

```sh
pnpm install --frozen-lockfile
make check
make pack
make profile-install DSH_ROOT="$DSH_ROOT"
make profile-check
make web-dev DSH_ROOT="$DSH_ROOT"
```

`profile-install` 会在缺少 profile 时从官方 `web` 模板初始化一个独立 profile，再安装
Studio tarball，并自动校验 bundle 与安装文件。`profile-check` 是可单独运行的只读门禁，也可用
`PROFILE_DIR=/path/to/profile make profile-check` 检查解包后的发布 Profile。`web-dev` 启动后会打印带短期 token 的 URL，使用
该 URL 打开浏览器。

Profile 安装与 Web 启动通过官方 `apps/cli/src/bin.ts` 和 `tsx/esm` 运行，保留当前
pnpm 的 PATH。不要改回 `pnpm dsh`：它会把 DSH 工作区的 pnpm 注入子进程，旧 Profile
由不同 pnpm 主版本安装时会报 `ERR_PNPM_UNEXPECTED_STORE`。DSH 构建仍使用其自己的固定版本。
安装本地 tarball 时先复制到按 SHA256 区分的输入目录，再通过 `add --force` 安装。
仅重复使用同版本、同路径的 tarball 会命中 pnpm 旧内容；安装后逐文件对照当前包校验，
防止命令成功但仍运行旧代码。保留正在使用的 `.artifacts/profile-plugin-input/` 输入目录。

## DSH 补丁

宿主补丁按 `patches/dsh-v<version>/` 隔离。确认 checkout 是干净的固定 commit 后再执行：

```sh
make patch-check DSH_ROOT="$DSH_ROOT"
make patch-apply DSH_ROOT="$DSH_ROOT"
```

补丁不是 Studio runtime 的第二套实现；上游提供等价公开扩展点后，应删除对应版本目录中的
补丁并更新构建记录。

## Web、桌面和发布

```sh
make web-build DSH_ROOT="$DSH_ROOT"
make desktop-build DSH_ROOT="$DSH_ROOT"
make desktop-start DSH_ROOT="$DSH_ROOT"
```

这些目标构建或启动官方 DSH 宿主。`make desktop-package-mac-arm64[-dir]` 和 x64 对应目标
会先检查 `006-desktop-plugin-package-set.patch` 已应用，然后把 Studio tarball 纳入发布
Profile/package set；否则目标会主动失败。构建后的品牌和插件加载仍需发布流水线验证。

DMG 目标只能在 macOS 上运行，并且按官方 DSH 规则读取
`$DSH_ROOT/apps/desktop/.env.macos`。该文件应从 `.env.macos.example` 生成，不能提交到仓库。
没有签名、公证配置时，目标会主动失败；这表示环境未准备好，不代表 DMG 构建通过。

本机安装验收可显式使用未签名产物（需要 `009-local-macos-package.patch`）：

```sh
make desktop-package-mac-arm64-unsigned DSH_ROOT="$DSH_ROOT"
```

该目标复用官方 Node、Python、package-set 和原生依赖流水线，导出到
`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/`。
文件名包含 `unsigned`，不生成更新源或发布记录，也不会跳过正式目标的签名、公证检查。
验收时应把 DMG 只读挂载、复制 App 到源码目录之外，使用独立的 `DSH_HOME` 和
`AGENTKIT_HOME` 冷启动；移除 PATH 中的 Node/pnpm 后检查页面、模型设置、Agent 运行和
退出再打开。离线启动与联网模型、云端资源运行分别记录。旧全局配置迁移仍可能读取
`~/.agentengine/settings.json`，独立产品目录不等于干净系统账户。

## 提交前门禁

```sh
make check
make pack
git diff --check

# 只验证 Studio 包本身的完整发布门禁（不启动 DSH 宿主）
make patch-format-check
make release-check
```

涉及官方 DSH 或浏览器的改动还要记录 `make verify-dsh`、profile smoke 和对应的真实浏览器
证据。CI 会从公网固定 rc.2 tag 运行两个 node-store probe；fixture 测试只能证明合同投影，
不能替代模型、资源绑定、云端部署或签名 DMG 验收。

运行适配器还可以在真实 DSH 公开 LLM registry 中单独校验：

```sh
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-runtime-adapter.mjs
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-runtime-retry.mjs
# 已安装并配置 Codex 时读取真实 model/list；不启动推理回合
AGENTKIT_DSH_ROOT="$DSH_ROOT" node scripts/verify-dsh-runtime-adapter.mjs --codex
```

不带 `--codex` 的目录是合成合同数据；带该参数读取本机 Codex 的真实目录。
目录可见只证明合同可用，模型访问权限仍要由成功的实际会话验证。

`verify-dsh-runtime-retry.mjs` 使用合成网关，经过真实预设插件、DSH AgentLoop、
Session 和 llm-retry，校验临时故障恢复、认证/配额终止、退避取消、重试上限、
工具结果复用及失败输出隔离。它不代表真实云端服务发生过这些故障。
Studio 只返回公开的 `LlmFailure` 结束事件；重试策略、计时、取消和历史仍由 DSH 负责。
只有本地 Harness 的模型步骤进入该机制，独立本地整轮、云端 RunAgent 与 Codex
运行不会因此自动重放。

设置页的模型目录支持多个提供商和多个模型。请确认新增条目使用独立的
`credentialName`，且恰好一个条目标记为默认；Agent Revision 的多模型绑定应在创建页或
编辑页验证，不要把“默认模型”误当成“只能配置一个模型”。

macOS 构建默认使用 `assets/agentkit-studio-macos.png`，可通过 `DESKTOP_PRODUCT_ICON` 指定其他绝对路径。打包后的 Info.plist 与 icns 必须核对实际图标；更换源文件不代表已安装的旧 App 已更新。安装包同时包含固定版本的官方 Codex CLI，启动它使用包内 Node。首次 Codex 认证仍由 Codex 的账户/配置合同负责；`AGENTKIT_CODEX_BIN` 可覆盖入口。
