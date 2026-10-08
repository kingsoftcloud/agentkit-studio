# 无工作区会话验收（2026-10-08）

## 行为

- 侧栏“未分组”的加号创建无工作区的原生会话，保留此前会话的草稿。
- 首轮发送前，工作区名称左侧的圆形叉号取消目录。沿用 DSH 的会话导航与草稿迁移，输入文字及附件移动到无工作区的新会话；不删除工作区或已有历史。
- 普通“新会话”的默认工作区策略保持原样；显式 `null` 才表示无工作区，避免把取消操作当作“未指定”。
- 删除 Studio 原先重复的“新建无工作区会话”文字按钮。
- 异步创建失败时保留原会话与草稿；切换到另一会话或关闭客户端后，晚到的创建结果不能抢占当前页面。

## 可复核证据

以固定 DSH `0.2.0-rc.2` 加 Studio 补丁 001–017，在本机独立验收 Profile 的真实 Web Host 上完成：

| 场景 | 结果 |
| --- | --- |
| 工作区空白会话留下未发送草稿，再点击“未分组”加号 | 新会话进入未分组；回到原工作区时草稿仍在 |
| 未分组会话不选目录，询问 `2+3` | GLM 5.3 Flash 返回 `5`，刷新后保留消息及分组 |
| 工作区会话输入 `3+4` 问题，再点取消叉号 | 未分组新会话保留原输入，当前模型仍为 GLM 5.3 Flash |
| 取消目录后直接发送 | 返回 `7`，会话留在未分组 |

本轮浏览器对话使用未绑定 Agent 的 DSH 原生会话；这份记录不扩展为三种 Agent 运行时、云端资源或部署的完整验收。

忽略目录中的本机证据：

- `.artifacts/e2e-workspace-close-before-20261008.png`
- `.artifacts/e2e-workspace-cleared-draft-20261008.png`
- `.artifacts/e2e-workspace-cleared-chat-20261008.png`
- `.artifacts/ungrouped-release-check.log`

## 自动检查

- 工作区侧栏、导航服务、会话正文与草稿迁移四个测试文件：214 项通过。
- DSH Client TypeScript 与 Web 构建通过；文档同步 43 项通过。
- Studio `make release-check`：387 项测试及 npm 包完整性通过。
- 17 个版本化补丁可在固定基线上按顺序应用，未改写工作 checkout 的 Git index。

## Agent 绑定补测与选择器范围（同日追加）

补丁 018 将当前空白会话的 preset、会话模型及命名访问模式传入新无工作区会话。
通过 DSH 公开接口恢复成功后才迁移草稿；失败或导航被替代时原草稿保持原位。
自定义访问规则不能降级为默认权限：需先选择命名访问模式，再取消目录。

真实浏览器复核：绑定 DSH Native 盲测 Agent，输入普通成都两日行程问题，再点取消工作区。
页面保留 Agent、GLM 5.3 Flash、仅可查看及完整草稿。发送后回复包含仅存在于 Agent
系统提示词的 `route_tag: RIVER-29`；用户消息没有角色提示或该标记。刷新后保留记录与绑定。

选择器复用 DSH `Menu`、`MenuItemButton`、`Input`，提供搜索、键盘导航、Esc 关闭和有界滚动。
在真实目录搜索 `openclaw` 得到无匹配；搜索盲测 Agent 后用方向键和回车可完成绑定。
目录层在分页、计数和排序之前排除不支持的本地运行时，并停止合并历史云端列表，包括旧 Codex。
当前本地 Build 尚无云端部署合同，因此云端标签明确为空；未来只能接入能证明来自
Studio 本地 Agent 的真实部署记录，不能用运行时名称或历史 ListAgents 替代来源证明。
这是目录收敛与原生会话验收，不是云端部署已完成的声明。

补测证据位于忽略目录：`e2e-agent-menu-20261008.png`、
`e2e-agent-preserved-without-workspace-20261008.png`、`e2e-agent-blind-reply-20261008.png`。
本轮新增的目录分页及持久化 preset 身份测试通过；宿主五个会话/导航文件 256 项通过，
追加导航竞态与权限失败测试后导航文件 70 项通过，宿主依赖装配两个文件 17 项通过。
DSH Client/Web 构建及文档同步 43 项通过，18 个补丁顺序检查通过。

三种本地运行时均已完成相同的真实会话补测：DSH Native 返回 `RIVER-29`，
AgentKit Harness 返回 `PINE-73`，Codex 返回 `MAPLE-61`。标记来自各自已有的
系统提示词，三条用户消息只有城市、预算和行程要求。Codex 的独立模型
`deepseek-v4.1-flash` 在取消目录前后保持一致，未被普通会话默认模型覆盖。
浏览器同时确认本地列表为 14 个 Agent，云端标签显示“暂无 Studio 云端部署”。

对应本机证据：`.artifacts/e2e-harness-workspace-free-20261008.png`、
`.artifacts/e2e-codex-workspace-free-20261008.png`、`.artifacts/e2e-agent-picker-final-20261008.png`。
Studio release-check 的 387 项测试及 228 文件 npm 包完整性检查通过。

## 更新后的 macOS 产物

本地 arm64 未签名 DMG 已生成：`AgentKit-Studio-0.0.1-mac-arm64-local.dmg`，
502,331,809 字节，SHA-256 `60d7ac2f49d42b0db636d5ba0ed7dedbb4a5d9dd5148d6b749a3540d19cc1760`。
首次镜像封装遇到 ENOSPC；清理本轮重复中间产物后，用官方 electron-builder 的
`--prepackaged` 从同一已构建 App 重做 DMG，未跳过或替换应用内容。

已只读挂载最终 DMG，核对包内 Studio client/catalog 与当前源码 SHA-256 一致，
宿主包含配置继承补丁，应用名称与图标正确。官方离线运行时自检通过 Node、PTY、
Office 文档转换和 Skill CLI。此处为构建、运行时自检及镜像内容检查；三种 Agent 的
交互证明来自上述真实 Web Host，本次没有重新安装该 DMG 做完整桌面交互回归，
也不代表签名、公证或云端部署验收。
