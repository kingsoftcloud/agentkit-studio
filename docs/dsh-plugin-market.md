# DSH 插件市场

Studio 在 DSH 官方「插件」页里贡献一行 **插件市场**，点开后是市场本体：浏览、搜索、安装、启用/停用、更新、卸载 DSH 插件。它复用 DSH 的单一插件中心，不新增侧边栏入口，也不建立第二个插件管理器。

## 入口与边界

| 能力 | 维护方式 |
| --- | --- |
| 市场入口 | 官方 `plugins.item` 插槽，`id: agentkit-dsh-plugin-market`，`order: 50`（Codex 插件仍为 90） |
| 清单展示 | Studio 内置策展清单 + 可选远程索引；仅元数据 |
| 安装、启停、更新、卸载 | Host `pluginManager` 服务（`listBundles` / `inspect` / `installBundle` / `setBundleEnabled` / `removeBundle`） |
| 兼容性检查、审批、Profile 写入、运行时加载 | 官方 DSH 插件管理器，Studio 不绕过 |
| 安装后就绪校验 | 声明式探针：能力行（`expectedEntries`）与 Host 服务方法（`service`） |

插件市场是产品插件的一部分，不需要用户再安装 `dsh-plugin-hub` 之类的第三方商店；它与第三方商店一样都只是「插件」页里的一行。

## 发现（生态聚合）

市场默认 tab 是「发现插件」，回答的是「生态里有什么值得装」，而不是「本机已经装了什么」。数据是公开只读元数据：

| 来源 | 用途 |
| --- | --- |
| npm registry search（`keywords:dsh-plugin`，单次最多 250 条） | 包名、描述、最新版本、关键词、月下载量、仓库与主页 |
| GitHub search（`topic:dsh-plugin`，按 star 倒序 100 条） | 星标与最近活跃时间补充；没有对应 npm 包时作为 GitHub 直装条目 |
| 内置精选架（`DSH_CURATED_DISCOVERY`） | 无网络也能用的第一批高质量插件，并固定人工分类 |

- 分类由名称/描述/关键词启发式映射到固定分类（视觉外观、界面增强、记忆与上下文、搜索与联网等 13 类）；精选条目使用人工保存的分类与标签。
- 排序支持推荐（精选优先 + 下载量）、下载量、最近更新、名称；搜索覆盖名称、描述、标签、仓库。
- 去重：npm 包名优先；GitHub 仓库按 `owner/repo` 合并到同一条目；纯 GitHub 条目使用 `github:owner/repo` 安装规格。
- 缓存：内存 + `~/.cache/agentkit-studio/dsh-plugin-discovery.json` 双写，TTL 10 分钟；「刷新目录」同时刷新远程索引并强制重新拉取发现目录。
- 网络失败：有缓存时继续展示旧缓存并标记 `stale`；没有缓存时退回内置精选架，不会出现空白市场。
- 安装、启停、更新、卸载仍然全部由官方插件管理器执行；GitHub 直装条目在详情里提示「需要仓库自带可安装构建产物」。

「已安装」是第二个 tab：展示 Host 返回的 bundle 清单、加载状态与能力验证结果，生命周期操作与发现页共用同一组 remote 方法。

## 数据来源

### 官方能力清单

发现目录只提供展示与安装规格；安装后的兼容性/就绪校验仍由官方能力清单负责。`src/dsh-plugin-catalog.mjs` 的 `DSH_CURATED_PLUGINS` 随产品发布，离线可用。当前收录三项官方精选（Agent Teams、语音输入、Auto Review）。每一项可声明：

| 字段 | 说明 |
| --- | --- |
| `id` / `installSpec` | npm 包名（可带版本）；`installSpec` 缺省等于 `id` |
| `displayName` / `description` / `category` / `tags` | 市场展示 |
| `featured` / `experimental` | 精选与实验标记 |
| `capabilities` | 给用户看的能力文案 |
| `expectedEntries` | Host 应加载的能力行；安装后逐行核对 `fiberPhase === 'active'` |
| `service` | Host 服务名、必须存在的方法和可选 `probe` |
| `readinessNote` | 探针通过后的说明 |

安装入口使用 Host 给出的 `installSpec`：已登记的 bundle 以包名安装，Host 会用自身的 `installTarget`（精确版本 + 固定保存）完成升级/补齐；纯目录条目则使用清单里声明的版本规格。手动安装允许输入任意 npm 规格，先由 Host `inspect` 接受后才安装。

### 远程索引（热更新）

