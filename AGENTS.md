# AgentKit Studio 开发约定

这份文件是仓库内可分发的协作约定。不要写入个人绝对路径、密钥、本机 profile 内容或
仓库目录规则；个人环境说明放在本机的忽略文件中。

## 项目边界

- AgentKit Studio 是产品插件、TypeScript 客户端和可选的本地 Harness provider。
- 新版运行时范围限定为 DSH Native、Codex 和 AgentKit Harness；不展示或兼容历史云端 ADK / LangChain / LangGraph / OpenClaw / Hermes Agent。Agent 范围仅为本地创建及其可验证的云端部署；OpenClaw 使用其原生 Dashboard。
- Studio 基于公开的 DSH 宿主和扩展合同二次开发；运行与 Web/Desktop 集成需要 DSH。仓库不复制
  DSH 源码，也不注入 DSH 的私有内核对象，开发时通过 `DSH_ROOT` 使用固定版本 checkout。
- KsADK 是可选的兄弟 SDK、CLI 和托管运行时，不是本项目的 Python 运行时依赖。
- AgentEngine Server 是共同控制面；客户端只通过公开的 typed API 访问它。

## 本地环境

- Node.js 版本以 `.node-version` 为准。
- pnpm 版本以 `package.json` 的 `packageManager` 为准。
- 官方 DSH checkout 通过 `DSH_ROOT` 指定，默认值只适用于相邻目录布局。
- 用户配置默认在 `~/.agentkit`，可用 `AGENTKIT_HOME` 指定测试目录；不要把凭证写入仓库。

## 常用门禁

```sh
pnpm install --frozen-lockfile
make check
make pack
git diff --check
```

需要官方宿主时显式传入 `DSH_ROOT`，并先执行 `make profile-install`。涉及宿主兼容补丁时，
先执行 `make patch-check`，确认版本和 commit 匹配后再执行 `make patch-apply`。

## 模型配置语义

设置页维护可复用的多个提供商和模型，每条配置使用独立的凭证引用，并且只能有一个“默认”
模型。默认模型用于无 Agent 的新会话；Agent 创建页和编辑页可以从模型资源中多选绑定，
其中单独指定的默认模型写入 Agent Revision。不要把 API Key 打进浏览器状态、日志或测试
fixture。

## 补丁和提交

宿主补丁按 `patches/dsh-v<version>/` 分目录维护。每个版本目录必须包含基线说明、应用顺序
和删除条件；升级 DSH 时新建目录，不要混用不同版本的补丁。提交前同步更新文档、测试和
CHANGELOG，并把真实宿主、云端或桌面验证的边界写清楚。

更多协作、发布和桌面打包说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
