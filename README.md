# AgentKit Studio

跨 Host 运行 Agent 可使用[可迁移运行包](docs/contracts/portable-agent-bundle.md)：在构建页导出
模型/MCP 配置和 Skill 文件，在新的数据目录导入并注入目标凭证。共享镜像配合私有运行包
已完成预发冷启动；三种运行时的[真实资源验收与剩余限制](docs/contracts/deployed-resource-acceptance-2026-10-08.md)
分别记录；运行中心已接入冻结版本的云端创建、状态、日志与删除，Harness 冻结包升级回滚与 [Codex 镜像升级回滚](docs/contracts/cloud-codex-tools-2026-10-09.md)已实测，三种运行时的[容器重建后续聊](docs/contracts/cloud-storage-acceptance-2026-10-09.md)已实测，完整资源组合仍在联调。
这些验收依赖对应的 Server 适配版本。共享环境重新发布后须复查能力声明；2026-10-09 的
[控制面版本复查](docs/contracts/cloud-control-plane-2026-10-09.md)记录了主线镜像缺少持久化声明及恢复候选版本的过程；适配仍待纳入主线。

AgentKit Studio 是 AgentKit 的产品界面、控制面客户端和 TypeScript 运行时提供方。它提供
Agent 创建与编辑、资源目录、构建部署、评测观测、Channel 和自动化等产品页面；本地运行时
支持 DSH Native、Codex 和 Studio 内置的 AgentKit Harness。新版只面向本地创建的 Agent 及其云端部署，不兼容历史 ADK / LangChain / LangGraph / OpenClaw / Hermes，
后续资源绑定、会话交互和部署验收均聚焦这三种运行时。

当前版本为 **0.0.1（尚未首次发布）**，固定验证基线为 **DSH v0.2.0-rc.2**（commit
`639ed015397290b3745d163aafe02ffee4aa3f84`）。Studio 基于 DSH 的公开宿主和扩展合同二次开发；
仓库不复制 DSH 源码，也不包含 Python 运行时。

