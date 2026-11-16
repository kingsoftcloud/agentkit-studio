# AgentKit Studio 文档写作规范（Content Spec）

> 所有参与文档重写的人都必须先读完这一页。违反规范的 PR 会被 CI 挡住。
> 工作目录：`.agents/worktrees/docs-site-rewrite`（分支 `docs-site-rewrite`，基于 `upstream/main @ f011e646`）
> 内容根：`docs-site/content/docs/`

---

## 0. 最重要的一条：内容必须重新写

旧文档（`docs/*.md`）**不是素材，是反例**。它们的内容已经整体落后于 `main`：

- 版本基线过期一个大版本（写 DSH `0.2.1-rc.2`，实际 `0.2.2-rc.1`）
- 补丁数出现 33 / 34 / 41 / 53 / 64 五个互斥值（实际 53）
- operation 数写 77 / 78（实际 134）
- 45% 的篇幅是内部重构流水账，不是对外文档

**因此：**

| 允许 | 禁止 |
| --- | --- |
| 把旧文档当成「话题清单」，看它提到过哪些主题 | 复制旧文档的段落、句子、表格、结构 |
| 从源码 `src/**`、`scripts/**`、`Makefile`、`package.json` 推导事实 | 凭记忆或凭旧文档写参数、默认值、枚举 |
| 用本规范 §8 的页面骨架组织内容 | 「换个说法重写一遍」旧文档 |

**每条事实都要能指到源码位置。** 写完一个页面，问自己：如果 reviewer 让我指出这条结论的代码依据，我能不能立刻给出 `path:line`？给不出就删掉。

---

## 1. 硬约束（违反即失败）

1. **双语 1:1**：每个 `foo.mdx` 必须同时有 `foo.en.mdx`。页面集合、`meta.json` 导航项、标题层级必须一一对应。
2. **不编造**：任何能力、命令、配置项、错误码都必须能在源码里找到依据。不确定就去读代码；读不到就不写。
3. **不写内部信息**：内网域名、凭证值、私有仓链接、分支名、裸 commit SHA、CI 运行号、个人绝对路径、内部模型代号（`deepseek-v4.1-flash-1017`）一律不出现。
4. **不写未实现的能力**：`src/client/pages/domain.mjs` 的四页空态、`resource-retry-design.md` 里的提案部分，都不算已交付能力。要么标 `status: beta`，要么不写。
5. **术语统一**：见 §6。同一个概念只允许一个名字。

---

## 2. 目录与页面清单

```
docs-site/content/docs/
├─ index.mdx                        ✅ 已完成（文档总览）
├─ getting-started/                 入门
│   ├─ index.mdx                    ✅ 已完成
│   ├─ quickstart.mdx               ✅ 已完成
│   ├─ install.mdx                  安装（macOS arm64 / Windows / 插件 / 源码）
│   ├─ interface.mdx                界面导览（4 个面板 + 设置）
│   └─ first-conversation.mdx       第一次对话
├─ concepts/                        概念
│   ├─ index.mdx                    概念总览
│   ├─ agent-revision-build.mdx     Agent · Revision · Build · Run
│   ├─ runtimes.mdx                 三种运行时
│   ├─ resources.mdx                资源与绑定
│   ├─ sessions-workspaces.mdx      会话与工作区
│   ├─ experts-teams.mdx            专家与本地团队
│   ├─ managed-runtime.mdx          托管运行时
│   └─ glossary.mdx                 术语表
├─ guides/                          任务指南
│   ├─ index.mdx                    指南总览
│   ├─ create-agent.mdx             创建与编辑 Agent
│   ├─ models-and-credentials.mdx   配置模型与凭证
│   ├─ mcp-servers.mdx              绑定 MCP Server
│   ├─ skills.mdx                   绑定 Skill
│   ├─ knowledge-memory.mdx         绑定知识库与 Memory
│   ├─ conversations.mdx            运行与调试会话
│   ├─ approvals-permissions.mdx    审批与权限策略
│   ├─ deploy-to-cloud.mdx          部署到云端
│   ├─ update-rollback.mdx          托管运行时更新与回滚
│   ├─ automation.mdx               自动化与调度
│   ├─ channels.mdx                 渠道（Channels）
│   └─ observability.mdx            可观测性（OTel）
├─ reference/                       参考（由代码生成，见 §7）
│   ├─ index.mdx                    参考总览
│   ├─ runtime-contract.mdx         运行时与实体契约
│   ├─ operations.mdx               控制协议（134 个 operation）
│   ├─ configuration.mdx            配置参考
│   ├─ environment.mdx              环境变量参考
│   ├─ templates.mdx                模板 Schema
│   ├─ plugin-catalog.mdx           插件市场目录 Schema
│   ├─ deployment-states.mdx        部署状态机
│   ├─ errors.mdx                   错误码
│   ├─ commands.mdx                 命令参考
│   └─ session-events.mdx           会话事件
├─ deployment/                      运行时与部署
│   ├─ index.mdx                    总览
│   ├─ runtimes-compare.mdx         三运行时对照
│   ├─ dsh-native.mdx               DSH Native
│   ├─ agentkit-harness.mdx         Star Harness
│   ├─ codex.mdx                    Codex
│   ├─ managed-runtime-lifecycle.mdx 托管运行时生命周期
│   └─ degradation-retry.mdx        降级与重试
├─ ecosystem/                       生态与插件
│   ├─ index.mdx                    总览
│   ├─ dsh-plugin-authoring.mdx     DSH 插件作者指南
│   ├─ plugin-market.mdx            插件市场
│   ├─ expert-templates.mdx         专家模板编写与发布
│   └─ host-compatibility.mdx       Host 兼容性
├─ releases/                        发布与迁移
│   ├─ index.mdx                    总览
│   ├─ release-notes.mdx            版本说明
│   ├─ compatibility.mdx            版本兼容表
│   ├─ upgrade-to-0.0.16.mdx        升级到 v0.0.16
│   └─ desktop-update-channels.mdx  桌面更新通道
├─ help/                            帮助
│   ├─ index.mdx                    总览
│   ├─ faq.mdx                      常见问题
│   ├─ troubleshooting.mdx          排障（按错误码）
│   └─ known-limitations.mdx        已知限制
└─ contributing/                    贡献
    ├─ index.mdx                    贡献指南
    ├─ dev-environment.mdx          开发环境
    ├─ gates.mdx                    门禁与验证
    ├─ patches.mdx                  补丁治理
    ├─ docs-style-guide.mdx         文档写作规范
    └─ security-boundary.mdx        安全与公开边界
```