宿主进程设置 `AGENTKIT_STUDIO_DSH_PLUGIN_INDEX`（别名 `DSH_PLUGIN_INDEX_URL`）指向一个 HTTPS JSON 文档，即可在不发版的情况下增删或改写市场条目。`localhost` HTTP 仅用于开发调试。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-26T00:00:00Z",
  "plugins": [
    {
      "id": "dsh-example-plugin",
      "installSpec": "dsh-example-plugin@1.2.3",
      "displayName": "示例插件",
      "description": "一句话说明这个插件做什么。",
      "category": "界面",
      "tags": ["侧栏", "主题"],
      "featured": false,
      "experimental": false,
      "capabilities": ["自定义侧栏"],
      "homepage": "https://example.com/dsh-example-plugin",
      "repository": "https://github.com/example/dsh-example-plugin",
      "author": "Example"
    }
  ]
}
```

规则与失败处理：

- 文档也可以是裸数组；`schemaVersion` 只接受 `1`，最多 500 条，整个文档上限 512KiB（超出按拉取失败处理）。
- `id` 与 `installSpec` 必须是 npm 包规格；无效条目被丢弃而非猜测，接口返回 `skipped` 计数。
- 远程文档**不能**声明 `expectedEntries` / `service` / `readinessNote`：这些探针由内置清单持有，避免远程清单让 Host 去调用任意服务。
- 成功拉取后缓存 10 分钟；「刷新目录」会同时强制刷新远程索引与发现目录。
- 拉取失败不会清空市场：有旧缓存时继续展示旧缓存（`stale: true`）并在界面提示 `catalog.error`；没有缓存时回退到内置清单。
- URL 必须是 HTTPS（开发环境允许 `127.0.0.1` / `localhost` 的 HTTP），带账号密码的 URL 会被拒绝。

## 接口

| 端点 | 说明 |
| --- | --- |
| `plugins/dsh-list` | 已安装清单：`{ items, source, catalog }` |
| `plugins/dsh-discover` | 发现目录：`{ force }` → `{ items, info, source }`；`info` 含来源统计、更新时间、`stale` 与降级 `warnings` |
| `plugins/dsh-index-refresh` | 强制刷新远程索引并返回最新清单 |
| `plugins/dsh-install` | 安装（`source` 为 npm 规格） |
| `plugins/dsh-remove` | 卸载 |
| `plugins/dsh-enable` / `plugins/dsh-disable` | 启用/停用 |
| `plugins/dsh-update` | 更新 |

`items` 每行包含展示字段、`installed` / `enabled` / `removable` / `readOnlyReason`、`installTarget`、`installSpec`、`verification`（`ready` / `not-installed` / `disabled` / `failed` / `pending-restart` / `loaded`）、以及可选 `error`。

## 验证

```sh
node --test tests/dsh-plugin-discovery.test.mjs tests/dsh-plugin-catalog.test.mjs \
  tests/dsh-plugin-index.test.mjs tests/studio-plugins.test.mjs \
  tests/dsh-plugin-center.test.mjs
node scripts/build-client.mjs
```

真实 Host 验收（已执行）：在安装版 AgentKit Studio 自带的 DSH 0.2.1-rc.2 Host 上，用隔离的 `DSH_HOME` 创建 `studio-market` profile 并安装本插件，`dsh web` 打开官方「插件」页确认市场行出现；页面内实际点击「启用」→ `Agent Teams：已启用。Host 已加载 Agent Teams 服务、工具和 Web 界面。`（profile bundles 写入 `@deepseek-ai/dsh-experimental-agent-team-profile`）；点击「安装」→ `@deepseek-ai/dsh-subagent-codex：已安装。`（profile 写入依赖 `0.2.1-rc.2` 与 bundle）；点击「停用」→ `Agent Teams：已停用。插件已停用。`（bundle 从 profile 移除）。注意：这一步抓到并修复了一个源码测试测不出的问题——插件页挂载的是不带 compatibility 扩展的基础 product client，生命周期方法必须定义在该 client 上。

隔离验收可复用如下步骤（不触碰已安装 App 的 profile）：

```sh
APP="/Applications/AgentKit Studio.app"
DSH_BIN="$APP/Contents/MacOS/AgentKit Studio"
CLI="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
export DSH_HOME=/tmp/studio-market-home AGENTKIT_HOME=/tmp/studio-market-agentkit
DSH_HOME=$DSH_HOME ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$CLI" --profile studio-market --from-default-profile web --dump-config >/dev/null
DSH_HOME=$DSH_HOME ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$CLI" plugin --profile studio-market add --force "file:/path/to/kingsoftcloud-agentkit-studio-0.0.2.tgz"
DSH_HOME=$DSH_HOME ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$CLI" --profile studio-market --host 127.0.0.1 --no-open --port 3199
```

安装版自带的 `runtime/cli/bin/dsh` 启动器此前写死 `DeepSeek Harness` 二进制名，而实际打包名是 `AgentKit Studio`，导致装出来的 `dsh` 命令无法启动；上面的手动启动方式绕开了它。该问题已由 DSH 补丁 051 修正：打包时按 `DSH_DESKTOP_PRODUCT_NAME` 生成启动器，重新打包后可直接使用 `dsh`。已安装的旧包仍是旧写死版本，需要安装修复后的包。

## 信任与回滚

- 远程索引由运维配置，安装动作永远由用户点击触发；市场不自动安装插件。
- 安装失败或能力探针失败不会把插件标记为可用；`restart-required` 时明确提示重启。
- 卸载/停用走 Host 原生变更结果，失败原样上报，不谎报成功。
- 删除远程索引环境变量即可回到内置清单，不影响已安装插件。
