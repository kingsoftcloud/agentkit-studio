# 设置 → 模型与凭证：视觉与交互重做

> 分支：`feat/settings-models-redesign-20261109`（基于 `upstream/main`）
> 范围：仅前端呈现层（`src/client/pages/model-settings.mjs` + 样式表）。
> 数据流、Host RPC、保存载荷与协议均未改动。

## 1. 问题核实

按截图逐条对照旧实现（`src/client/pages/model-settings.mjs`、`src/client/styles/forms.css.mjs`、
`src/client/styles/responsive.css.mjs`）：

| 反馈 | 代码事实 | 处理 |
| --- | --- | --- |
| 卡片贴住容器边缘 | `forms.css` 里 `[data-studio-model-settings] article { padding: 18px 0 !important }` 把水平内边距清零，模型名直接压在 1px 描边上 | 删除该覆盖；卡片内边距统一 20/24px |
| 双层边框 | 卡片（1px 边框 + 圆角 16）内部又套「1. API Key」块（`background: canvas` + 1px 边框 + 圆角 12） | 取消嵌套卡片，改为「单一面板 + 分区（hairline 分隔）」 |
| 圆角不统一 | 卡片 16 / 内块 12 / 输入 12（`--dsw-radius-md`）/ Pill 999 | 建立 8/10/16 三档圆角，嵌套时按「父圆角 − 间距」收敛 |
| 栅格失衡 | `repeat(auto-fit, minmax(220px, 1fr))`：左列被拉宽、右列「2. 选择模型」被挤到 220px 左右，说明文字折行 | 主从布局（列表 252px + 编辑区自适应），编辑区内部两列只在 ≥760px 时出现 |
| 层级混乱 | 汇总卡与模型卡使用相同 1px 边框 + `0 8px 24px` 阴影 + 16 圆角，视觉权重相同 | 汇总降级为一条状态带（无边框、无阴影）；模型列表成为唯一主面板 |
| 步骤序号过大 | `1. API Key` / `2. 选择模型` 作为 12px 加粗标签跨行出现，且与右侧说明争抢宽度 | 改为 18px 小号数字徽标 + 13px 分区标题 |
| 状态标签随意 | `Pill`（5px 9px、11px、999）与纯文本「本机保存」混排，位置在标题、按钮行、说明行之间跳动 | 全页统一 `.ms-chip`（高 20、11px、圆角 999、四种 tone），只出现在标题/行首 |
| 控件高度不一致 | 输入 32px（`inputStyle`）vs 按钮 36px（`buttonStyle`）vs 关闭按钮 30px | 统一 36px 标准 / 32px 紧凑 / 40px 强调 |
| 缺 focus 态 | `responsive.css` 的 focus-visible 规则包含 `[data-studio-model-settings]`，但输入框 `:focus` 无描边变化；且该规则被后续 `!important` 覆盖 | 控件自带 `:hover` / `:focus`（描边 + 3px ring）/ `:disabled` |
| 说明与操作脱节 | 「金山云使用默认地址…」是一个独立灰底色块，与地址字段分处两列 | 说明紧贴对应控件下方；金山云地址改为只读展示 + 「默认」chip |

## 2. 设计规范

### 2.1 间距标尺（4 的倍数）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ms-space-1` | 4px | chip 内间距、图标与文字 |
| `--ms-space-2` | 8px | 行内元素、chip 组、按钮组 |
| `--ms-space-3` | 12px | 字段内间距、网格间距 |
| `--ms-space-4` | 16px | 分区 padding-top、标题与内容 |
| `--ms-space-5` | 20px | 编辑区上内边距 |
| `--ms-space-6` | 24px | 编辑区水平内边距、卡片内边距 |
| `--ms-space-8` | 32px | 页面级留白（窄屏） |

规则：卡片内边距 ≥ 20；分区之间只用一个 hairline + 16px，不叠「间距 + 边框 + 间距」。

