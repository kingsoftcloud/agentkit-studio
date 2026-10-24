# Legacy 长期记忆工具的 Node 接入

参考是 `ksadk-python` 的 `feat-ksadk-harness-2`，提交
`355059d78e47ed764bbdb3606304cdf34e9838a3`：`memory/tool.py`、`service.py`、
`ltm_backend_factory.py` 及三个实际后端。HTTP 后端虽然保留 TODO 注释，已经实际执行
POST；迁移依据是这些代码行为。本文记录一个已接入的能力，不表示整体迁移完成。

`load_memory(query)` 和 `save_memory(content)` 已接到 Studio 原 builtin 入口。
它们与 Native 的 `read_memory` / `search_memory` / `manage_memory` 及自动 profile
提取是不同能力，不能用已有上下文注入代替。核心包不引用 DSH Session；本次服务和
适配器位于 Node 宿主层。缺少 Node 端口会明确失败，不进入 Python fallback。

## 配置和分区

| 配置 | 行为 |
| --- | --- |
| Agent 启用的 `memory-instance` 绑定 | 使用 SDK 后端；沿用 Studio 现有 `memory-partition/v1` 用户分区及 Session 哈希，与资源上下文注入指向同一分区 |
| `KSADK_LTM_BACKEND=local`，也是未绑定资源时的默认值 | 持久 SQLite；默认在 Host 私有 `studio/legacy-memory/local/local.sqlite` 中，保留旧 local 按用户共享、ASCII AND / CJK bigram OR、4000 token 装箱和内容去重 |
| `KSADK_MEMORY_DB_PATH` | 自定义新 SQLite 路径；父目录及数据库必须属于当前用户并保持私有权限；拒绝符号链接和工作区内数据库；不导入旧 Python 数据表 |
| `KSADK_MEMORY_DB_PATH=:memory:` | 显式临时 SQLite；进程或服务重建后事实消失，历史调用回执不证明当前事实仍存在 |
| `KSADK_LTM_FORCE_INMEMORY=1/true` | 参考实现的显式内存后端；保留原始 event 字符串及子串计分，服务重建后不保留事实 |
| `KSADK_LTM_BACKEND=http` | `KSADK_LTM_HTTP_URL` 基础路径下 POST `memories` / `memories/search`；可选 `KSADK_LTM_HTTP_TOKEN`；保留 index、user_id、events、metadata、session_id、flush；保留 `X-Traffic-Source` 配置 |
| `KSADK_LTM_BACKEND=sdk` | `CreateMemorySdk` / `QueryMemorySdk`；`KSADK_LTM_NAMESPACE` 或 index 指定集合，未绑定资源时保留原用户和 Session 标识 |
| `KSADK_LTM_INDEX`、`KSADK_LTM_APP_NAME`、`KSADK_LTM_TOP_K` | index 默认 `default_app`，top-k 默认 5；SDK scene 默认 `_sys_general`，可设 `KSADK_LTM_SCENE_ID` |

SDK 使用 Node 已有签名传输，启动时捕获 Studio 配置及 `KSADK_LTM_*` / `KSYUN_*`
凭据覆盖。密钥和 token 不进入 preset、执行意图、回执或模型结果；公共 binding
只含版本、公开集合 ID、设置和连接摘要。Native capability/plugin-lock 绑定这些设置，
同一 Run 不能通过编辑集合、后端、分区方式或连接来改变行为。

DSH Native/Codex 从真实模型请求选项绑定用户到实际 Agent/Session 对象；工具参数
不能选择用户。原调用持有该对象的身份，用户或 Session 改变后旧调用失去权限。
Native 使用原 kernel ToolRequest 的 scope、Run、Session、operationKey 和执行 fence；
没有为 DSH 制造 Native Run 或 lease。

## 写入和恢复