**`meta.json` / `meta.en.json` 由 Lead 统一维护，不要自己改。**

---

## 3. Frontmatter

```yaml
---
title: 页面标题            # 必填，与 H1 语义一致（正文不再写 H1）
description: 一句话说明   # 必填，会进 <meta description> 和 OG 图
status: new               # 可选：new | beta | deprecated，渲染为侧边栏徽章
---
```

- `title` 中文页用中文，英文页用英文。
- `description` 40–90 字，说清「这页解决什么问题」，不要写「本文介绍了……」。
- 正文从 `##` 开始（`title` 已经是 H1）。

---

## 4. 链接规范（最容易出错，务必遵守）

| 场景 | 写法 | 例子 |
| --- | --- | --- |
| 正文 Markdown 链接 | 相对当前文件、带 `.mdx` | `[快速开始](./quickstart.mdx)` / `[概念](../concepts/index.mdx)` |
| `<Card href>` | 绝对路径，中文 `/docs/...`，英文 `/en/docs/...` | `href="/docs/concepts"` / `href="/en/docs/concepts"` |
| 锚点 | 直接 `#小节` | `[见下](#配置) ` |
| 外部链接 | 完整 URL | `https://github.com/...` |

- ❌ 不要写 `./quickstart`（缺 `.mdx`，Fumadocs 不会解析）。
- ❌ 不要写 `./quickstart.html`。
- ❌ 不要写 `docs/quickstart.mdx`（会被当成仓库路径）。
- 英文页的 Markdown 链接同样写中文源路径（`./quickstart.mdx`），运行时按当前语言解析。

---

## 5. 组件用法

```mdx
<Callout type="info" title="可选标题">说明文字</Callout>
<Callout type="warn">风险提示</Callout>
<Callout type="error">会导致失败的操作</Callout>

<Steps>
<Step>### 步骤标题
步骤内容
</Step>
</Steps>

<Tabs items={['macOS', 'Windows']}>
  <Tab value="macOS">内容</Tab>
  <Tab value="Windows">内容</Tab>
</Tabs>

<Cards>
  <Card title="标题" href="/docs/concepts">描述</Card>
</Cards>

<TypeTable
  type={{
    'runtime.type': { description: '运行时类型', type: "'dsh-native' | 'harness' | 'codex'", default: "'dsh-native'" },
  }}
/>
```

- **能用表格就不用卡片**；能用文字就不用图。
- 代码块必须标语言：` ```sh `、` ```json `、` ```ts `、` ```text `。
- 命令行块用 `sh`，Windows 差异单独给一个 `powershell` 块，不要在正文里提一句。

---

## 6. 术语表（唯一正确写法）

| 中文 | English | 代码 / 值 | 说明 |
| --- | --- | --- | --- |
| 智能体 | agent | `agentId` | 一份可复用的能力配置 |
| 修订版本 | revision | `revision` | Agent 的不可变快照 |
| Agent 构建 | build | `buildId` | 把某个 revision 固化 |
| 构建 | build（动词同形） | — | — |
| 会话 | session | `sessionId` | DSH 拥有的对话与转录 |
| 一次运行 | run | `runId` | 一个 turn |
| 运行时类型 | runtime type | `runtime.type` | 见下 |
| DSH 原生 | DSH Native | `dsh-native` | 默认运行时 |
| Star Harness | Star Harness | `harness` | 独立 Harness 服务（历史别名 AgentKit Harness / Native Harness，**不要再用**） |
| Codex | Codex | `codex` | Codex App Server |
| 资源绑定 | resource binding | `resources` | 挂到 revision 上的资源集合 |
| 托管运行时 | managed runtime | — | 云端常驻运行环境 |
| 冻结运行时 | frozen runtime | — | build 时锁定的运行时配置 |
| 专家模板 | expert template | — | 预置 Agent 模板 |
| 专家团 | team | `teamId` | 多角色协作单元 |
| 插件市场 | plugin market | — | DSH 插件页内的精选索引 |
| 宿主 / Host | Host | — | DeepSeek Harness 进程 |
| 工作区 | workspace | — | 会话绑定的目录 |
| 思考深度 | reasoning effort | — | 模型思考预算 |
| 下一句提示 | prompt prediction | — | 输入预测 |
| 执行策略 | execution policy | `read-only` / `workspace-write` / `danger-full-access` | 默认 `workspace-write` |

