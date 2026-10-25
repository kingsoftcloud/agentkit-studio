# Native 的真实 Studio 界面接入

已通过正常浏览器登录和 AgentKit Harness 产品入口执行：普通对话、允许一次、拒绝
写入、历史重开、生成中刷新、取消、取消后的继续对话，以及原运行恢复入口的收尾。
模型使用本地确定性 HTTP；Session、工具、审批、Web 客户端和 Native 执行均为实际实现。
这不等于远端 A2A 问答、所有子任务控制或完整 Electron 已完成界面验收。

## 本轮修正

1. `nativeLiveStream` 原来给一个请求的所有帧复用同一 `revision`，DSH 的 Session
   follower 要求每帧递增，因此最终结果可见，生成中的文字却被连续性校验丢弃。
   现在 start、chunk、end 都分配同一 Agent 生命周期内的下一个 revision；attemptId
   和 attempt 内的 chunk index 不变。刷新后的真实 follower 也能恢复活动前缀。
2. Native 已持久化取消结果后，Runtime Bridge 再次检查调用者的取消信号，将返回的
   aborted ending 改成异常。DSH 因而保留外部回合所有权，界面误报可恢复。现在只在
   调用者取消、Native 明确返回 aborted ending，且 Host/注册仍有效时保留该结束回执。
   Host 退出或注册撤销仍拒绝迟到结果；不提前返回，也不接受取消后的普通成功结果。

## 重现环境

使用已构建的维护版 DSH 和已有完整 Host 依赖目录，准备器不安装包，不使用个人
profile，也不修改 DSH 源码。先按[无 Python 安装说明](native-node-installation.md)
准备宿主；本流程不作为全新安装证明。

```sh
node scripts/prepare-studio-native-web-session.mjs \
  --source /absolute/built-maintained-dsh \
  --dependencies /absolute/existing-host/node_modules \
  --output /absolute/new-proof-directory
```

输出目录的父目录应已存在，目标目录应不存在。看到 `WEB_READY` 后，使用输出目录
`connection.json` 的 URL 打开浏览器。它使用正常 token/cookie 认证；仅在 localhost
运行，连接文件权限为 0600。不要公开其中的登录 token。

准备器创建独立 Agent、临时工作区、Node-only PATH、实际持久 Session 和 SQLite
RunStore。Documents 路径显式指向临时目录，避免隔离 PATH 调用 macOS 文件夹选择器。
额外的测试策略只对 `write_workspace_file` 请求真实 DSH 审批，仍执行原工具及后续
权限检查；没有自动批准，也没有关闭鉴权。源码构建的 profile 不运行 typert 文件
发现器，采用已构建 Web bundle 的实际服务注册。

通过会话的 Agent 选择器选择“Native 浏览器验收”，依次发送以下消息：

| 消息 | 手动操作与应观察结果 |
| --- | --- |
| `NATIVE_BROWSER_CHAT` | 显示 `BROWSER_CHAT_DONE` 和已完成状态 |
| `NATIVE_BROWSER_APPROVAL` | 先选“工作区内修改”；等待审批时 `approved.txt` 不存在；允许一次后才写入 `BROWSER_APPROVAL_EFFECT` |
| `NATIVE_BROWSER_REJECT` | 点击拒绝；工具返回拒绝，`rejected.txt` 不生成 |
| `NATIVE_BROWSER_CANCEL` | 模型保持流打开；先看到 `BROWSER_CANCEL_PREFIX`，刷新仍保留前缀，再点击停止生成；界面显示已停止，恢复区不再提示可恢复 |

恢复环境时，先停止准备器或其 `setup.json` 中记录的 Host PID，再用相同参数添加
`--resume`。准备器保留原目录、Agent、模型和 Web 端口；它不会主动发送消息、审批
或恢复请求。通过界面重开原会话，检查原运行和模型请求记录。`NATIVE_BROWSER_RECOVER`
同样提供未结束流，供明确的进程故障验收使用，本记录不声称已执行其全部组合。

## 实际证据

- `.artifacts/native-migration/browser-acceptance-20261025-final/approval-evidence.json`：
  审批前文件不存在，真实按钮产生 `allowed-once` / `rejected`；实际写入与拒绝结果
  已核对。该阶段还验证了普通对话和 Host 重启后的原会话历史。
- `.artifacts/native-migration/browser-session-continuity-20261025/`：修正后的流式帧
  在生成中可见，页面刷新不增加请求；实际取消后数据库为 canceled。修复前遗留的
  原回合经恢复入口关闭，不重发请求；新取消回合自动关闭，随后能在原会话继续对话。
  `execution-evidence.json` 固定实际模块摘要、Run、模型请求和持久 `turn/end`；
  PNG 和 AX 记录保留界面证据。
- `native-dsh-turn-runtime.test.mjs` 的受影响流式路径 8 项通过，覆盖内存/SQLite、
  完成前发布、精确持久流、重试、取消、迟到回调和 flush 失败。
- `runtime-bridge.test.mjs` 的取消/退休路径 6 项通过，覆盖等待 worker 收尾、返回
  已确认取消、拒绝迟到成功及 Host/注册撤销。没有重跑全仓、安装或打包。

实际定向命令为：

```sh
node --test --test-name-pattern 'public frames|failed streamed tool|cancel closes|failed durable flush' tests/native-dsh-turn-runtime.test.mjs
node --test --test-name-pattern 'Native.*(cancel|retirement)|retiring old Native' tests/runtime-bridge.test.mjs
```

另一次新增断言复查，最初只允许调用者取消作为拒绝原因；实际 Host 退出也可以
提供拒绝原因，2 项中 1 项因此失败。断言改为明确接受原调用者取消或对应的 Host/
注册撤销错误，仍拒绝返回迟到 ending；仅这 2 项复查通过。原失败及复查日志分别为
`cancel-retirement-identity.log` 和 `cancel-retirement-fencing.log`，未改生产逻辑来适配测试。

这些证据只支持所列路径。完整差异和仍未验收项见[能力对照](native-capability-status.md)。