### 2.2 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ms-radius-sm` | 8px | 紧凑按钮、步骤徽标（6px 用于 18px 方块） |
| `--ms-radius-md` | 10px | 输入框、下拉、标准按钮、列表项 |
| `--ms-radius-lg` | 16px | 主面板、云端分组 |

嵌套规则：子元素圆角随父级收敛（面板 16 → 内部控件 10），不再出现「16 里套 12 里套 12」。

### 2.3 描边与投影

| 层级 | 值 | 用途 |
| --- | --- | --- |
| hairline | `1px solid var(--dsw-alias-border-l2)` = `#0000001a` | 面板、分区、页脚分隔 |
| 控件描边 | `1px solid var(--dsw-alias-border-l3)` = `#0000001f` | 输入、下拉、按钮 |
| 只读展示 | `1px dashed` + 6% 填充 | 不可编辑的默认地址 |
| 阴影 L1 | `0 1px 2px rgba(15,17,21,.04)` | 主面板、选中列表项 |
| 阴影 L2 | 仅由宿主弹窗使用（本页不叠加） | — |

明确禁止：卡片内再放带边框的卡片；两个相邻元素各自 1px 边框形成「双线」。

### 2.4 字体层级

| 角色 | 字号/行高 | 字重 | 颜色 |
| --- | --- | --- | --- |
| 页面标题（h3） | 17 / 24 | 600 | `label-primary` |
| 编辑区标题（h4） | 15 / 22 | 600 | `label-primary` |
| 分区标题（h5） | 13 / 20 | 600 | `label-primary` |
| 正文 / 控件 | 13 / 20 | 400 | `label-primary` |
| 字段标签 | 12 / 16 | 500 | `label-secondary` |
| 辅助说明 | 12 / 18 | 400 | `label-tertiary` |
| 状态标签 | 11 / 1 | 600 | tone 色 |
| 计数/来源 | 11 / 16 | 400 | `label-tertiary` |

### 2.5 控件高度

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ms-h-sm` | 32px | 编辑区标题行操作（设为默认/停用/移除） |
| `--ms-h` | 36px | 输入、下拉、次要按钮、状态带 |
| `--ms-h-lg` | 40px | 页脚主操作（保存配置） |

### 2.6 状态色

| 语义 | tone | 前景 | 背景 |
| --- | --- | --- | --- |
| 默认模型 | `accent` | `#2f5ccc` / `#9dbcf5` | `#e9f0fd` / `#16233a` |
| 已配置 | `success` | `#157f4a` / `#5fd08a` | `#e8f8ee` / `#10281a` |
| 需要配置 | `warn` | `#946200` / `#f0c169` | `#fdf3e2` / `#2b2111` |
| 已停用 | `neutral` | `label-secondary` | 6% 填充 |
| 移除 / 错误 | `danger` | `#b42318` / `#ff8f86` | 透明 |

全部颜色先取 DSH token（`--dsw-alias-*`），tint 用 `light-dark()` 给出明暗两值，
不新增强制品牌色。

### 2.7 交互态

- **hover**：控件描边加深到 `label-tertiary`；按钮填充 6% → 9%。
- **focus**：输入/下拉为 `border-color: accent` + `0 0 0 3px rgba(65,118,230,.18)`；
  按钮为 `outline: 2px accent, offset 2`。鼠标点击输入框也显示焦点（不是仅 `:focus-visible`）。
- **disabled**：`opacity: .45` + `cursor: not-allowed`，不用灰色实心块。
- **选中**（列表）：白底 + hairline + L1 阴影，与 hover 的浅填充区分。
- **动效**：仅 details 箭头 120ms；`prefers-reduced-motion` 下关闭。

## 3. 信息架构

### 3.1 改造前