**改名规则**：英文术语首次出现时给中文 + 括号英文，之后统一用中文（英文页反之）。
API 字段名、枚举值、错误码**永远不翻译**。

### 6.1 平台支持矩阵（写死，不要自行扩展）

| 平台 | 架构 | 安装包 | 状态 |
| --- | --- | --- | --- |
| macOS | **Apple Silicon (arm64)** | `.dmg` | ✅ 支持 |
| macOS | Intel (x64) | — | ❌ **不支持**，文档里不出现 mac-x64 安装包 |
| Windows | x64 | `.exe`（NSIS） | ✅ 支持 |
| 浏览器（作为 DSH 插件） | — | npm 包 | ✅ 支持 |

> 历史文档里的 `AgentKit-Studio-mac-x64.dmg` 是错误信息，**任何页面都不要写**。

---

## 7. 参考页由代码生成

`reference/` 下的枚举、字段、错误码**不要手写**，由 `docs-site/scripts/generate-reference.mjs` 从源码生成：

| 页面 | 来源 |
| --- | --- |
| `operations.mdx` | `src/contracts/operations.mjs`（134 项） |
| `environment.mdx` | `src/**` 的 `process.env.*` + Host 白名单 |
| `errors.mdx` | `src/**` 的 `code: '...'`（188 个） |
| `commands.mdx` | `Makefile`（54 个目标） + `scripts/verify-*.mjs`（98 个） |
| `deployment-states.mdx` | `src/client/state/deployment.mjs`（19 态） |
| `session-events.mdx` | `src/host/dsh-session-contract.mjs`（16 事件） |
| `runtime-contract.mdx` | `src/runtime-contract.mjs` |
| `templates.mdx` | `src/team-template-contract.mjs` |
| `configuration.mdx` | `src/product.json` + `studio.plugin.json` + `dsh-pin.json` + `cordis.patch.yml` |
| `plugin-catalog.mdx` | `src/dsh-plugin-catalog.mjs` + `src/dsh-plugin-index.mjs` |

生成器输出 `.generated.mdx` / `.generated.en.mdx`，由薄封装页 import 渲染。**如果你被分配到 reference 章，先和 Lead 确认生成器是否已就绪。**

---

## 8. 每类页面的骨架

### 8.1 概念页（concepts/*）
1. 一句话定义（加粗）
2. 为什么需要它（问题场景）
3. 它和相邻概念的关系（表格或 mermaid）
4. 关键规则 / 约束（列表）
5. 相关任务（链接到 guides）
6. 相关参考（链接到 reference）

### 8.2 任务指南（guides/*）
1. 适用版本 / 前置条件（Callout）
2. 操作步骤（`<Steps>`，每步可复制）
3. 成功后的样子（怎么验证）
4. 常见错误（表格：错误码 → 原因 → 处理）
5. 相关参考

### 8.3 参考页（reference/*）
1. 一句话说明这份契约
2. 字段/枚举表（`<TypeTable>` 或 Markdown 表格）
3. 约束与默认值
4. 版本与兼容性
5. 开发者入口（源码路径）

### 8.4 排障页（help/troubleshooting）
按「症状 → 错误码 → 原因 → 处理」四列表组织，错误码可搜索。

---

## 9. 长度与密度

| 页面类型 | 目标行数 | 说明 |
| --- | --- | --- |
| 概念页 | 90–160 | 讲透一个概念，不铺开 |
| 任务指南 | 120–220 | 步骤 + 验证 + 错误处理 |
| 参考页 | 60–200（表格为主） | 密度优先，不写废话 |
| 排障 / FAQ | 80–150 | 条目化 |
| 贡献页 | 100–180 | 可执行命令 |

**禁止**：「需要注意的是」「简单来说」「强大的」「一站式」「无缝」这类填充词。

---

## 10. 提交前自检

跑仓库自己的门禁，不要另写一次性脚本：

```sh
make docs-site-check                       # 双语 1:1、断链、标题层级、frontmatter、公开边界
node scripts/public-surface-audit.mjs      # 仓库级红线：内网主机、凭证形态、个人绝对路径
make docs-site-build                       # 静态导出能编译（MDX 语法与 frontmatter 在这里暴露）
```

`tests/docs-site-i18n.test.mjs` 覆盖其中前两项，`docs-site` CI job 三个都跑。
它挡不住的只有语义错误——例如把「提案」写成「已实现」，那需要人工评审。
