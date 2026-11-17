# 插件市场索引（社区插件）

本目录是 Studio 内置的默认插件索引源：一份按 npm 月下载量排序的「社区最受欢迎的 DSH 插件」清单，遵循 DSH 插件市场的 **format 1** 静态 JSON 索引格式。DSH 在**发现**标签页中读取它，格式由 `@deepseek-ai/dsh-plugin-market-index` 校验。

| 文件 | 作用 |
|---|---|
| `index.json` | 生成产物，提交进仓库；DSH 直接读取它。 |
| `sources.txt` | 包列表，每行一个 npm 包名；`#` 开头与空行忽略。 |
| `README.md` | 本说明。 |

## 刷新索引

需要 Node.js ≥ 24，零依赖（只用 `node:` 内置模块与全局 `fetch`）：

```sh
node scripts/build-plugin-market-index.mjs
```

生成器只访问 `https://registry.npmjs.org`，同时最多 6 个请求、单请求 20 秒超时。单个包失败时打印 `warning:` 并跳过，不中断整份生成。输出是确定性的：插件按 `metadata.sortKeys.downloads` 降序、同分按 `name` 升序排列，且不含生成时间戳、无随机字段，因此 diff 只反映 registry 数据本身的变化。

生成结束前会自校验一次：`JSON.parse` 后逐项检查必填字段，任何违规都以退出码 1 结束并打印违规值的 JSON 路径（此时不会覆盖已提交的 `index.json`）。

### 收录规则

- **版本**：版本号必须是合法 SemVer，`time[version]` 存在，未被 `deprecated`，且 `private !== true`；每个插件最多保留 20 个版本，按 SemVer 降序。
- **`publishTimestamp`**：`Math.floor(Date.parse(time[version]) / 1000)`，必须是 `[0, 10^11)` 内的整数。
- **`source`**：`{ "type": "npm" }`；该版本 manifest 的 `engines.dsh` 是合法 SemVer range 时一并写入（`workspace:` range 会被丢弃）。
- **展示信息**：取自 `dist-tags.latest` 对应版本的 manifest（缺失时回退到 packument 顶层）。`title` 用 `displayName` 或包名；`description` 去换行并截断到 400 字符；`author` 截断到 60 字符；`homepage` 与 `repository` 只保留 https URL，`repository` 归一为 `{ "url": ... }`；`icon` 不生成。
- **`metadata.keywords`**：每个关键词截断到 24 字符，去重后最多 8 个。
- **`metadata.sortKeys.downloads`**：该包的 npm 月下载量，来自搜索结果的 `downloads.monthly`。

## 数据来源与更新频率

| 数据 | 来源 |
|---|---|
| 包列表（首次生成） | `https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250`，按 `downloads.monthly` 降序取前 80 个合法包名写入 `sources.txt` |
| 月下载量 | 同上搜索结果的 `downloads.monthly` |
| 插件展示信息与版本 | `https://registry.npmjs.org/<encodeURIComponent(name)>`（完整 packument） |

`index.json` 是 registry 数据的一份快照，仓库本身不会自动更新。按发布节奏定期刷新（例如每周或每次发版前）并提交生成的 diff 即可。若某个包不在搜索结果的前 250 名内，其下载量记为 0 并打印 warning，排序会靠后。

### 维护 `sources.txt`

- 增删插件：直接编辑 `sources.txt` 后重跑生成器。
- 重建排名：删除 `sources.txt` 后重跑生成器，会按当前搜索结果重新取前 80。

## CI 中的 `--check`

```sh
node scripts/build-plugin-market-index.mjs --check
```

`--check` **不联网**，只校验已提交的 `index.json`：文件存在、可被 `JSON.parse` 解析、`format === 1`、每个插件的必填字段齐全（`name`、`title`、`metadata.keywords`、`metadata.sortKeys.downloads`、非空的 `versions`，以及每个版本的 SemVer、`publishTimestamp`、`source`），并拒绝重复的插件名与重复版本。通过时打印一行统计并以退出码 0 结束；任何违规都以退出码 1 结束并打印 JSON 路径，适合放在 `pnpm run check` 或 CI 的静态检查里，防止手改或合并冲突破坏索引。

## 注意

索引是第三方内容：DSH 只校验文件格式，不验证插件标题、描述、图标、作者和来源的真实性。安装前请核对确认框中的来源。