```
┌─ 模型与提供商 ─────────────────────────────── [2 个模型] ┐
│ 先填写 API Key，再读取模型目录并测试连接…                  │
├──────────────────────────────────────────────────────────┤
│ 当前默认模型  deepseek-… [金山云]      2 | 2/2 | 2/2  [＋添加] │  ← 与下方同权重
├──────────────────────────────────────────────────────────┤
│ deepseek-… [默认][已配置]                    [停用][移除]  │
│ 提供商 [下拉]        ┌ 1. API Key ─────────┐  2. 选择模型  │  ← 嵌套边框 / 窄列
│ 金山云默认地址…      │ [key] [读取][测试]  │  [下拉]      │
│                      └─────────────────────┘  说明折行…   │
│ ── 输入能力 ── 文字 图片 ── 模型目录已识别 ──              │  ← 横向切一刀
│ 思考等级 [下拉]                         ▸ 高级连接设置      │
├──────────────────────────────────────────────────────────┤
│ gpt-5 [已配置]                              [设默认][停用] │  ← 整表单再来一遍
│ …                                                        │
└──────────────────────────────────────────────────────────┘
```

问题：每个模型重复整张表单，页面随模型数线性变长（两模型时 ≈ 2900px）；
「当前默认」与模型卡争主次；步骤块是第三个视觉层级。

### 3.2 改造后

```
┌─ 模型与提供商 ──────────────────────────────── [＋ 添加模型] ┐
│ 配置提供商、凭证与模型；标记为「默认」的模型用于新会话。        │
├──────────────────────────────────────────────────────────────┤
│ ● 默认模型  deepseek-…  [金山云模型服务]   2 个模型 · 2 已启用 · 2 已配置 │ ← 状态带
├───────────────┬──────────────────────────────────────────────┤
│ 模型        2 │ deepseek-… [默认][已配置]        [停用][移除] │
│ ▸ deepseek-… │ 金山云模型服务 · ksyun-default                │
│   金山云 ●已配置│ ──────────────────────────────────────────── │
│ ▸ gpt-5      │ ① 连接                                       │
│   OpenAI ●已配置│ 提供商 [下拉]      API 地址 [只读 + 默认]     │
│              │                    金山云使用默认地址…         │
│              │ ──────────────────────────────────────────── │
│              │ ② 凭证                         获取 Key ↗     │
│              │ API Key [••••••••••]                          │
│              │ Key 只保存在本机…                             │
│              │ [读取模型] [测试连接]        凭证来源 · 本机保存│
│              │ ● 已读取 3 个模型                             │
│              │ ──────────────────────────────────────────── │
│              │ ③ 模型                                        │
│              │ 模型名称 [下拉/输入]                          │
│              │ 输入能力 文字 图片 模型目录已识别               │
│              │ ──────────────────────────────────────────── │
│              │ ④ 高级                                        │
│              │ ▸ 连接与思考模式                              │
│ 「默认」模型用于新会话                                        │
└───────────────┴──────────────────────────────────────────────┘
┌─ 云端凭证 [已配置] ──────────────────────────────────────────┐
│ 用于构建、部署和资源访问，只保存在本机。                       │
│ Access Key [••••]              Secret Key [••••]             │
│ ▸ 高级云端设置                                                │
└──────────────────────────────────────────────────────────────┘
                                        [重新读取] [保存配置]
```

关键决策：

1. **主从关系**：列表是「谁」的索引（名称、提供商、状态、默认标记），编辑区是「怎么配」。
   列表常驻（`mode=all`），窄容器（<760px）自动降为横向切换条。
2. **默认模型降级**：不再是卡片，而是一条 36px 状态带；同时在列表项与编辑区标题用
   `默认` chip 标注，避免三处重复。
3. **分区而非步骤**：`① 连接 → ② 凭证 → ③ 模型 → ④ 高级`，序号 11px、18px 徽标，
   只做定向不做标题。
4. **单一面板**：整页只有一个 1px 边框的容器，列表与编辑区由内部 hairline 分隔，
   杜绝「卡片套卡片」。
5. **一条主操作**：页脚右侧只有「保存配置」为主按钮；「添加模型」在页头，
   「读取模型 / 测试连接」留在凭证区就近操作。

## 4. 实现

### 4.1 文件

