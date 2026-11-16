# 架构图制作手册（Archify → 文档站）

> 本仓所有插图都用 Archify 生成，**每种语言一份**：中文页用 `x.png`，英文页用 `x.en.png`，各自带 `.dark.png` 深色版。
> 已跑通的样板：`.archify/arch-overview-zh/` 与 `.archify/arch-overview-en/`。

## 目录约定

```
.archify/<type>-<slug>-<lang>/
├─ candidate.json      # Archify 候选（唯一手写文件）
└─ overview.html      # finalize 产物（已过 validate/deliver/check/browser-check）
docs-site/public/assets/
├─ agentkit-<slug>.png         # 中文浅色
├─ agentkit-<slug>.dark.png    # 中文深色
├─ agentkit-<slug>.en.png      # 英文浅色
└─ agentkit-<slug>.en.dark.png # 英文深色
```

## 三步产出

### 1. 写候选

读 `docs-site/AUTHORING.md` §6 术语表，把图内文案**本地化**（中文页全中文，英文页全英文；枚举值/代码名不翻译）。

```bash
node .agents/skills/archify/bin/archify.mjs finalize <type> \
  .archify/<type>-<slug>-<lang>/candidate.json \
  .archify/<type>-<slug>-<lang>/overview.html \
  --quality showcase --json
```

- `status: "pass"` 才算过；`fail` 时读 `diagnostics` + `visualReviewRecommendation.hints` 改**坐标与尺寸**，别改语义。
- **同一输出路径第二次跑必须加 `--out-dir .archify/<...>/review-2`**，否则报 `viewer/evidence-path-conflict`。

### 2. 出图

```bash
node /tmp/archify-png.mjs .archify/<type>-<slug>-<lang>/overview.html \
  docs-site/public/assets/agentkit-<slug>[.en]
```

脚本会按 `light` / `dark` 两个 context 各截一张 `svg[data-node-ui]`（3x），输出 `.png` 与 `.dark.png`。

> `/tmp/archify-png.mjs` 是 Lead 写的通用脚本，内容与仓库一致；若不存在，从 `.archify/arch-overview-zh` 的流程复刻。

### 3. 接入页面

```mdx
<Diagram src="/assets/agentkit-<slug>.png" alt="一句中文替代文本" />
```

英文页 `src` 换成 `.en.png`。`<Diagram>` 会自动推导 `.dark.png`。

## 硬性要求

| 项 | 要求 |
| --- | --- |
| 中文页文案 | **不得出现英文句子**；枚举值、代码名、产品名保留原文 |
| 英文页文案 | 全英文，句首大写 |
| 布局 | 中文与英文两张图的**节点顺序、边关系必须一致**，只有文案和必要的宽度不同 |
| 可读性 | 英文长句容易触发 `composition/desktop-readability`，把 viewBox 宽度压到 ≤ 1023px（列距 156 / 节点宽 140 起步） |
| 图例 | 保留 Archify 自动图例（前端/后端/数据库/云服务/外部系统） |

## 自检

```bash
cd docs-site && NEXT_PUBLIC_BASE_PATH=/agentkit-studio pnpm build:static
node --test tests/docs-site-i18n.test.mjs   # 12 项必须全绿
```

再用 playwright 在 `light` / `dark` 两个 `colorScheme` 下截图确认文字不溢出、连线不交叉。