独立的 `agentkit.legacy-memory-effects/v1` SQLite 意图表使用同步 FULL 事务。
调用身份只定位原调用，完整请求、当前 Agent revision/Build、定义和 binding 用于冲突
检查。外部派发之前，先提交完整写入 DTO；SDK 的 MessageId、CreatedAt 及传输 requestId
也在此时生成并保存。凭据由捕获的传输闭包保管，不能从历史记录重建凭据。

完成的重复调用只恢复原回执。发现 pending 意图，或取消、断连、Host 退出后结果未知，
返回 `outcome_unknown`，不会自动重发。不同进程并发进入同一身份也不能重复派发。
本地事实和本地写回执在同一事务内提交；外层调用回执另行提交，之间中断时保守报告未知。
终止、权限丢失或存储失败后不发布成功，也不承诺跨外部系统 exactly-once。

SDK 写请求被受理之后，以内容执行 top-k=1 查询。可检索才返回 `persisted`；未抽取
返回 `accepted_not_extracted`，并尝试原 Session 的 `ListSessions` 状态查询。该查询
保留 20 页、每页 20 条的边界、目录一致性和身份检查。后续查询失败不会伪装为空结果。
HTTP 保留旧协议：完整接收 2xx 响应才确认成功，不假定响应体有额外业务确认字段。

未知结果仍需要产品级显式核对/继续流程，本次没有把自动重试当作恢复界面。

## 验证范围和差异

定向验证覆盖实际 HTTP、大段 Unicode、签名 SDK 传输、完整 DTO 提前持久化、SQLite
重开、自定义数据库、两种显式临时模式、用户隔离、真实子进程 SIGKILL、并发进程、
冷恢复不重发、非合作式后端取消/Host 退役、真实 Native kernel 意图/fence、DSH
真实身份及审批、既有图像/Frozen 路由兼容。没有运行全量测试。

打包 Host 验证使用实际安装的 DSH graph、认证 preset、SessionController 和 ToolRegistry，
覆盖 DSH Native/Codex 的 HTTP 记忆调用、重复回执、pre/post 策略及原 Host 退出后的新
PID 恢复。此 fixture 不请求模型，显式设置可信调用上下文；实际模型适配器的自动绑定
另有定向测试。固定依赖 graph、Node/bash PATH 和无效 Python 配置，不等于全新安装。

明确差异和未验收项：

- Node 错误使用版本化结果；坏响应/未确认写入不会被当作成功的空记忆。Python local
  flush 对敏感内容可拒绝保存但仍返回 true；Node 保留拒绝并明确报告失败。
- HTTP search 当前要求 `memories` 是字符串数组；Python 对任意项执行 `str()`。
  SDK/formatter 对部分坏字段更严格；嵌套结构使用 JSON 表示，空白及数字类型的语言
  表示并不保证与 Python 字节相同。正常字符串事实的内容和顺序保留。
- SDK 支持当前 Studio 的 `Data.Memories` 包装，除参考 Python 的三种已知包装外，
  未知包装明确失败；SDK 的受理还要求请求回执。多个绑定集合是 Studio 的扩展。
- 原 registry pre/around/post 策略保留。`save_memory` 在只读 workspace policy 下仍需
  当前 Host 的一次审批，不借用 Native 独立 Memory 工具的专用 consent 绕过它。
- 自定义 HTTP URL 不接受内嵌凭据、query 或 fragment；改用专用 token 配置。自定义
  SQLite 要求私有目录。旧数据不需兼容，但这些配置约束仍须计入最终能力差异审计。
- 本地 token 装箱采用参考默认 heuristic；显式 tiktoken/provider 配置尚未对照验收。
  SDK 的端点自动探测、网络模式选择和自定义签名端点已与知识库共用 Node 连接层，
  见 [AICP 资源连接](native-aicp-connections.md)。这不证明实际云网络可达。
- 真实云 Memory 服务、完整模型/Codex CLI、自动化/定时/Frozen HTTP/部署组合、全新
  纯 Node 安装及默认切换未由这些测试证明，仍属于完整迁移目标。
