# 知识库与长期记忆的 AICP 连接

参考版本：`ksadk-python` `355059d78e47ed764bbdb3606304cdf34e9838a3` 的
`common/aicp_env.py`、`common/cloud_headers.py`、`knowledge_base/client.py`、
`memory/service.py` 和 `memory/adk/backends/sdk_ltm_backend.py`。Node 实现在
`src/aicp-resource-connection.mjs`，Native、DSH Native 与 Codex 共用；无需 Python。

## 选择和冻结

以下配置中的前缀为 `KSADK_KB` 或 `KSADK_LTM`。

| 输入 | 选择规则 |
| --- | --- |
| `<prefix>_ENDPOINT` | 最高优先级，接受 SDK 主机名、主机名加端口或 HTTP(S) origin |
| `<prefix>_SCHEME` | 显式 `http` 或 `https`，优先于默认值；无显式值时，普通 internal/inner 主机使用 HTTP，其余 HTTPS |
| `KSADK_AICP_ENDPOINT_MODE=public` | `aicp.api.ksyun.com`，默认 HTTPS |
| `...=internal` | `aicp.internal.api.ksyun.com`，默认 HTTP |
| `...=inner` | `aicp.inner.api.ksyun.com`，默认 HTTP |
| `...=auto` 或 `detect` | 依次探测 internal、inner、public，使用第一个 TCP 可达地址；均不可达则用 public |
| 其他非空 mode | 沿用参考行为，选 public，不探测 |
| 未配置 SDK 路由且已有 Studio 服务地址 | 沿用该服务连接，包括本地 Host 会话认证；不探测或改成 SDK 签名路由 |
| 两者均无 | 沿用 Python 默认自动探测 |

每个候选探测限时一秒，仅连接 TCP/80，不发送 HTTP、密钥或 token；这也保留参考
实现对 public 的探测端口，最终 public 请求仍用 HTTPS。探测结束销毁连接。自动探测
证明网络连接可达，不证明身份、API 版本或服务健康；请求失败不轮流重发到其他地址。

区域优先 `<prefix>_REGION`、`KSYUN_REGION`、Studio 配置，最终默认 `cn-beijing-6`。
凭据保留对应前缀与 `KSYUN_*` 的优先级；KB 另外保留 `KSYUN_SECRET_ID` 别名。
Studio 原有 `pre-online` 到真实签名区域及 custom source 的映射保留。
`KSADK_TRAFFIC_SOURCE` 在签名前形成 `X-Traffic-Source`，默认 `agentkit`，控制字符在
去空白前拒绝。SDK 请求超时为参考的 60 秒，仍受调用取消及外层工具截止时间约束。

环境输入在异步解析和探测前捕获，配置值在解析后立即复制；稍后的环境或设置修改
不改变已接纳连接。选定地址、来源头和连接材料进入私有连接摘要，再进入 Native
能力/插件锁及独立 DSH 原调用绑定。重启选到不同地址或配置时，不能接管旧调用或
重发未知写入。密钥和 token 不进入公开 binding、模型结果或执行意图。

## SDK 地址的权限边界

自定义 SDK 地址是可信 Host 配置，不是模型工具参数。专用资源客户端仅开放
`RetrieveKnowledge`、`CreateMemorySdk`、`QueryMemorySdk`、`ListSessions`；使用
`/?Action=...&Version=...`、完整公共 SDK 字段和 AWS4 签名。普通 Studio 服务地址
不会因此取得云端签名权限。显式 SDK 地址不执行 public→inner 自动回退，不跟随
重定向，也不自动重试写入；保留已有意图、未知结果及人工核对语义。

拒绝 URL 内嵌凭据、路径、query 和 fragment；用专用凭据变量配置认证。这是明确
的 Node 配置边界。显式 URL 自带 scheme 时保留它，除非 `_SCHEME` 覆盖；普通 SDK
host[:port] 使用上表规则。Python 历史序列化格式不需兼容。

## 实际验证及仍未完成的范围

`tests/aicp-resource-connection.test.mjs` 覆盖两个前缀的参考选择矩阵、捕获期间的配置
变化、来源头、签名、受限 Action、坏配置、真实本地 TCP 和实际 HTTP 记忆写入/
SQLite 重开。模式矩阵的网络可达性是明确的受控探测结果。`native-dsh-tools` 测试
通过真实 Kernel/SQLite、完整工具意图和执行 fence 发出实际签名 HTTP；模型及
测试 Agent/registry 是明确替身，保留 post policy 检查。

`verify-studio-node-builtins.mjs --memory-backend sdk` 使用实际打包 Host、维护版
DSH SDK、preset、SessionController 和 ToolRegistry，验证 DSH Native/Codex 的
KB 请求及 SDK Memory 写入、可见性查询、加载、拒绝和 post policy；恢复新 PID 后
原记录不变且零服务重发。此验证覆盖受控 HTTP 服务、Node/bash PATH 和无效 Python
路径，依赖图来自维护版 SDK。普通 `--memory-backend http` 保留 HTTP Memory 验证。

这些证据不等于真实云服务、所有网络拓扑、全新依赖安装、真实模型/Codex CLI、
全部自动化/Frozen/部署入口或完整迁移已经验收。Skill Service 有独立协议与配置，
此共享连接层没有替换其 REST/GET 实现。其他配置、资源 authority 及生命周期缺口
仍须按完整能力清单核对。
