# AgentKit Studio

AgentKit Studio 是一个运行在官方 DeepSeek Harness（DSH）之上的 AgentKit 产品插件。它提供
Agent 创建与编辑、资源目录、构建部署、评测观测、Channel 和自动化等产品页面，并复用 DSH
原生的会话、工作区、文件工具、审批 UI、设置框架和桌面壳。

当前首个公开可复现版本为 **0.0.1**，固定验证基线为 **DSH v0.1.7-rc.2**（commit
`477b4f420553e8a52c2fbccc464d7561b239c443`）。插件不复制 DSH 源码，也不包含 Python
运行时。

## 是否必须安装 DSH 桌面端

不必须。桌面端是可选的宿主形态：

- **浏览器形态**：用官方 DSH Web Host 启动插件，浏览器访问带会话 token 的地址即可。用户不
  安装 Electron 桌面端也能使用；本地调试需要 Node.js 和官方 DSH checkout，生产环境可以由
  统一的 Web Host 或 AgentEngine Server 托管。
- **桌面形态**：官方 DSH Electron 壳负责窗口、更新、托盘和本地 Host。AgentKit Studio
  插件本身不打包 Electron，也不把 Python/KsADK 塞进桌面应用。桌面端尚需把本插件加入
  DSH Desktop 的发布 profile，才能显示 AgentKit Studio 品牌；直接启动官方裸壳只会显示
  DeepSeek Harness 欢迎页。

因此桌面端不是产品 API 依赖，但使用本地 DSH 会话和本地文件工具时仍需要一个 DSH Host。
若用户没有本地 Host，应连接 AgentEngine Server；无 Agent 的普通对话则由所连接的 DSH
Host 继续执行。

## 主要产品边界

- **Agent**：快速创建、一键创建、对话创建和编辑。模型、Tool、MCP、Skill 可以多选；知识库、
  记忆库、Skill Center 每类默认一个。运行目标属于 Agent Revision，可选择 `dsh-native`、
  `harness` 或 `codex`。
- **资源库**：只做资源生命周期管理，包括发现、导入、探测、查看、刷新、删除和分页列表。
  资源库不选择 Agent，也不写 Agent Revision；绑定关系只在创建页或编辑页提交，和 Revision
  一起保存、审计和回滚。
- **对话**：不选择 Agent 也能走 DSH 原生循环；选择已创建 Agent 后打开绑定对话，绑定
  Agent 的流式会话由 Host canonical conversation 接口承载。当前 DSH 官方 Composer 尚未
  提供把任意 Studio Revision 动态映射为 preset 的公共 admission/provider 合同，因此
  不能把顶部“候选智能体”选择器当作已切换执行器的证据。
- **运行中心**：构建、部署、评测、观测、Channel 和自动化都通过 Host/AgentEngine Server
  的 typed API，浏览器不直接读本地文件或保存云端密钥。
- **插件市场**：分别管理 DSH 与 Codex 原生插件。Codex Runtime 创建失败并出现“Codex
  Provider 未注册”时，说明当前 DSH/KsADK profile 没有安装并启用官方
  `@deepseek-ai/dsh-subagent-codex`；安装后必须重启 profile 才会注册 provider。Studio
  不会伪造一个 Codex provider，也不会把 DSH 的 one-shot 子代理当作完整持续会话。

## 本地开发

环境要求：Node.js `>=22.19.0`、pnpm、官方 DSH `dsh-v0.1.7-rc.2` checkout。

```sh
# 插件自身检查（语法、合同测试、产品表面测试）
make check

# 打包 npm tarball（版本来自 package.json）
make pack

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
`make desktop-check-package` 做包内容检查。macOS 签名、公证和发布版本仍由 DSH Desktop
的发布配置负责。官方打包脚本要求先在 DSH checkout 的
`apps/desktop/.env.macos` 填写本机签名/发布配置；缺少该文件时会主动拒绝打包，避免生成
不可发布的假包。

## 配置来源

Studio Node Host 默认读取 `~/.agentkit/config.yaml`，也支持 `AGENTKIT_HOME` 指定目录。项目
级 `.agentkit` 配置覆盖全局默认值，密钥只由 Host 保存。模型设置页的默认提供商是金山云模型
服务，API 地址由提供商预设；自定义提供商才要求填写地址。金山云 API Key 获取入口为
[控制台 API Key](https://ksp.console.ksyun.com/#/apiKey)。云端 AK/SK、区域、控制面地址和
服务凭证也在同一页配置并写入全局配置。

## 真实验证边界

`pnpm check`、`pnpm pack` 和官方 DSH node-store probe 是插件发布前的硬门禁。浏览器 smoke
已验证 AgentKit 品牌、资源目录分页（29 个模型、1/2 页）、表格滚动、资源生命周期操作和
没有“保存到 Agent Revision”按钮；官方 DSH Web 构建和 Electron 编译也已通过。裸 DSH
Electron 壳可以启动，但只有发布 profile 载入本插件时才会显示 AgentKit Studio 品牌。完整
的 Agent 绑定执行、资源型 DSH Native 运行、Codex 持续 thread 和云端部署仍以对应
Host/Server 合同和真实凭证验收为准。

## 目录

- `src/client.js`：Studio 浏览器页面、资源目录、Agent 创建/编辑和二级导航。
- `src/index.mjs`：DSH Host 插件入口和 AgentEngine Server 控制通道。
- `src/host-remote.mjs`：Host API 与 AgentEngine Server Action 客户端。
- `docs/`：架构、合同、复用清单和验收证据。
- `Makefile`：Web、桌面开发、打包和 CI 入口。
- `.github/workflows/ci.yml`：无凭证 CI 检查。

## 发布

版本信息同时写入 `package.json`、`studio.plugin.json` 和运行时品牌信息。发布前运行：

```sh
make ci
```

然后审阅 `CHANGELOG.md`，再提交并推送到 AgentKit Studio 远程仓库。
