> 迁移自现有 KsADK Host 合同核对；新工程以此为 Server API 分类基线，运行时联调仍需在本工程复核。

# Studio 原生 DSH 云 API 差距（P1 冻结草案）

核对日期：2026-09-28。依据 `agentengine-server` 当前 checkout
`7b85e91d70924af0ce16ce0fa5e176cd95394584` 的实际
`app/api/v1/actions` 路由/请求模型；现有《数字员工托管Agent接口文档》标注的
`master@e6aa4f27` 比源码旧，因此本表以路由为准。此文档不代表线上 KOP
白名单或部署环境已经发布相同接口。

状态值：**已有** = 当前 Server 路由存在；**Adapter 补齐** = 在不改变 Server
语义时可做确定性映射；**Host 补齐** = 本地 KsADK Host 负责；**Server 待加** =
当前公共 Action 不足；**首期不支持** = 首期 UI 应明确隐藏/禁用。

| Port / 行为 | 现有 Action 与精确边界 | 判定 | 差距或验收 |
| --- | --- | --- | --- |
| AgentCatalogPort：列出/详情 | `ListAgents`、`GetAgent`，均为 POST Action；由 Server `RequestContext` 处理账号 | 已有 + Adapter 补齐 | 列表分页、状态字段和 Studio catalog ID 映射需 fixture；不能从展示名推断身份 |
| AgentCatalogPort：创建/修改 | `CreateAgentProduct`、`CreateAgent`、`UpdateAgent` | 已有 + Adapter 补齐 | `CreateAgentProduct` 有 Framework、DeploymentType、Code/Container/ManagedRuntimeConfig、Resource、Scaling、Storage、Network、ComponentConfig、UiConfig、DeployMode 等字段；Studio draft 不得盲传未知字段 |
| DeploymentPort：Build | 无独立公开 `Build` Action；本地 Studio 的 `BuildRecord` 是本地构建 | Host 补齐 / Server 待加 | 若云端要独立 build，需 Server `CreateBuild`、`GetBuild` 或明确 Create/Update 的异步构建契约；请求需 AgentId、source digest、idempotency key；响应需 BuildId、状态、可轮询 revision、错误码 |
| DeploymentPort：Deploy/Stop/Delete | `CreateAgentProduct`/`UpdateAgent` 可触发部署；`DeleteAgent` 存在；没有独立 `StopDeployment` | 已有 + Server 待加 | 不可把删除等同 Stop；Server 需显式 Stop/Start 或书面声明受支持的状态迁移及异步完成条件 |
| DeploymentPort：Rollback | `CreateVersion`、`ListVersions`、`RollbackVersion` | 已有 + Adapter 补齐 | `RollbackVersion` 接受 AgentId 和 TargetVersionId/TargetTag，返回 Status/Noop；需验证异步轮询、重复请求及流量切换最终态 |
| SessionPort：会话目录 | `CreateSession`、`GetSession`、`ListSessions`、`UpdateSession`、`DeleteSession` | 已有 + Adapter 补齐 | `UpdateSession` 只改 tags，带可选 `ExpectedTagsRevision`；创建可返回 `RuntimeSync=pending_create`，Host 必须显式呈现并恢复 |
| SessionPort：发送/运行 | `RunAgent`、`SubmitAgentControl` | 已有 + Adapter 补齐 | 核对 agent kernel 与 legacy proxy 双路径的 receipt、去重和失败语义；不能由网络超时推断未接收 |
| SessionPort：历史/追随 | `ListSessionEvents`、`SubscribeRunEvents`，另有 `SubscribeSessionEvents` | 已有 + Adapter 补齐 | `AfterSeqId`/会话物理 seq 与 DSH `SessionWireEvent.seq` 建立唯一映射；须实测快照+tail、分页、重连、重复/缺口修复 |
| SessionPort：取消/恢复 | `CancelRun`、`ResumeRun`、checkpoint 列表与预览 | 已有 + Adapter 补齐 | 取消后的晚到事件必须由事件事实决定 UI 终态；恢复须保留 checkpoint/continuation 身份 |
| SessionPort：交互决议 | `SubmitInteraction` | 已有 + Adapter 补齐 | 请求精确字段：AgentId、SessionId、RunId、InteractionId、`ExpectedRevision>=1`、InteractionAction、Response、`IdempotencyKey`；不存在/过期/revision 冲突需消费实际错误码；kernel capability 缺失返回 409 |
| ResourceBindingPort：会话资源 | `Create/List/Get/Update/DeleteSessionResource` 等 | 已有，但仅会话资源 | 这些路由不是通用 Agent capability binding；不可当作 MCP/Skill/Knowledge/Memory/Sandbox 的统一绑定 API |
| ResourceBindingPort：Agent 能力绑定 | `CreateAgentProduct.ComponentConfig` 与各独立资源路由 | Server 待加 | 需要明确资源类型、resource ID/version、binding ID、agent draft/version、secret ref、生命周期和有效能力；更新要求 `expected_revision`，删除应幂等；响应给最终状态与错误码 |
| Sandbox 资源绑定 | 有 sandbox 相关 Action，但缺已证实的通用 Studio binding | 首期不支持 | UI 不得宣称跨本地/云端一致支持，直到 Host 与 Server 契约有端到端证据 |

