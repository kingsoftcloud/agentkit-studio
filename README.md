# AgentKit Studio

跨 Host 运行 Agent 可使用[可迁移运行包](docs/contracts/portable-agent-bundle.md)：在构建页导出
模型/MCP 配置和 Skill 文件，在新的数据目录导入并注入目标凭证。预发运行时发布仍需后续联调。

AgentKit Studio 是 AgentKit 的产品界面、控制面客户端和 TypeScript 运行时提供方。它提供
Agent 创建与编辑、资源目录、构建部署、评测观测、Channel 和自动化等产品页面；本地运行时
支持 DSH Native、Codex 和 Studio 内置的 AgentKit Harness。新版只面向本地创建的 Agent 及其云端部署，不兼容历史 ADK / LangChain / LangGraph / OpenClaw / Hermes，
后续资源绑定、会话交互和部署验收均聚焦这三种运行时。

当前首个公开可复现版本为 **0.0.1**，固定验证基线为 **DSH v0.2.0-rc.2**（commit
`639ed015397290b3745d163aafe02ffee4aa3f84`）。Studio 基于 DSH 的公开宿主和扩展合同二次开发；
仓库不复制 DSH 源码，也不包含 Python 运行时。

## 是否必须安装 DSH 桌面端

不必须。桌面端是可选的宿主形态：

- **浏览器形态**：浏览器访问 Studio Web Host 或 AgentEngine Server 即可。用户不安装 Electron
  桌面端也能使用；本地 DSH 对话调试才需要 Node.js 和官方 DSH checkout。
- **桌面形态**：官方 DSH Electron 壳负责窗口、更新、托盘和本地 Host。AgentKit Studio
  插件本身不打包 Electron，也不把 Python/KsADK 塞进桌面应用。桌面端只是一种可选的本地
  Host 形态，发布 profile 载入插件后显示 AgentKit Studio 品牌。

因此桌面端不是产品 API 依赖。若用户没有本地 Host，可以直接连接 AgentEngine Server；无
Agent 的普通对话由所连接的运行时执行。

## 主要产品边界

- **Agent**：快速创建、一键创建、对话创建和编辑。模型、Tool、MCP、Skill 可以多选；知识库、
  记忆库、Skill Center 每类默认一个。运行目标属于 Agent Revision，可选择 `dsh-native`、
  `harness` 或 `codex`。本地列表支持搜索、分页，最新创建的在前；会话中使用原生搜索菜单选择 Agent。云端标签只接纳 Studio 部署记录，当前本地 Build 尚未接通云端发布，因此显示明确空状态。OpenClaw 使用原生 Dashboard。
- **资源库**：只做资源生命周期管理，包括发现、导入、探测、查看、刷新、删除和分页列表。
  资源库不选择 Agent，也不写 Agent Revision；绑定关系只在创建页或编辑页提交，和 Revision
  一起保存、审计和回滚。
- **对话**：不选择 Agent 也能走 DSH 原生循环；选择已创建 Agent 后打开绑定对话，绑定
  在创建会话时完成。三种运行时共用 DSH 原生会话页、事件与持久化历史；Agent Revision
  固定系统 Prompt、模型与资源绑定。资源在 Host 准入时实际解析和探测，无法加载时明确报错；
  目录可见不等于资源已执行，跨 Host 的凭证和资源可达性需要独立验收。
  “未分组”加号可直接新建无工作区会话；空白会话中点击工作区名称旁的叉号可取消目录，
  Agent、模型、命名访问模式及输入草稿一起保留。绑定前先探测资源，准入失败不再生成空白会话。
- **本地调试与发布**：已保存 Agent Revision 可以直接本地对话，无须先构建；构建用于冻结
  版本并导出运行包。目前对话创建工具尚不提供构建操作，预发产物上传和部署联调尚未完成。
- **设置**：左下角齿轮直接打开 DSH 原生设置弹窗，模型、凭证和 Studio 配置仍在同一处管理。
- **运行中心**：构建、部署、评测、观测、Channel 和自动化都通过 Host/AgentEngine Server
  的 typed API，浏览器不直接读本地文件或保存云端密钥。