DSH 来源是[官方源码仓库](https://github.com/deepseek-ai/deepseek-harness)的固定 tag 与 commit，
不是从 npm 下载一个完整离线应用。`@deepseek-ai/dsh` 是官方 CLI 的 npm 入口，安装时仍需解析
依赖；Studio 从固定源码应用本仓库的版本化补丁，再用官方 Desktop 流水线生成 DMG。升级 npm
的 `latest` 不会自动升级本项目基线。

## 是否必须安装 DSH 桌面端

不必须。桌面端是可选的宿主形态：

- **浏览器形态**：浏览器访问 Studio Web Host，控制面业务接口由 Host 对接 AgentEngine Server。
  无需安装 Electron 桌面端；本地启动 Host 和对话调试需要 Node.js 及固定 DSH checkout。
- **桌面形态**：官方 DSH Electron 壳负责窗口、更新、托盘和本地 Host。AgentKit Studio
  插件本身不打包 Electron，也不把 Python/KsADK 塞进桌面应用。桌面端只是一种可选的本地
  Host 形态，发布 profile 载入插件后显示 AgentKit Studio 品牌。

因此桌面端不是产品 API 依赖。浏览器可以连接已部署的 Studio Web Host；单独运行
AgentEngine Server 并不提供本仓库的完整原生会话界面。

## 主要产品边界

- **Agent**：以多轮对话创建为主，逐步完善草稿，明确确认后再保存；“手动配置”直接填写提示词、
  资源和运行策略，提示词模板作为可选起点。对话创建打开新的无工作区原生会话，不沿用已有 Agent 绑定。
  模型、Tool、MCP、Skill 可以多选；知识库、
  记忆库、Skill Center 每类默认一个。运行目标属于 Agent Revision，可选择 `dsh-native`、
  `harness` 或 `codex`。本地列表支持搜索、分页，最新创建的在前；会话中使用原生搜索菜单选择 Agent。云端部署当前在运行中心管理，Agent 云端标签展示当前凭证下可验证的 Studio 部署；就绪后可进入 DSH 原生会话，模型和资源使用云端冻结版本。OpenClaw 使用原生 Dashboard。
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
  版本并导出运行包。目前对话创建工具尚不提供构建操作。运行中心按选择 Agent、选择构建版本、
  检查并部署三个步骤操作，构建历史可展开调试或导出。实例规格默认 2 核 4 GB（CPU/内存 1:2），
  支持 1 核 2 GB 等通用规格和更多内存规格。检查冻结资源、镜像版本、环境及操作人后确认创建；
  部署记录默认只看当前 Agent，支持全部 Agent、已删除历史和分页，详情中保留实例标识、日志和删除。
  先在设置中配置云端凭证与私有对象存储桶；运行包私有上传由 Node Host 完成，用户无须运行 Docker。
  创建结果不明时先核对已有资源，不自动重复创建。升级/回滚复用 `UpdateAgent`，需要镜像目录声明版本探测能力；只有实际入口返回目标冻结包和本次切换标识才确认完成。旧会话保留历史，新版本需开启新会话。
  当前 Agent 已有实例时，主流程默认更新原实例；创建新实例需显式选择。可以保留同一个 Build，只更新目录推荐的运行镜像，检查阶段不提交云端写入。
  支持在云端冻结包已绑定的模型间逐轮切换，保留同一会话；新增模型须重新构建并更新实例。旧镜像不支持时给出更新提示。
  原生会话顶部的云端标记可查看实例、冻结版本、响应 ID、实际模型和资源调用凭据；云端 Trace 在本机留存时明确标记来源为云端。
  知识库和记忆调用显示耗时、命中数及写入受理状态；Skill 显示定义加载情况，实际执行仍需核对工具结果。详见[云端模型与资源凭据](docs/contracts/cloud-model-resource-receipts.md)。
  云端创建沿用 AgentEngine 的 `CreateAgentProduct`，接口复用和实际发布缺口见[部署 API 合同](docs/contracts/deployment-transport.md)。
  三种运行时共用一套镜像，Node 客户端通过 Server 已有配置表读取固定摘要的版本目录；预发候选目录及 Harness 页面创建已实测。详见[部署交互与镜像维护边界](docs/contracts/cloud-deployment-product.md)。
  `make cloud-identity` 只读核验当前云端凭证的操作人；部署客户端在创建、更新、删除前核验身份，
  创建部署必须通过子账号核验，主账号或身份不明时拒绝上传与创建。当前子账号创建及 `Creator` 回传已实测；已对该测试记录只读核对数据库中的创建者子账号 UUID；跨子账号隔离仍待验收。只读检查同时显示凭证来源和 AK 指纹，不输出密钥。
- **设置**：左下角齿轮直接打开 DSH 原生设置弹窗，模型、凭证和 Studio 配置仍在同一处管理。
- **运行中心**：构建、部署、评测、观测、Channel 和自动化都通过 Host/AgentEngine Server
  的 typed API，浏览器不直接读本地文件或保存云端密钥。
  Channels 可选择本地 Agent 或其云端部署；自动化区分本地与云端，云端计划复用 Server 调度服务。
  三种运行时已通过[真实 WPS 配对、续聊和定时结果投递](docs/contracts/wps-runtime-acceptance-2026-10-09.md)。计划经受控内部 API 创建，KOP 调度入口及真实飞书/企业微信收发仍待验收，详见[云端渠道与定时任务](docs/contracts/cloud-agent-operations.md)。
  三种运行时独立知识库盲测、Harness 资源升级回滚后的渠道调用、Codex 知识库升级回滚及 DSH 脚本 Skill 升级解绑与回滚恢复已通过，详见[资源隔离验收](docs/contracts/cloud-resource-isolation-2026-10-09.md)；DSH 知识库升级回滚和完整资源组合仍待验收。
- **插件市场**：加号可添加安装源；DSH 自带插件直接启用，其他插件由原生 PluginManager
  检查、安装并返回真实加载结果。Codex 使用完整的 `plugin@marketplace` 标识调用官方 CLI，
  Skill 在新建 Codex Agent 会话中加载，连接器继续使用 Codex 原生授权。Studio 的 Codex
  Runtime 直接调用 `codex app-server`，不要求额外安装 DSH 子代理插件。
  官方 Teams 组合包随 DSH CLI 提供，默认关闭；在插件市场启用后加载工具和团队界面，
  Studio 首次初始化不会自动开启。Codex、Harness 和云端 Teams 能力需要分别适配及验收。
  详见[插件安装与加载合同](docs/contracts/plugin-lifecycle.md)。

创建与部署页面本轮的真实浏览器验证及边界见[页面验收记录](docs/contracts/studio-ui-acceptance-2026-10-09.md)。

## 本地开发

在克隆后的 `agentkit-studio` 目录执行。准备 Node.js `22.19.0`（含 `include/node` 开发头文件）、
Git、Make 和 C/C++ 编译工具；macOS 可通过 `xcode-select --install` 安装 Command Line Tools。
Corepack 会按各仓库配置选用 Studio 的 pnpm `10.33.2` 和 DSH 的 pnpm `11.7.0`，无需全局安装
DSH、Codex 或 Python KsADK。首次配置需要访问 GitHub/npm。

```sh
corepack enable
make setup DSH_ROOT=../deepseek-harness
make dev DSH_ROOT=../deepseek-harness
# 后续环境诊断
make doctor DSH_ROOT=../deepseek-harness
```

`setup` 会完成依赖安装、固定源码及补丁、Host/Web 编译和 Profile 安装；首次需联网与编译工具。
它复用匹配的补丁，但拒绝覆盖额外的本地修改。`dev` 在每次启动前重装当前插件，防止仍加载旧的
0.0.1；打开终端输出的带鉴权 URL，默认端口为 `3098`。端口被占用可加 `DSH_WEB_PORT=3198`。
在设置页配置自己的模型及云端凭证，不复制他人的 Profile 或数据目录。

修改代码或 `git pull` 后，停止开发进程并重新执行 `make dev`；依赖或 DSH 补丁变更时先执行
`make setup`。这不是前端热更新入口。可用 `DSH_HOME`、`AGENTKIT_HOME` 指定独立测试数据目录。
开发入口已在独立 macOS arm64 目录从首次 checkout 到实际网页验收；Linux/Windows 的验证
范围及更多说明见 [CONTRIBUTING.md](CONTRIBUTING.md) 和[验收记录](docs/contracts/development-setup-acceptance-2026-10-08.md)。

以下是这些流水线的独立步骤，供调试和 CI 按需调用：

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

## 构建 macOS DMG

在 Apple Silicon Mac 上，完成上述 `make setup` 后执行：

```sh
make release-check
make desktop-package-mac-arm64-unsigned DSH_ROOT=../deepseek-harness
(cd .artifacts && shasum -a 256 -c AgentKit-Studio-0.0.1-mac-arm64-local.dmg.sha256)
open .artifacts/AgentKit-Studio-0.0.1-mac-arm64-local.dmg
```

这是本地验收包，不需要 Apple 签名、公证配置。成功后输出：

- `.artifacts/AgentKit-Studio-0.0.1-mac-arm64-local.dmg`
- 同名 `.sha256` 校验文件与 `.json` 构建记录。

`PACK_DIR=/path/to/output` 可更改产物目录。挂载后将 App 复制到 Applications，再从安装位置
启动；需要检验是否真正独立运行时，使用独立数据目录并移除 PATH 中的 Node/pnpm。产物内置
Electron、Node、Studio 插件、固定 `@openai/codex` CLI 及官方宿主运行依赖，安装使用者不需要
再执行 npm install。不会打入开发者的模型密钥、用户 Profile 或 Codex 登录凭证。
“离线包”表示安装和启动不依赖在线安装依赖，云模型、MCP、知识库等联网能力仍需网络和凭证。

首次打包需要联网下载官方运行时及依赖，并编译原生模块；后续复用构建缓存。打包在
`.artifacts/desktop-checkouts/` 的独立源码目录运行，不重建正在使用的开发 Host，也不包含 DSH
checkout 中未形成版本化补丁的额外改动。`make pack` 只生成插件 tarball，`desktop-build` 和
`desktop-start` 只用于开发构建与启动，均不会替代 DMG 目标。

正式签名包需在 `DSH_ROOT/apps/desktop/.env.macos` 中按同目录 `.env.macos.example` 配置
Apple 签名、公证和官方发布参数，配置文件不得提交。然后执行：

```sh
make desktop-check-package DSH_ROOT=../deepseek-harness
make desktop-package-mac-arm64 DSH_ROOT=../deepseek-harness
# Intel 目标：make desktop-package-mac-x64 DSH_ROOT=../deepseek-harness
```

签名目标成功后打印实际 `artifacts` 目录；它不会使用本地未签名导出文件名。当前未签名便捷目标
仅支持 `mac-arm64`，不能用于 Intel Mac。正式签名、公证发布及 x64 实机安装仍未完成验收，
不要将本地 DMG 当作正式发行包。详细流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

本轮[记忆召回](docs/contracts/memory-acceptance-2026-10-08.md)已按用户确认通过；
[流式用量](docs/contracts/streaming-usage-acceptance-2026-10-08.md)另有 Harness、DSH Native 和
Codex 三种运行时的真实 Host 验证。Linux 命令沙箱、完整原生工具 Trace、签名 DMG 和预发部署继续按独立门禁推进。

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

这条命令只验证 Studio 包本身，不启动 DSH 宿主；会执行全部本地合同测试、检查 rc.2 补丁均为
标准 unified diff、生成 0.0.1 tarball、检查 manifest/导出和个人路径泄漏，再执行
`git diff --check`。然后审阅
`CHANGELOG.md`，再在 macOS 发布机上补跑 DSH Host、App package closure、签名和公证门禁。

云端计划可配置指定渠道会话接收完成结果，详见[云端渠道、定时任务与计划结果投递](docs/contracts/cloud-agent-operations.md)。KOP Action 和云端投递服务需就绪；真实平台验收状态在该文档单独列出。
