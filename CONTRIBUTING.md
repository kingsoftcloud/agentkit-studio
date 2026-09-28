# AgentKit Studio 协作开发

这份文档是仓库内可分发的开发约定。个人机器上的 `AGENTS.md` 只用于本地自动化，不作为
项目依赖，也不应在文档中写入某位同事的绝对路径、密钥或本机 profile 内容。

## 环境

- Node.js `22.19.0`（版本写在 `.node-version`）
- pnpm `10.33.2`（版本写在 `package.json` 的 `packageManager`）
- 官方 DSH `0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`
- macOS DMG 还需要 DSH Desktop 的签名、公证和发布配置；普通 Web/Node 检查不需要云端密钥

Studio 基于公开 DSH 源码和扩展合同二次开发，但本仓库不复制 DSH 源码；运行和宿主验证需要
固定版本的官方 checkout。通过环境变量指定官方 checkout 和用户数据目录：

```sh
export DSH_ROOT=/path/to/deepseek-harness
export DSH_HOME=/path/to/dsh-home       # 可选；默认 ~/.dsh
export AGENTKIT_HOME=/path/to/agentkit  # 可选；默认 ~/.agentkit
```

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
证据。fixture 测试只能证明合同投影，不能替代模型、资源绑定、云端部署或签名 DMG 验收。

设置页的模型目录支持多个提供商和多个模型。请确认新增条目使用独立的
`credentialName`，且恰好一个条目标记为默认；Agent Revision 的多模型绑定应在创建页或
编辑页验证，不要把“默认模型”误当成“只能配置一个模型”。