| 文件 | 变更 |
| --- | --- |
| `src/client/pages/model-settings.mjs` | 重写渲染层：主从布局、状态带、chip、分区、控件 class；新增 `selectedKey` 选中态与样式注入；行为/载荷不变 |
| `src/client/styles/model-settings.css.mjs` | 新增：设计 token + 全部页面样式（含容器查询、明暗 tint、focus/hover/disabled） |
| `src/client/styles/forms.css.mjs` | 删除会破坏新布局的 `!important` 覆盖（`article` 内边距、`form` gap、label 字重等） |
| `src/client/styles/responsive.css.mjs` | 删除与本页冲突的尺寸/字号覆盖（32px 输入、12px 圆角、`h3` 字号、蓝框 focus 等） |
| `src/client/styles/credential-onboarding.css.mjs` | 删除会把云端分组压平的 `form > section` 覆盖，改由 `.ms-cloud[data-solo]` 处理 |

### 4.2 细节

- 样式通过 `leaseDocumentResource(document, 'agentkit-studio:model-settings')` 注入，
  多次挂载/卸载安全；`createModelSettingsSection` 新增可选 `document` 参数（默认 `globalThis.document`）。
- 表单控件不再使用共享 `inputStyle()/buttonStyle()`，避免与其它页面的 32px/12px 规格互相牵制；
  共享组件 `SecretInput` 继续复用，仅通过 `className="ms-input"` 接入新尺寸。
- 保留全部 `data-*` 契约：`data-studio-model-settings`、`data-onboarding-mode`、
  `data-model-profile-card`、`data-model-provider`、`data-model-summary`、
  `data-model-input-capability`、`data-studio-form-footer`。
- 保留源码中的历史检索串「添加提供商或模型」（注释），以及 `ksp.console.ksyun.com/#/apiKey`。
- 无障碍：
  - 模型名称控件补 `aria-label="模型名称"`（目录选择）/ `"自定义模型名称"`（手动输入），
    与同页另一分支的 onboarding 校验脚本一致；
  - 提供商、API 地址、Codex 协议、思考模式各自有 `aria-label`，不再依赖视觉标签；
  - 校验消息 `role="status"`，错误 `role="alert"`；列表项 `aria-current` 标记当前编辑项。

### 4.3 与 `#102`（原 `fix/onboarding-ui-verification-20261109`）的关系

该分支已经以 PR #102 合入 `main`，本分支已 rebase 到它之上。两边对同一页的处理：

- #102 为控件补了可供语义定位的 accessible name：`提供商`、`API 地址`、`API Key`、
  `模型名称`（手填）、`选择模型`（目录下拉），并新增
  `tests/onboarding-ui-verification.test.mjs` 守护这组名字；
- 本分支保留全部名字（下拉与手填互斥渲染，任一时刻只有 `模型名称` 一个输入框），
  并额外保证 profile 卡片里保留 `<strong>` 承载模型名（宿主验收脚本用
  `card.locator('strong')` 断言当前模型）；
- 唯一被修改的 #102 断言是「必须存在 `2. 选择模型` 的可见 label」——
  本次重做正是要把大号步骤标签换成分区标题，因此改为断言 `模型` 分区标题存在，
  控件名契约（上面五个 label）一字未动。

合并顺序：本分支已包含 #102，直接合入即可，无需再单独排序。

## 5. 验证

- `node --test tests/model-settings-discovery.test.mjs`：7/7 通过（能力发现、保存载荷、
  thinking 参数、至少一个启用、未保存 Key 读取目录）。
- `node --test tests/onboarding-ui-verification.test.mjs`：2/2 通过（#102 的控件名契约与
  验收脚本断言）。
- 视觉验证：真实 DSH Web + 真实 Studio 插件（临时 `DSH_HOME` profile），
  打开「凭证引导 → 连接你的模型」，组件在真实 token/字体下渲染正常；
  完整设置弹窗（DSH 宿主所有）在 Web profile 下无法自动打开，故整页对比图由
  本地 harness 渲染**同一份组件源码**（Mock Host 数据 + DSH token 常量）截取。
- 截图：`compare-full.png`、`compare-dialog.png`、`compare-onboarding.png`。
