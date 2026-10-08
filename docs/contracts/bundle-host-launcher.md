# 运行包 Host 启动与 Linux 构建输入

此入口服务于新版 Studio 的 DSH Native、Harness 和 Codex 运行包。它复用官方 DSH CLI、
Profile、Settings、AgentLoop 和会话持久化，不引入另一套会话数据库或执行循环。
当前仍是云端发布的准备工作，不是 AgentEngine 预发部署成功的证据。

## 安装目录与启动

构建阶段须安装固定版本 DSH、完整生产依赖和 Studio 插件：

```text
runtime/
  node_modules/@deepseek-ai/dsh/lib/bin.js
  node_modules/@deepseek-ai/…
  node_modules/@kingsoftcloud/agentkit-studio/scripts/start-agent-bundle.mjs
```

不能只放两个入口包：Studio 使用的公共 DSH LLM、Session 等模块也必须在生产依赖目录里。
DSH 版本必须符合插件清单的 `requiredDsh`；镜像还应固定本项目的补丁和依赖锁文件。

目标环境注入运行包清单列出的资源凭证，以及至少 24 字符的 `AGENTKIT_RUNTIME_TOKEN`。
默认运行端口是回环地址的 8080；容器需要显式设置 `AGENTKIT_RUNTIME_HOST=0.0.0.0`，
只通过有鉴权的网关对外提供服务。

```sh
node runtime/node_modules/@kingsoftcloud/agentkit-studio/scripts/start-agent-bundle.mjs \
  --archive /app/code/portable.zip \
  --state /var/lib/agentkit/deployment \
  --installation /opt/agentkit/runtime \
  --sha256 EXPECTED_BUNDLE_SHA256
```

启动命令不执行 npm/pnpm、在线拉包或读取个人 Profile。DSH Web Host 始终绑定回环地址的
随机端口；对外入口是已鉴权的 `/v1/responses`。不要把令牌写入命令行或镜像层。

状态目录首次使用必须为空，随后只能用于同一份 ZIP。目录内记录包摘要，分别保留
AgentKit、DSH、HOME 和工作目录；符号链接、已有个人目录、不同包复用状态均被拒绝。
导入先写临时目录再发布，已有历史不会被重新导入覆盖。启动过程中断可能留下未使用的
临时目录，下一次启动不会把它认作有效运行包，也不会自动清理其他进程的文件。

子进程仅获得指定资源凭证、访问令牌、监听设置、语言/PATH 和可信 CA 配置。
不继承操作人员的 NODE_OPTIONS、DSH/Codex Profile、个人模型或云端密钥。资源凭证名称
不能占用 Host 控制变量；运行包自动生成的 `AGENTKIT_BUNDLE_*` 引用可正常使用。
SIGTERM/SIGINT 转发给 DSH，15 秒后仍未退出则终止子进程。

重启时必须保留状态卷和访问令牌，才可通过前一轮 `previous_response_id` 继续会话。
多副本共享状态、热替换运行包和完整 Responses API 不在当前合同内。

## 固定构建输入

提交 Studio 源码后执行：

```sh
make runtime-source-stage DSH_ROOT=/path/to/pinned-dsh \
  RUNTIME_SOURCES_DIR=/path/to/new-build-inputs
```

输出 `studio-source.tar`、`dsh-source.tar` 和 `runtime-sources.json`。Studio 只归档 HEAD；
DSH 从固定 commit 创建隔离 checkout，按已提交的 Studio 补丁重建后归档 Git tree。
复用桌面打包已有的隔离 checkout 管理，不重建或重置正在服务开发网页的 checkout。
清单记录两个 commit、补丁后的 tree、版本、字节数和 SHA256；不包含本机路径或凭证。
目标目录必须不存在；个人配置、忽略文件、node_modules 和额外的本地修改不进入归档。

这些源归档仍需 Linux builder 编译、安装生产依赖并执行容器 smoke。不能直接作为可运行
镜像，也不能把本机已编译的 macOS 原生模块复制进去。

## 2026-10-08 本机验收

执行 `scripts/verify-bundle-host.mjs --execute --installation RUNTIME --runtime TYPE --keep`。
Node 22.19.0、DSH 0.2.0-rc.2，Studio 从 tarball 解包，DSH 的编译产物和依赖仍链接到本机
固定 checkout。因此以下结果是本机 Host 证据，不是 Linux、独立分发或断网环境证明。

| 运行时 | 模型 | 文本流帧 | 系统提示词盲测 | 重启后续聊 |
| --- | --- | ---: | --- | --- |
| Harness | GLM-5.3-Flash | 137 | 通过 | 通过 |
| DSH Native | GLM-5.3-Flash | 125 | 通过 | 通过 |
| Codex | GLM-5.3-Flash | 138 | 通过 | 通过 |

测试先删除导出时的源 Agent 目录，只问南京旅行计划。随机 route_tag 仅存在于系统提示词；
首轮完成后退出 Host，用相同状态目录重启，仅传 previous_response_id 追问目的地和预算。
三个运行时均回答南京和 900 元。启动期间没有运行包管理器；模型调用仍使用网络。

首次试验只链接 CLI/Studio 两个包，出现缺少 `@deepseek-ai/dsh-llm` 的错误；补齐编译后的
DSH 依赖目录后通过。此失败明确说明镜像需要完整运行依赖，不能靠开发环境碰巧解析成功。
本轮 Docker daemon 的 Unix socket `_ping` 超时，未重启其他容器，Linux 镜像构建和预发
UploadCode/CreateAgentProduct/UpdateAgent 联调仍未验收。