## 横向语义待验收

| 主题 | 现状与需要补齐的合同 |
| --- | --- |
| 身份与鉴权 | Server 路由使用 `RequestContext`、`X-Auth-Agent-Id`、会话所有权验证；Studio 必须拿到可审计的 account/tenant/agent/session 授权范围。不得把客户端提交的身份字段当权限源。线上 IAM/KOP 发布范围仍需实际环境验证。 |
| 幂等 | `SubmitInteraction.IdempotencyKey` 和 Kernel `SubmitAgentControl` 有显式键；`X-Ksc-Request-Id` 仅是追踪 ID。Create/Update/Deploy/Rollback 的通用幂等键尚无冻结公共契约；超时后先按资源 ID/digest 查询，不做盲重试。 |
| 异步与状态 | `CreateSession.RuntimeSync` 可为 `pending_create`；Deploy/Rollback 返回可能是过渡状态。Port 需统一 `pending/running/succeeded/failed/canceled`、服务器 revision、轮询间隔/截止时间，不能把 HTTP 200 当完成。 |
| 错误 | Action 响应 envelope 与直接 HTTP 4xx 均可能出现。Adapter 需保留 HTTP status、Action code、RequestId、可重试性及 Retry-After；429、404、断连、超时不能合并为普通文本消息。 |
| 分页与游标 | Agent/Version 列表和 Session history 分页不是同一模型。Port 必须保留原始 cursor/seq，采用 watermark + tail，并验证缺口修复与事件去重。 |

## 真实浏览器补充证据

2026-09-24 的固定 DSH `0.1.7-rc.1` 浏览器探针在外层
`/studio-core/#/conversations` 创建会话并点击“停止生成”后，AX 页面显示“已请求取消本次运行”，
浏览器 console 同时记录：`Studio 尚未实现云端共享 Web 动作：CancelRun`。这不是对
Server `CancelRun` 路由是否存在的重新判断；它证明当前 Studio shared Web action/Host
适配层尚未把该路由接到 DSH Client 的停止命令。P0/P1 必须保留该缺口，直到真实
取消 receipt、终态事件和迟到事件处理完成。

## 建议的 Server 增补最小请求/响应

1. `CreateBuild`：`AgentId: string`、`SourceDigest: string`、`IdempotencyKey: string` 必填；
   `ExpectedAgentRevision?: integer` 可选。返回 `BuildId`、`Status`、`Revision`、
   `RequestId`。`GetBuild` 返回相同身份/状态、产物 digest 与结构化错误。
2. `StopDeployment`：`AgentId: string`、`ExpectedDeploymentRevision: integer`、
   `IdempotencyKey: string` 必填；返回 `OperationId`、`Status`、`Revision`。
   404、409 和超时后可查询的规则须冻结。