- **插件市场**：加号可添加安装源；DSH 自带插件直接启用，其他插件由原生 PluginManager
  检查、安装并返回真实加载结果。Codex 使用完整的 `plugin@marketplace` 标识调用官方 CLI，
  Skill 在新建 Codex Agent 会话中加载，连接器继续使用 Codex 原生授权。Studio 的 Codex
  Runtime 直接调用 `codex app-server`，不要求额外安装 DSH 子代理插件。
  详见[插件安装与加载合同](docs/contracts/plugin-lifecycle.md)。

## 本地开发

环境要求：Node.js `>=22.19.0`、pnpm、官方 DSH `dsh-v0.2.0-rc.2` checkout。
首次配置请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；仓库内不依赖任何个人绝对路径。

```sh
corepack enable
make setup DSH_ROOT=../deepseek-harness
make dev DSH_ROOT=../deepseek-harness
# 后续环境诊断
make doctor DSH_ROOT=../deepseek-harness
```

`setup` 会完成依赖安装、固定源码及补丁、Host/Web 编译和 Profile 安装；首次需联网与编译工具。
它复用匹配的补丁，但拒绝覆盖额外的本地修改。`dev` 在每次启动前重装当前插件，防止仍加载旧的
0.0.1。以下是这些流水线的独立步骤，供调试和 CI 按需调用：

```sh
# 插件自身检查（语法、合同测试、产品表面测试）
make check

# 打包 npm tarball（版本来自 package.json）
make pack

# 单独拉取固定源码和安装依赖；尚不应用补丁或编译（首次启动使用 make setup）
make dsh-bootstrap

# 把打包后的插件安装到指定 DSH profile（会修改 DSH_HOME）
make profile-install DSH_ROOT=/path/to/deepseek-harness

# 只读校验 Profile 确实声明并安装了当前版本插件
make profile-check

# 检查/应用当前 DSH 版本目录中的宿主兼容补丁
make patch-format-check
make patch-check DSH_ROOT=/path/to/deepseek-harness
make patch-apply DSH_ROOT=/path/to/deepseek-harness

# 对真实 DSH node-store 做 Host smoke
make verify-dsh DSH_ROOT=/path/to/deepseek-harness

# 启动浏览器版（官方 DSH Web Host）
make web-dev DSH_ROOT=/path/to/deepseek-harness

# 编译官方 Web 前端（本地宿主构建门禁）
make web-build DSH_ROOT=/path/to/deepseek-harness

# 运行官方 DSH 的 Electron 开发壳（可选）
make desktop-dev DSH_ROOT=/path/to/deepseek-harness

# 编译官方 Electron 输入（不等于签名发布包）
make desktop-build DSH_ROOT=/path/to/deepseek-harness
```

`make web-build`、`make web-dev`、`make desktop-build` 和 `make desktop-dev` 只是开发宿主流水线；插件可以独立打包，但浏览器或
桌面启动时必须由某个 DSH Host 加载它。`make desktop-start` 使用已经生成的官方桌面构建，
`make desktop-package-mac-arm64` / `make desktop-package-mac-x64` 调用官方 DSH 的 macOS
打包脚本；本地只想验证 `.app` 目录时使用对应的 `*-dir` 目标，使用
`make desktop-check-package` 做官方签名配置和工具链预检（不构建或校验镜像内容）。四个 macOS package 目标会先要求应用当前
rc.2 的 `006-desktop-plugin-package-set.patch`，再将 Studio tarball 纳入 Desktop package
set 和内置 Profile；没有这个补丁会直接失败。macOS 签名、公证和发布版本仍由 DSH Desktop
的发布配置负责。官方打包脚本要求先在 DSH checkout 的
`apps/desktop/.env.macos` 填写本机签名/发布配置；缺少该文件时会主动拒绝打包，避免生成
不可发布的假包。

