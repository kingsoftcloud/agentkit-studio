# 托管运行时的资源主体

三个 `agentengine.dsh-manifest/v1` profile 共用 `managed-resource-identity.mjs`。
它是后续云资源消费的身份入口，不代表资源绑定或云端调用已经开放。

公共请求先经已有平台 hop 校验四段可信业务身份，`managed-runtime-actions` 再将
该身份摘要保存到原生会话的归属记录。资源适配器使用 DSH 原生 SessionId 查询这个
记录，得到同一个 `aeu_<owner digest>`，不从 body、Metadata 或模型 options 选择用户。
长期记忆适配器继续按 collection、Agent 和业务用户生成已有 `mp1-` 分区。

同一主体的新会话得到相同资源主体，不同主体得到不同主体；Host 重启后从持久盘恢复。
每次模型请求都重新读取归属，缓存只保存原生/公共会话 ID 的映射。已删除/正在删除、
版本不一致、归属未知或 userId 与 owner 不一致时拒绝，不能降级到 studio-anonymous。
已有 Studio 本地和 portable 不安装该 resolver，保留原身份规则。

复现回归：

```sh
node --test tests/managed-resource-identity.test.mjs tests/managed-runtime-actions.test.mjs
pnpm check
```

测试覆盖三个 profile 的实际 provider 调用参数、两个主体、多会话、目录重开、删除、
版本变化和伪造 UserId；HTTP 测试使用真实 loopback HTTP、实际 Action 与会话目录，但
DSH Controller/model/resource upstream 是受控 fixture，不是完整安装 Host 或预发资源验收。

资源引用准入/版本冻结、云端受控传输以及MCP/Skill解析已进入候选；实际云端消费仍待验证。
记忆库权限不能仅由主体分区证明；还须验证租户资源授权、更新/解绑、撤权及失败结果。

## 声明到现有资源消费者的转换

源码候选支持`resources.knowledge_base`、`resources.memory`单引用，以及最多16个唯一
`resources.skill_spaces`引用。旧`skill_space`单引用仍兼容，与数组形式互斥。资源引用含id和
可选region。`mcp_servers`最多16项，支持已登记MCP引用或直接http/sse描述符；直接描述符含
稳定别名、endpoint、transport及env_refs，实际凭证由部署环境单独注入，不在YAML内联。
不支持通过MCP声明任意stdio命令。

`managed-resource-contract.mjs` 校验后复用 `platformBinding`，三种 profile 生成同样的
KB/Memory/Skill Space 插件配置与 MCP bindings，再由现有资源适配器消费。跨语言
用例为 `tests/fixtures/dsh-resources-v1.json`，与 Server 的同名文件保持一致。

Server 必须从同一镜像目录确认 `resourceContract: agentengine.resources/v1`；旧目录
拒绝 resources 字段，不能用新 Server 的解析能力推断旧镜像可用。目前公共资源准入
仍关闭，云端访问和真实资源调用尚未完成，不得把这组组件测试标为预发 A10 通过。

## 业务模型请求与辅助请求

自动标题会携带同一个 SessionId；仅按 SessionId 选择 Agent 执行路径，会把标题请求
交给资源适配器，甚至将标题写入长期记忆。Host 在路由前使用运行中的 DSH 提供的
`isAgentLoopRequest`，只转发真实 Agent 循环创建的请求对象。标记是进程内对象身份，
复制 options、填写 purpose 或 Metadata 都不能产生该身份。

Host 兼容检查增加 `agent-loop-origin`。缺少公共标记 API 时相关执行功能不可用，
诊断页面仍可读取；不能用复制上游实现的 WeakSet 代替运行中的 Host。
模型、资源、权限和原生会话/重放/取消仍由现有模块负责，没有新增另一套循环或记忆存储。

## 托管记忆许可的调用范围

业务分区哈希不是授权凭证。Server候选在既有调用的私有头
`X-AgentEngine-Resource-Permit`中下发一小时有效的记忆许可，绑定Agent、Version、声明摘要、
记忆库和可信业务主体；签名密钥仅在Server。资源代理验证签名及分区，Agent级token不能
自行切换到其他业务用户的分区。该改动需要配套Server及新运行时镜像，不对旧镜像宣称可用。

`managed-resource-context.mjs`使用Host实例内的AsyncLocalStorage保留当前调用的许可；
HTTP runner结束后立即失效，延迟回调不能沿用。许可不进入runner参数、模型选项、声明、环境
或原生会话事件。Host只检查许可与当前上下文一致，最终签名校验和授权由Server执行。
KB/Skill等公共绑定继续复用原adapter，不因该许可增加额外模型循环。

Memory资源客户端仅在当前调用中把许可加到私有HTTP头，并继承该调用的取消信号；不自动重试
写入，也不保证撤回已经被AICP受理的任务。未绑定记忆的运行时及portable个人助理保留原入口。

当前有真实loopback HTTP的双主体、并发调用、缺许可、调用结束及runner/历史不含许可检查；
资源上游受控。Server对签名、跨主体、版本、过期和撤权另行验证。完整三profile安装态、真实
云资源消费、命令/文件系统和其他Host API隔离仍待完成，A5/A10未通过。
