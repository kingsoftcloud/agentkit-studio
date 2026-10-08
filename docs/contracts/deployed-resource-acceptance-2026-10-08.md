# 共享镜像真实资源验收（2026-10-08）

本记录补充此前的 Container 首次连通与私有运行包记录。使用共享镜像
`studio-runtime:0.0.1-a27bc5d`、DSH `0.2.0-rc.2`、Codex `0.159.2`，模型为冻结配置中的
GLM-5.3-Flash。三个运行时均通过原有 `CreateAgentProduct` 的 Container 模式创建，
从私有 KS3 下载各自的冻结包。未更改 Server 或 Runtime Service，也未设置全局默认镜像。

## 实际结果

| 运行时 / 场景 | 证据 | 结论 |
| --- | --- | --- |
| Harness 普通问候 | 私有包冷下载；7 个文本帧；用量 758/131/889；系统提示词盲测 | 通过；详见私有运行包记录 |
| DSH Native 普通问候 | 12 个文本帧；用量 8718/80/8798；系统提示词盲测 | 通过 |
| DSH Native 联网 MCP | 两次 `metaso_web_search`、两次 `metaso_web_reader`，均有对应成功结果；151 个文本帧 | 通过 |
| DSH Native Skill | 实际 `skill` / `bash` 调用，参数包含 `scripts/json_structure_checker.py`，结果包含 `节点数：7`；93 个文本帧 | 通过 |
| Codex 普通问候 | 4 个文本帧；用量 13760/44/13804；系统提示词盲测 | 通过 |
| Codex 联网 MCP | 诊断实例完成两次 `metaso_web_search`、一次 `metaso_web_reader`，三个对应结果均成功；60 个文本帧 | 工具实际执行已证实；该轮开头未满足系统指定前缀，严格整轮用例仍未通过 |
| Codex Skill / 原生命令 | 模型发起 `exec_command`，实际工具输出为 Bubblewrap 权限错误，未执行脚本 | 未通过 |
| 独立知识库归因 | 全资源运行包同时含记忆、MCP 和 Skill，答案不能单独证明知识库召回 | 未验收；需要仅绑定知识库的运行包 |
| 持久卷 | DSH Native 创建请求带 20 GiB Storage，详情未保留 Storage | 未通过；尚未验收重建后的会话恢复 |

原始 HTTPS 事件、创建/更新/删除回执、固定 Agent/Build 身份和完整日志仅保存在受保护的
验收目录。这里不保存真实凭证、资源 ID、终端用户内容或内部部署地址。资源绑定成功不能
由模型声称“已调用”或回答数值正确来替代；Skill 验收同时要求实际脚本参数与匹配的成功结果。

## 运行中心部署页面验收

使用独立 DSH Web Host、隔离数据目录和真实 Chrome 验证新版页面；控制面 KOP、私有 KS3
及云端模型均为真实调用。未替换日常开发 Host，也未修改共享 DSH checkout。

| 场景 | 结果 |
| --- | --- |
| Node 编排创建 Harness | 私有上传、Container 创建、访问配置、鉴权探测、真实流式回复通过；8 个文本帧，用量 758/83/841 |
| 页面确认创建与故障修复 | 点击检查及确认后创建；发现初始令牌同步早于实例就绪的时序问题；页面修复配置后回复通过，15 个文本帧，用量 758/169/927 |
| 修正后的页面完整创建 | 新实例自动从上传、创建、初始化、访问配置到 `READY`；未使用手动修复；7 个文本帧，用量 758/122/880 |
| 日志与错误状态 | 页面展示真实启动日志；启动 URL token 脱敏；网关健康不能覆盖运行时 401；控制面 `UPDATING` 与入口可用分别展示 |
| 删除及清理 | 三台独立测试实例均通过页面删除，随后 GetAgent 404；三个专属私有运行包经摘要核验后清理，下载均返回 404 |

上述问候输入只包含普通问候，期望前缀仅写在冻结系统提示词中；验收同时核对返回的
Agent/Build 身份、流式文本及用量。Chrome 控制台无错误或警告。

467 项自动化测试通过，包含三种运行时的编排合同、响应丢失后不重复创建、完整查询及
冻结来源核对、实例就绪后令牌同步、单次访问修复、删除并发、密钥不落部署记录等回归。
打包与补丁格式检查通过。**三种运行时的本地合同测试不等于三种云端页面场景全部验收。**
本节最初的真实页面创建使用 Harness 和主账号；后续子账号与原生会话证据见下一节。
权限隔离、完整资源组合、持久化、升级回滚仍未通过，不据此宣称完整生命周期完成。

## 子账号创建与云端原生会话

更换为用户配置的子账号 AK/SK 后，用同一套共享镜像和仅绑定模型的冻结 Harness 包验证。
所有创建、读取与删除均经签名 KOP 请求完成；没有直连 Server，也没有复用此前主账号凭证。

| 场景 | 真实结果 |
| --- | --- |
| 子账号识别 | 默认 IAM 密钥列表未包含当前 AK；通过精确匹配用户名、用户密钥 Active 状态及用户详情完成核验 |
| 创建者回传 | 新建 Agent 的 `GetAgent.Basic.Creator` 与已核验 IAM 用户名一致；不再为空 |
| 云端目录与选择器 | 仅展示当前凭证对应的 Studio 部署；菜单显示“云端”，进入会话前完成绑定 |
| 原生会话首轮 | 未选择工作区，发送普通问候；回复符合只写在冻结系统提示词中的前缀，用量 860 tokens |
| 连续对话 | 第二轮告知验收暗号，用量 896 tokens；重启桌面测试 Host 后，第三轮未提供暗号也正确回答，用量 953 tokens |
| 展示与恢复 | 三轮均显示 Agent 名称及冻结模型；历史恢复，原生思考条目可展开，累计用量 2.7K tokens |
| 页面删除 | 运行中心确认删除后状态为已删除，控制面详情返回 404；专属私有运行包校验摘要后清理，下载返回 404 |
| 删除后的历史 | 再次重启 Host，旧会话仍展示三轮内容和原 Agent；继续发送被拒绝，没有回退到本地模型执行 |