3. `UpsertResourceBinding` / `DeleteResourceBinding`：`AgentId`、`ResourceKind`、
   `ResourceId`、`ExpectedRevision`、`IdempotencyKey` 必填；secret 仅以引用传递；
   返回 `BindingId`、`Revision`、`Status`、`EffectiveCapability`。读取端需按 Agent
   和 version 返回完整绑定快照。

这些是提议，不是已经存在的接口。字段为空值与缺省值的区别、权限矩阵、并发冲突
及可重试代码在 Server 实现/开放之前不能由 Studio 自行猜定。

## 2026-09-28 路由快照（可复核证据）

为避免把旧接口文档当成合同，本次在 Server checkout `7b85e91d70924af0ce16ce0fa5e176cd95394584`
直接扫描 `app/api/v1/actions/*.py` 的 FastAPI decorator；完整机器可读结果保存在
[`server-route-snapshot-2026-09-28.json`](../../../.scratch/studio-dsh-native-2026-09-24/server-route-snapshot-2026-09-28.json)。与本表相关的实际公开 Action
如下（同一名称在不同模块重复注册的情况保留为一个语义项）：

| 能力面 | 源码中实际存在的 Action |
| --- | --- |
| Agent catalog / lifecycle | `CreateAgentProduct`, `CreateAgent`, `ListAgents`, `GetAgent`, `UpdateAgent`, `DeleteAgent`, `FetchAgentInstanceStatus`, `ListInstances`, `ListEnvPresets`, `GetAgentLogs` |
| Version / deployment | `CreateVersion`, `ListVersions`, `RollbackVersion`（版本模块；部署没有独立 `StopDeployment` Action） |
| Session / run | `CreateSession`, `GetSession`, `ListSessions`, `UpdateSession`, `DeleteSession`, `RunAgent`, `SubmitAgentControl`, `GetAgentStatus`, `ListSessionEvents`, `ListSessionMessages`, `SubscribeRunEvents`, `SubscribeSessionEvents`, `CancelRun`, `ResumeRun`, `ListSessionCheckpoints`, `GetCheckpointResumePreview`, `ListToolReceipts` |
| Interaction | `SubmitInteraction` |
| Session resources | `CreateSessionResource`, `GetSessionResource`, `GetSessionResourceByAgent`, `ListSessionResources`, `ListSessionResourceAgents`, `ListSessionResourceSessions`, `ListSessionResourceSessionEvents`, `UpdateSessionResource`, `DeleteSessionResource` |
| Schedules | `CreateAgentSchedule`, `GetAgentSchedule`, `ListAgentSchedules`, `ListAgentScheduleOccurrences`, `UpdateAgentSchedule`, `DeleteAgentSchedule`, `RunAgentSchedule` |
| Observability | `GetObservabilityOverview`, `ListAgentRuntimeStats`, `SetLangfuseAuthCookie` |

这次扫描没有发现公共 `CreateBuild`、`GetBuild`、`StopDeployment` 或通用
`UpsertResourceBinding`/`DeleteResourceBinding`。因此表中把独立 Build、部署停止和 Agent
级能力绑定标为 Server gap 是源码核对结论，不是 UI 假设。`CreateAgentProduct` 的嵌套
`ComponentConfig` 可以承载部分创建期配置，但不能替代一个可查询、可版本化、可幂等更新的
binding 资源合同。

复核命令：

```sh
python3 - <<'PY'
from pathlib import Path
import re
root = Path('app/api/v1/actions')
pattern = re.compile(r'@router\.(?:post|get|put|patch|delete)\("/([A-Za-z0-9_{}-]+)"')
for path in sorted(root.glob('*.py')):
    source = path.read_text(encoding='utf-8')
    for name in sorted({m.group(1) for m in pattern.finditer(source)}):
        print(name, path)
PY
```

这份快照只证明代码中注册了路由；它不证明线上 IAM 白名单、租户权限、异步 worker、
真实凭证或部署环境已发布相同能力。进入 P2 前仍需用带审计身份的集成环境逐项取得成功、
429、404、409、断流和超时证据。
