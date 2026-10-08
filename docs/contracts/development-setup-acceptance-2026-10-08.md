# 独立目录开发环境验收（2026-10-08）

## 本次验证范围

在 macOS arm64、Node.js 22.19.0 上，从 Studio 的 `303086b` 独立克隆并加入本次开发入口改动，
运行新的 `make setup`。开始时 Studio 没有 node_modules，DSH 目录不存在，DSH Profile 与
AgentKit 数据目录为空。使用系统已有 Git、Make、编译器和 pnpm 下载缓存，没有复制正在运行的
DSH 源码、编译目录、用户 Profile 或凭证。

`setup` 完成以下步骤：

- Studio 按 lockfile 使用 pnpm 10.33.2 安装依赖。
- 从官方 GitHub 拉取 `dsh-v0.2.0-rc.2`，核对完整 commit
  `639ed015397290b3745d163aafe02ffee4aa3f84`。
- DSH 使用 pnpm 11.7.0 安装依赖，按顺序应用 18 个固定补丁。
- 使用官方 `build:official` 编译原生模块、Host、Client 和 Web。
- 打包并安装 Studio 0.0.1，校验 Profile、bundle 和所有安装文件。
- `make doctor` 通过固定源码、补丁、工具和编译产物检查。

## 实际网页检查

通过 `make dev DSH_WEB_PORT=3198` 启动独立 Host。在进程中使用空用户 home，避免读取旧
`~/.agentengine` 配置；显式复用同一个 pnpm 下载 store，保持前一步安装关系一致。
改变 home 后直接复用原 Profile 会触发 pnpm 的 `ERR_PNPM_UNEXPECTED_STORE`；不应跨机器
复制 Profile/node_modules，正常协作按文档从源码重新安装。

浏览器验证结果：

- 页面标题与产品为 AgentKit Studio；Host 已连接。
- Agent 选择器显示搜索框、“不使用 Agent”和空本地 Agent 状态，没有历史云端框架列表。
- 取消工作区后，新会话进入“未分组”，刷新仍保持无工作区；输入框可用。
- 左下角设置入口能进入通用设置、模型与凭证和 Studio 设置。
- Studio 版本 0.0.1、DSH 版本 0.2.0-rc.2；模型 Key 和云端凭证均显示未配置。

此次未配置真实模型，未发送推理请求；网页可用不代表模型服务或云资源验收。
截图留在忽略目录 `.artifacts/clean-development-settings-20261008.png`，不纳入分发包。

## 自动检查与边界

`make release-check`：407 项测试、18 个补丁格式检查和插件包完整性检查通过。
新增测试使用临时 Git 仓库验证依赖补丁应用、重复执行、只读校验、错误基线，以及保留额外源码
改动和真实暂存区；不会 reset 开发者 checkout。新增文件纳入 portability 检查。

首次配置需要 GitHub/npm 网络与源码编译，下载缓存命中不能当作完全冷缓存耗时。
完整开发流程本次实测平台为 macOS arm64；Linux 官方构建和运行另有容器证据，Linux 开发
桌面及 Windows 原生/WSL2 流程未在本记录中验收。签名、公证 DMG 与真实预发部署仍是独立门禁。