以上证明桌面 Host 恢复后的云端连续对话，不代表云端容器重建后的持久化。当时尚未读取数据库
`creator_sub_account_id`，后续核验见本文“子账号落库补验”；跨子账号隔离仍未验证。三种运行时的流转换、冻结模型、
资源不在本机重复执行、身份拒绝和取消有合同测试，本节真实原生页面仅验证 Harness；
不将这些测试表述为三种运行时全部资源场景均通过。

本轮同时修正构建页与本地自动化的 Agent 范围，避免将云端实例当作本地构建/调度目标。
验收使用隔离的 DSH Host 和数据目录，未重启日常开发 Host；私有证据与截图不进入公开包。
本轮 `make release-check` 通过：477 项测试、补丁格式和 282 文件的包完整性检查全部通过；
已暂存的新模块也纳入可分发路径检查。

## Codex 最小复现与诊断

普通用户输入要求执行 `python3 -c "print(7)"`。真实 Responses 请求返回 HTTP 200，但
没有命令调用卡片；不能据此判断命令成功。隔离诊断镜像只记录协议类型和状态，证实：

1. Studio 的 Session 和工具记录器存在。
2. 协议代理恢复了 `exec_command`；后续模型请求中包含实际失败的工具输出。
3. 失败内容为 `bwrap: Failed to make / slave: Permission denied`。Codex 没有为这次启动
   失败发送 `commandExecution` 的 `item/started` / `item/completed`，因此仅转换这些事件
   不能覆盖启动失败的工具轨迹。
4. 在同一云端容器中，无模型的只读命令探针也失败。启用 `use_legacy_landlock` 后，固定
   Codex 版本直接拒绝：`filesystem-restricted execution requires bubblewrap to isolate app-server sockets`。
   该开关不是可用修复。尚未得到写入、网络限制均通过的 Codex 替代后端。

没有以关闭沙箱、特权容器或扩大工具权限替代验收。后续需让部署环境支持所需隔离能力，
或完成并验收受支持的执行器适配，同时补齐早期失败的工具轨迹。官方事件合同见
[Codex App Server](https://learn.chatgpt.com/docs/app-server)，容器要求见
[Codex Sandbox](https://learn.chatgpt.com/docs/sandboxing)。诊断修改不进入正式源码或共享镜像。

## 创建、更新与存储边界

- 一次创建遇到控制面 503，先按本次唯一名称核对没有创建成功，再人工发起重试；没有
  自动重试未知创建结果。
- `UpdateAgent` 接受镜像更新后，旧实例仍可能短暂接收请求。验收须核对替换实例已运行，
  再通过实际版本证据确认新镜像接管，不能只检查更新接口成功。
- 当前 Server 的创建计费/存储策略会移除普通 Harness/Codex Container 的 `Storage`。
  Runtime Service 本身已有存储支持；这属于需单独处理的控制面策略缺口，不是 Node 入口缺失。
- 预发 HTTPS 仍需显式配置经过认证来源核对的 CA。本次保持 TLS 校验，未修改系统信任库。
- 测试 Agent 使用限定 ID 的软删除清理，不联动删除共享 KS3、镜像或日志；独立账单核销
  不在运行资源删除回执的证明范围内。

## 可复用远端探针

在已部署 Agent 上运行，不创建、更新或删除云端实例：

```sh
node scripts/verify-deployed-bundle.mjs --execute \
  --archive /absolute/path/to/portable.zip \
  --endpoint https://your-agent.example.com/ \
  --token-file /absolute/path/to/private-runtime-token \
  --cases /absolute/path/to/cases.json \
  --output /absolute/path/to/new-private-evidence-directory
```

令牌文件必须是仅当前用户可读写的普通文件；输出目录不能已存在。输出事件可能含资源内容，
按私有文件保存，不提交。测试 CA 使用进程级 `NODE_EXTRA_CA_CERTS`，不要关闭 TLS 验证。

示例用例（将工具名、脚本和预期结果改为实际绑定的验收资源）：

```json
[
  {
    "id": "bound-script",
    "input": "请用已绑定的结构检查能力检查这段 JSON：{\"name\":\"Ada\"}。",
    "expectedTools": ["bash|command"],
    "expectedToolArguments": "scripts/check.py",
    "expectedToolResult": "节点数：2"
  }
]
```

探针校验匿名请求被拒绝、冻结 Agent/Build 身份、匹配的工具调用和成功结果、文本增量及
非零用量。`expectedStreamPrefix` 用于系统提示词盲测，不能把前缀写进用户输入。
`isolatedKnowledge` 要求运行包只绑定远端知识库且没有 MCP、Skill 或记忆，并拒绝外部工具
调用。该探针不支持重启、延时召回或跨请求续聊用例；这些需要独立生命周期验收。


## 子账号落库补验

对上节已删除的隔离测试 Agent，使用只读数据库事务按唯一 Agent ID 查询。
`creator` 与 IAM 用户名一致，`creator_sub_account_id` 与 IAM 已核验的用户 UUID 一致，
`is_private=true`，资源状态为 Deleted。该记录证明子账号身份已透传并落库；不等于已验证
另一子账号无权访问，跨子账号权限测试仍待执行。原始对照结果仅保存在私有验收目录。