`desktop-package-*` 会从固定基线和版本化补丁准备独立构建目录，避免发布重建触发开发网页的
插件热替换。依赖和输出保存在 `PACK_DIR/desktop-checkouts/`，不会复制开发 checkout 的其他
本地改动或个人 Profile。缓存复用、签名配置与本机未签名 DMG 交付见 [协作说明](CONTRIBUTING.md)。

新 checkout 没有 DSH profile 时，先执行 `make profile-install`；安装结束会自动执行
`profile-check`，核对 Profile bundle、安装包、插件 manifest、DSH 基线和运行文件。
`make web-dev` 不会隐式修改
用户的 DSH_HOME。官方 DSH checkout、Node/pnpm、profile 安装和 macOS 签名配置仍是宿主层
前置条件，不能仅靠 npm tarball 自动获得。

宿主兼容补丁按 `patches/dsh-v<version>/` 隔离。每个目录包含固定基线、应用顺序、删除条件和
补丁清单；升级 DSH 时必须新建版本目录并重新执行 `git apply --check`，禁止把不同版本的
补丁平铺在同一个目录。

## 配置来源

Studio Node Host 默认读取 `~/.agentkit/config.yaml`，也支持 `AGENTKIT_HOME` 指定目录。项目
级 `.agentkit` 配置覆盖全局默认值，密钥只由 Host 保存。模型设置页的默认提供商是金山云模型
服务，API 地址由提供商预设；自定义提供商才要求填写地址。金山云 API Key 获取入口为
[控制台 API Key](https://ksp.console.ksyun.com/#/apiKey)。云端 AK/SK、区域、控制面地址和
服务凭证也在同一页配置并写入全局配置。

模型设置页可以保存多个提供商和多个模型，每条配置有独立的凭证引用；“默认”只表示无 Agent
新会话使用的模型，不限制可配置的数量。Agent 创建页和编辑页可以多选模型作为绑定白名单，
再单独指定其中一个作为该 Agent 的默认模型。设置页保存的是可复用目录，Agent 绑定会写入
自己的 Revision。

## 真实验证边界

`pnpm check`、`pnpm pack` 和官方 DSH node-store probe 是插件发布前的硬门禁。浏览器 smoke
已验证 AgentKit 品牌、资源目录分页（29 个模型、1/2 页）、表格滚动、资源生命周期操作和
没有“保存到 Agent Revision”按钮；官方 DSH Web 构建和 Electron 编译也已通过。裸 DSH
Electron 壳可以启动，但只有发布 profile 载入本插件时才会显示 AgentKit Studio 品牌。完整
的 Agent 绑定执行、资源型 DSH Native 运行、Codex 持续 thread 和云端部署仍以对应
Host/Server 合同和真实凭证验收为准。

## 目录

- `src/client.js` 是保持在门禁内的入口注释；浏览器实现按功能拆分在
  `src/client-fragments/`，由 `scripts/build-client.mjs` 按固定顺序生成 `dist/client.js`。
- `src/index.mjs`：DSH Host 插件入口和 AgentEngine Server 控制通道。
- `src/host-remote.mjs`：Host API 与 AgentEngine Server Action 客户端。
- `docs/`：架构、合同、复用清单和验收证据。
- `CONTRIBUTING.md`：可分发的协作开发、profile 安装和发布前门禁。
- `Makefile`：Web、桌面开发、打包和 CI 入口。
- `.github/workflows/ci.yml`：Studio 包门禁，以及从 DSH 公网固定 rc.2 checkout 运行的 node-store probe。

## 发布

版本信息同时写入 `package.json`、`studio.plugin.json` 和运行时品牌信息。发布前运行：

```sh
make release-check
```

这条命令只验证 Studio 包本身，不启动 DSH 宿主；会执行 82 个本地合同测试、检查 rc.2 补丁均为
标准 unified diff、生成 0.0.1 tarball、检查 manifest/导出和个人路径泄漏，再执行
`git diff --check`。然后审阅
`CHANGELOG.md`，再在 macOS 发布机上补跑 DSH Host、App package closure、签名和公证门禁。
