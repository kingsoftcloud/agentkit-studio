# agentengine-server 现有 HTTP API → 双客户端需求映射表

> 审计性质：**只读审计**，结论全部以 `agentengine-server` 代码为准（证据列为 `文件:行号`）。
> 目标：agentkit-studio（TS / DSH 插件，零代码）与 ksadk-python（Python SDK/CLI，高代码）作为**平等客户端**，
> 调用**同一套现有 API** 完成 Agent 的创建 / 部署 / 管理。硬约束：**保留现有接口，只允许加法字段**，
> 不为新客户端另造 Create/Update API；"数字员工"只做底层能力（身份字段作为可透传数据字段）。
>
> 本文不含任何真实凭证 / token / 内网敏感信息；仅出现端点与字段名。

---

## 0. 浓缩结论

- 对外 Action 面共 **124 个端点**（`POST /agentengine/api/v1/{Action}` 为主，含少量 GET/SSE）。
  三态统计：**✅ 够用 89 / 🟡 缺加法字段 34 / 🔴 缺语义 1**（端点级）；
  另有 **3 项需求级 🔴**（无法用加法字段解决，见 §7）。
- 双客户端主链路（创建→部署→状态→更新→停止/删除→幂等重放）**可以完全复用现有接口**，
  不需要新造 Create/Update API；缺口集中在**加法字段**（kind / origin / provenance / resourceRefs /
  deploymentRef / Idempotency-Key / typed error）与**平台硬化**（service account、配额限流、审计查询面）。
- 端点级唯一 🔴：`FetchAgentInstanceStatus`（FAILED 被改写为 STARTING，失败终态必须行为级修复；可暂用 `GetAgent` 绕过）。
- 需求级 🔴（加法字段解决不了）：
  1. **管理面 service account / API key** —— 需要新凭据实体 + 生命周期端点 + 鉴权中间件行为（现有 AgentApiKey 只服务数据面单 Agent）。
  2. **配额 / 限流** —— 需要网关/中间件执行行为，没有任何字段能让现有端点拒绝超量请求。
  3. **管理面审计查询面** —— 写侧已部分存在（控制命令审计表），但查询需要**新端点**。

---

## 1. 全局合同事实（以代码为准）

| 事实 | 现状 | 证据 |
| --- | --- | --- |
| 统一入口 | `POST /agentengine/api/v1/{ActionName}`（KOP Action 风格）；正式调用另有 KOP 形式 `?Action=..&Version=2024-06-12`（V4 签名 `service=aicp`） | `app/main.py:854`；`docs/数字员工托管Agent接口文档.md:19-56` |
| 统一响应包络 | `HttpResponse{Code:int(0=成功), Message:str, RequestId:str, Action:opt, Data:opt[T]}` | `app/api/v1/actions/base.py:33-64` |
| 错误响应 | `ErrorResponse{Code:int, Message:str, RequestId, Data}`；`Code` 直接用 HTTP 风格数字（400/401/403/404/409/422/429/5xx），`Message` 为中文人读文案（marker 启发式翻译），**无稳定机器码 / source / scope** | `base.py:67-85,104-114`；`app/core/error_translation.py:68-74,208-280` |
| 请求上下文（header） | `X-Ksc-Request-Id / X-Ksc-Account-Id / X-Ksc-Region / X-Ksc-Data-Region / X-Ksc-Product / X-Ksc-Source / X-KSC-CUSTOM-SOURCE / X-Ksc-User-uuid` + 内部受信身份 `X-AgentEngine-{Identity-Namespace,Business-Tenant-Id,Subject-Type,Subject-Id}` | `base.py:256-341` |
| 业务身份 | `VerifiedBusinessIdentity`（namespace/tenant/subject），由受信 header 或默认 IAM 映射推导 | `app/services/invocation_identity.py`；`base.py:127-165` |
| 内部面 | `/agentengine/internal/{gateway,dashboard,agent-kernel,v1}`，`include_in_schema=False` | `app/main.py:856-885` |
| 合同冻结机制 | `app/contracts/agent-kernel-v1.json`（contract set + aggregate digest + compatible digests，只允许加法变更）；AgentInstance 记录 `contract_digest` | `app/contracts/agent-kernel-v1.json`；`app/models/agent_instance.py:33-34` |

---

## 2. 需求 → 现有接口映射总表（双客户端视角）

| 双客户端需求 | 现有接口 | 三态 | 缺口要点 |
| --- | --- | --- | --- |
| 创建-高代码（Code ZIP / 镜像 + provenance，ksadk 构建） | `UploadCode` + `CreateAgentProduct`（`DeploymentType=Code/Container`，`CodeConfig.Checksum`） | 🟡 | 无 `kind`、无 `origin/deployed_by`、provenance 仅 `Checksum/ManifestSHA256`（无 builder/commit/source）、无 `Idempotency-Key` |
| 创建-零代码 spec（studio） | `CreateAgentProduct`（`ManagedRuntimeConfig.Manifest` + `ComponentConfig` + `MemoryConfig` + `Advanced`） | 🟡 | 同上 + `resourceRefs` 不完整（MCP 无法以资源 ID 绑定，Skill 仅能绑单个 SkillWorkspace，模型绑定散落 `Advanced`/Manifest） |
| 部署（Build 产物 → Deployment） | `CreateAgentProduct`（同步物化 ManagedRuntime / Code-Container 走订单回调 `CreateAgent`）、`UpdateAgent`（热更新） | 🟡 | 无 `deploymentRef`（Deployment→Build/制品 digest 显式引用）；`AgentInstance.bundle_digest` 是内部投影非合同字段 |
| 状态 / readiness | `GetAgent`（`Status/Phase/Replicas/ReadyReplicas`、`Deployment.AgentKernelReady/DeploymentPhase/BundleDigest`）、`FetchAgentInstanceStatus`、`ListInstances` | 🟡 / 🔴 | `FetchAgentInstanceStatus` 把 `FAILED` 改写为 `STARTING`（🔴）；readiness 细节（滚动进度/失败原因）不足 |
| 更新（spec / 资源） | `UpdateAgent`（局部更新、`EnvironmentVariablePatch`） | 🟡 | 无 revision 乐观锁（会话面已有 `ExpectedTagsRevision` 先例）、无 `Idempotency-Key` |
| 回滚 | `CreateVersion` / `ListVersions` / `RollbackVersion` | 🟡 | 版本↔制品引用仅 `artifact_path`，缺 `deploymentRef`/digest 字段；无幂等键 |
| 停止 / 暂停 | **无专用端点**；`Scaling.MinReplicas: ge=1` 不能缩 0 | 🟡 | 可用加法字段表达（如 `UpdateAgent.DesiredState: active|stopped`），不需要新端点 |
| 删除 | `DeleteAgent`（软删默认 / `HardDelete` / 同步删 KS3·KCR·KLog） | 🟡 | 无幂等键（重试可能重复触发下游删除，结果幂等但审计重复） |
| 会话 / 多轮 | `CreateSession` / `UpdateSession` / `GetSession` / `ListSessions` / `DeleteSession` | ✅/🟡 | 会话合同最完整（tags + `ExpectedTagsRevision` 乐观锁）；缺幂等键 |
| 运行（KOP RunAgent 兼容） | `RunAgent`（`ApiFormat: responses|chat_completions`、`ResponsesInput/PreviousResponseId`、`Stream/Background`）、`ResumeRun` / `CancelRun` | 🟡 | 幂等仅靠 `InvocationId` 部分覆盖；响应 Data 为 OpenAI 风格透传（兼容面 OK，但非 canonical envelope） |
| 事件流 / 断点续传 | `ListSessionEvents`（`AfterSeqId/BeforeSeqId/Offset/Limit/EventTypes`）、`SubscribeRunEvents`（`AfterSeqId`）、`SubscribeSessionEvents`（`after_seq`） | 🟡 | SSE **不发 `id:` 行、不认 `Last-Event-ID` 头**（用查询参数续传）；kernel 流为透传且合同 digest 冻结 |
| 归属管理（cli / studio 各自管理） | `ListAgents`（account 隔离 + `IsPrivate` + `Creator`） | 🟡 | 无 `origin/deployed_by/labels`；建议加法字段 + 显式过滤参数表达"各自管理"，不加两套可见性 API |
| 幂等键 | 仅 `SubmitAgentControl` / `SubmitInteraction`（`IdempotencyKey` 必填 + receipt 去重） | 🟡 | 管理面所有 Create/Update/Delete 无 `Idempotency-Key` |
| typed error | `Code(int)+Message(中文)` | 🟡 | 缺 `Error{code(稳定字符串), message, source, scope}` 加法结构 |
| service account / API key（管理面） | 数据面 AgentApiKey 有；管理面仅云 AK/SK（KOP V4） | 🔴 | 需要新凭据实体与生命周期端点（加法字段解决不了） |
| 配额 / 限流 | 无（`ApiKey.rate_limit` 列存在但未执行） | 🔴 | 需要执行行为（中间件/网关），字段加法解决不了 |
| 审计 | 写侧部分有（`AgentControlAudit`、`SessionTagsUpdated`、`log_action_response`）；无查询 API | 🔴 | 查询面需要新端点 |
| 合同版本化 | KOP `?Version=2024-06-12`；agent-kernel contract digest 冻结机制 | 🟡 | 响应体无 `ContractVersion`，SDK 无法协商/断言合同版本 |
| 数字员工身份透传 | `Name/Description/Tags/Advanced` 可透传，无专用字段 | 🟡 | 加法 `labels`/`identity`（display name/avatar/role 作为透传数据）即可，不建专用 API |
| conformance 合同用例 | 无现成 conformance 套件 | ➕ | 见 §8 测试-0903 清单（交付测试资产，非 API 变更） |

---

## 3. 端点明细表（逐端点三态）

图例：✅ 够用 · 🟡 缺加法字段 · 🔴 缺语义（需新端点或行为级变更）。
写端点统一缺 `Idempotency-Key`、全体统一缺 typed error 结构（全局缺口，见 §4/§5）；下表"缺口"列只写该端点特有缺口。

### 3.1 Agent 生命周期（`app/api/v1/actions/agent_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 Data | 缺口 |
| --- | --- | --- | --- | --- |
| 🟡 | POST `/CreateAgentProduct` | `Name, Description, Framework, Region, DeploymentType(Code\|Container\|ManagedRuntime), CodeConfig{Path,Checksum,Language,Command}, ContainerConfig{ImageType,NameSpace,ImageRepo,ImageVersion,ImageAddr,UserName,Password,Command,Port}, RuntimeConfig{Name,Version,ManifestSha256,ImageDigest,Package,Protocol,PluginArtifacts}, ManagedRuntimeConfig{Manifest,ManifestSHA256,RuntimeName,RuntimeVersion,PluginArtifacts}, Resource{Cpu,Memory}, Scaling{MinReplicas,MaxReplicas,QpsPerInstance}, Storage, KS3MountConfig, SessionAffinity, Network, Access{AuthType,ApiKeyId,IamRole}, Advanced{EnableObservability,EnvironmentVariables,Tags,InboundIdentityAuth,ProjectName,ProjectId,DeployMode,ComponentConfig,IsPrivate}, ComponentConfig, UiConfig{Profile,Path,Url}, DeployMode, MemoryConfig, AutoPay`（:2261-2337） | `AgentId, InstanceId`，ManagedRuntime 分支附 `RuntimeConfig{Name,Version,ImageDigest,Package,Protocol,PluginArtifacts,ManifestSha256}`（:3445-3458） | 缺 `kind/origin/deployed_by/labels/runtimeRef/resourceRefs/capabilities/deploymentRef`；`ComponentConfig` 仅 `{KnowledgeBase,Memory,Sandbox,SkillWorkspace,SessionManagement,A2ASpace}`（:535-546），**无 MCP、无 Skill 列表**；provenance 仅 `Checksum/ManifestSHA256` |
| 🟡 | POST `/CreateAgent` | 同上 + `InstanceId`（**必填**，:2415，Serverless/订单回调传入）、`AgentId`、`OrderId` | `{AgentId, InstanceId, ...}` | 物化语义绑定订单回调流，直连客户端应走 `CreateAgentProduct`；字段缺口同上 |
| 🟡 | POST `/GetAgent` | `AgentId \| Name` 二选一、`IncludeApiKey`（:2649-2659） | `QuickAccess{PublicEndpoint,PrivateEndpoint,ApiKey}`、`Basic{AgentId,InstanceId,Name,Description,Status,Phase,Message,Replicas,ReadyReplicas,Creator,IsPrivate,CreatedAt,UpdatedAt}`、`Deployment{DeploymentType,ArtifactPath,Framework,Region,Resource,Scaling,Storage,KS3Mount,SessionAffinity,CodeConfig,ContainerConfig,RuntimeConfig,AgentKernelReady,AgentInstanceId,BundleDigest,DeploymentPhase}`、`Network,Access,Advanced,ComponentConfig,UiConfig`（:2663-2856） | 回显缺 `kind/origin/labels/runtimeRef/capabilities`；`BundleDigest/AgentInstanceId/DeploymentPhase`（:2716-2730）是 `deploymentRef` 的雏形但未成引用合同 |
| 🟡 | POST `/ListAgents` | `Page, PageSize, Region, Name, Id, Status, Framework(单值/多值)`（:2426-2448） | `Agents[]{AgentId,AgentRuntimeId,Name,Description,Status,Phase,Message,Endpoint,Replicas,ReadyReplicas,Framework,ArtifactType,Region,MemoryConfig,ComponentConfig,IsPrivate,Creator,CreatedAt,UpdatedAt}, Total,Page,PageSize` | 无 `origin/deployed_by/labels` 字段与过滤；缺归属默认过滤表达（建议加法 `Origin/Labels/DeployedBy` 过滤参数） |
| 🟡 | POST `/UpdateAgent` | `AgentId` + 局部字段（Name/Description/Region/DeploymentType/CodeConfig/ContainerConfig/RuntimeConfig/ManagedRuntimeConfig/Resource/Scaling/Storage/KS3Mount/SessionAffinity/Network/Access/DeployMode/EnvironmentVariables\|EnvironmentVariablePatch/Advanced/ComponentConfig/UiConfig/MemoryConfig）（:2547-2628） | 更新后 Agent 摘要 | 无 revision/`ExpectedRevision` 乐观锁（对比 `SubmitInteraction.ExpectedRevision`、`UpdateSession.ExpectedTagsRevision` 已有先例）；ManagedRuntime 更新须整单重提 `ManagedRuntimeConfig`；无 `DesiredState`（停止语义） |
| 🟡 | POST `/DeleteAgent` | `AgentId, SyncDeleteKs3/Kcr/Klog, HardDelete`（:2630-2647） | `{deleted, ...}` | 无幂等键 |
| 🔴 | POST `/FetchAgentInstanceStatus` | `InstanceId`（:3282-3286） | `AgentId, Status, Phase, Message`（:3288-3295） | **行为级问题**：`FAILED` 被改写为 `STARTING`（:4524-4525），失败终态不可信；修复必须行为级变更（去掉改写），加法字段解决不了。绕行：用 `GetAgent.Basic.Status/Phase/Message` |
| ✅ | POST `/ListInstances` | `AgentId, Page, PageSize, Name, Id`（:4543-4556） | `Instances[]{InstanceId,InstanceName,Status,Version,Spec,Cpu,Memory,Restarts,CreatedAt}, Total` | — |
| ✅ | POST `/ListEnvPresets` | （预设查询） | 环境变量预设 | — |
| ✅ | POST `/GetAgentLogs` | `AgentId, Instance, LogType(Stdout\|Log), StartTime, EndTime, Keyword, Page, PageSize` | `Logs[]{行文本}, Total` | — |
| 🟡 | POST `/RunOpenClawRepair` | `AgentId, RepairAction(doctor-fix)` | 修复结果 | 幂等键 |
| 🟡 | POST `/UploadCode` | `Filename(.zip), AgentId?`（:3262-3267） | `PresignedUrl, ObjectKey, Bucket, KS3Path, ExpiresIn`（:3269-3280） | 缺 provenance 加法字段（builder/commit/source/toolchain） |

### 3.2 版本 / 回滚（`version_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 | 缺口 |
| --- | --- | --- | --- | --- |
| 🟡 | POST `/CreateVersion` | `AgentId, Tag?, Description?` | 版本快照（`AgentVersion{tag,tag_type,artifact_type,artifact_path,version_metadata,status}`，`app/models/version.py:33-80`） | 幂等键；缺 `deploymentRef` |
| ✅ | POST `/ListVersions` | `AgentId, Page, PageSize` | `Versions[]{VersionId,VersionName,Tag,Status(current\|historical),TrafficPercentage,CreatedAt,CreatedBy,CanRollback,RollbackDisabledReason}` | — |
| 🟡 | POST `/RollbackVersion` | `AgentId, TargetVersionId?\|TargetTag?`（KS3 AK/SK 为保留字段） | `AgentId, TargetVersionId, Status, Noop` | 幂等键；回滚后 Deployment 制品引用未成合同字段 |

### 3.3 会话（`session_actions.py` / `session_message_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 | 缺口 |
| --- | --- | --- | --- | --- |
| 🟡 | POST `/CreateSession` | `AgentId, UserId?, SessionId?, Tags, ExpiresHours(忽略)` | `{Session{...}, RuntimeSync(pending_create\|synced)}`；Session 含 `id,agent_id,user_id,identity_namespace,business_tenant_id,subject_type,subject_id,title,summary,tags,revision,runtime_sync_status,created_at,updated_at`（`app/models/conversation.py:31-44` + `_serialize_session`） | 幂等键 |
| 🟡 | POST `/UpdateSession` | `SessionId, AgentId?, SetTags, RemoveTags, ExpectedTagsRevision?` | 更新后 Session | 幂等键（乐观锁已有） |
| ✅ | POST `/GetSession` | `SessionId \| Id` | Session | — |
| ✅ | POST `/ListSessions` | `AgentId, UserId?, TagFilters, TagMatch(all), Page, PageSize` | Session 列表 | — |
| 🟡 | POST `/DeleteSession` | `SessionId \| Id` | 删除结果 | 幂等键 |
| ✅ | POST `/ListSessionMessages` | `SessionId, AgentId?, UserId?, AfterSeqId, BeforeSeqId, CursorSource, IncludeAttachments, IncludeReasoning, IncludeToolEvents, Limit` | 消息投影（含 tool receipt 折叠） | — |

### 3.4 运行 / 事件（`chat_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 | 缺口 |
| --- | --- | --- | --- | --- |
| 🟡 | POST `/RunAgent` | `AgentId?, Messages[]{role,content}, SessionId?, UserId?, AccountId?, Model?, ModelMetadata?, ModelOptions?, Stream, Background, ApiFormat(responses\|chat_completions), ResponsesInput?, PreviousResponseId?, InvocationId?, Metadata`（:166-234） | `Data` = OpenAI Responses / chat.completion 风格透传（`RunAgentActionResponse`，:432-449）；`Stream=true` 时 SSE | 无 `Idempotency-Key`（`InvocationId` 只覆盖 approval/部分控制路径，:2624-2632）；typed error |
| 🟡 | POST `/RunSkillEvaluation` | `AgentId, InvocationId, ResponsesInput, SkillSource, SkillEvalControl, Model(固定), Stream` | 同 RunAgent | 同上 |
| ✅ | POST `/CancelRun` | `AgentId, SessionId, InvocationId, UserId?` | 取消结果 | 天然幂等 |
| ✅ | POST `/ResumeRun` | `AgentId, SessionId, RunId, CheckpointId, ResumeAttemptId, ResumeInstruction(Enabled), Model*, Stream, Background` | 续跑句柄/流 | 已有 `ResumeAttemptId` 防重 |
| ✅ | POST `/ListSessionEvents` | `SessionId, AgentId?, UserId?, AfterSeqId, BeforeSeqId, EventTypes, CheckpointIds, CursorSource, Limit, Offset` | `Events[]{EventId,SessionId,Author,EventType,Content,StateDelta,SeqId,Metadata,Timestamp,InvocationId}`（`_serialize_event`，:892-909） | canonical RuntimeEvent 形状可用 |
| ✅ | POST `/ListSessionCheckpoints` | `SessionId, RunId?, CheckpointId?, Framework?, ResumeStatus, ResumeTypes, OnlyResumable, Limit, Offset` | checkpoint 列表 | — |
| ✅ | POST `/GetCheckpointResumePreview` | `SessionId, CheckpointId, RunId?` | 续跑预览 | — |
| ✅ | POST `/ListToolReceipts` | `SessionId, RunId?, CheckpointId?, Limit, Offset` | 工具回执（幂等折叠） | — |
| ✅ | POST `/GetAgentUiBootstrap` | `AgentId \| Name, SessionId?` | UI bootstrap（含 SlashCommands/ApiFormats 等） | — |
| ✅ | POST `/ListAgentModels` | `AgentId \| Name` | 可用模型 | — |
| 🟡 | GET `/SubscribeRunEvents` | Query: `SessionId, InvocationId?, AfterSeqId?, AgentId?, UserId?`（:3686-3693） | SSE：`event: conversation.event` + `data:{...SeqId...}`、`data: [DONE]`、`: heartbeat` | **续传靠 `AfterSeqId` 查询参数**；帧内无 `id: <seq>` 行（`_sse_event` :911-918）；不认 `Last-Event-ID` 头 |
| ✅ | GET `/agent-control/jwks` | — | AgentControl permit 验签 JWKS | — |

### 3.5 Agent Control / 交互（`agent_control_actions.py` / `interaction_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 | 缺口 |
| --- | --- | --- | --- | --- |
| ✅ | POST `/SubmitAgentControl` | `AgentId, SessionId?, RunId?, CommandType(steer\|inject\|interrupt\|pause\|resume), Payload, IdempotencyKey`（:44-54，`extra=forbid`） | receipt（`command_id, receipt_status, error_code...`） | 幂等已闭环（receipt + `AgentControlAudit`） |
| ✅ | POST `/GetAgentStatus` | `AgentId, SessionId?` | 状态快照 | — |
| 🟡 | GET `/SubscribeSessionEvents` | Query: `SessionId, after_seq, AgentId?`（:155-161） | SSE（**透传 kernel 流**） | 无 `id:`/`Last-Event-ID`；透传流受 kernel 合同 digest 冻结约束 |
| ✅ | POST `/SubmitInteraction` | `AgentId, SessionId, RunId, InteractionId, InteractionAction, Response, ExpectedRevision, IdempotencyKey`（:35-45） | receipt | 已有幂等 + 乐观锁，是其余写端点的样板 |

### 3.6 API Key（`key_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 | 缺口 |
| --- | --- | --- | --- | --- |
| 🟡 | POST `/CreateAgentApiKey` | `AgentId, Name` | `{key_id, key_prefix, ...}`（`app/services/key_service.py:25-40,42+`；`ApiKey{key_hash,key_prefix,is_active,rate_limit,expires_at}` `app/models/agent.py:137-151`） | **数据面单 Agent key**：无作用域（action/project）、无轮换、`rate_limit` 列未执行；不能充当管理面 service account |
| ✅ | POST `/ListAgentApiKeys` | `AgentId` | `{Keys[]{key_id,key_prefix,name,is_active,created_at}}` | — |
| ✅ | POST `/DeleteAgentApiKey` | `AgentId, Id` | `{Deleted:true}` | — |

### 3.7 定时任务（`schedule_actions.py`）

| 态 | 端点 | 关键请求 | 关键响应 |
| --- | --- | --- | --- |
| 🟡 | POST `/CreateAgentSchedule` | `AgentId, DisplayName, Prompt, Schedule{kind: once\|interval\|cron,...}, SessionId?, Continuity, Enabled` | 任务 |
| ✅ | POST `/ListAgentSchedules` | `AgentId` | 任务列表 |
| ✅ | POST `/GetAgentSchedule` | `TaskId` | 任务 |
| 🟡 | POST `/UpdateAgentSchedule` | `TaskId, DisplayName?, Prompt?, Schedule?, SessionId?, Continuity?, Enabled?, ExpectedRevision` | 任务（已有乐观锁） |
| ✅ | POST `/DeleteAgentSchedule` / `/RunAgentSchedule` | `TaskId` | 结果 |
| ✅ | POST `/ListAgentScheduleOccurrences` | `TaskId, Limit` | 触发记录 |

### 3.8 MCP / 组件选项 / 知识库 / 记忆（`mcp_actions.py`、`knowledge_actions.py`、`memory_actions.py`、`mem0_actions.py`、`sandbox_actions.py`、`skill_workspace_actions.py`）

| 态 | 端点 | 关键请求 | 缺口 |
| --- | --- | --- | --- |
| 🟡 | POST `/CreateMCP` | `Name, Description, DeploymentType, ArtifactType, ArtifactPath, CodeConfig, ContainerConfig, McpVariable, Tools, Concurrency, Cpu, Memory, MinReplicas, MaxReplicas, Resource, Scaling, Network, Access, Advanced, Region, KS3*` | 幂等键；MCP 与 Agent **无资源引用绑定**（只能经 `ManagedRuntimeConfig.Manifest.mcp_servers` 或制品固化，见 `docs/数字员工托管Agent接口文档.md:266-300`） |
| ✅ | POST `/GetMCP`(`Id`) / `/ListMCPs`(`Page,PageSize,Region`) | | — |
| 🟡 | POST `/UpdateMCP` | 同 Create + `Id` | 幂等键 |
| ✅ | POST `/DeleteMCP`(`Id`) | | — |
| ✅ | POST `/ListKnowledgeBases`、`/ListMemoryInstances`、`/ListMemZeroInstances(Limit,Offset)`、`/GetMemZeroInstance(Mem0InstanceId,Region)`、`/ListSandboxes`、`/ListSkillWorkspaces` | 只读选项（含 `Disabled/DisableReason`） | — |

### 3.9 会话资源 / PostgreSQL（`session_resource_actions.py`）

| 态 | 端点 | 关键请求 |
| --- | --- | --- |
| 🟡 | POST `/CreateSessionResource`(`Name, Description, PostgreSQLConfig`)、`/UpdateSessionResource(ResourceId, ...)` | 幂等键 |
| ✅ | POST `/ListSessionResources(Id,Name,Page,PageSize,SortBy,SortOrder,Status)`、`/GetSessionResource(ResourceId)`、`/GetSessionResourceByAgent(AgentId)`、`/DeleteSessionResource(ResourceId)`、`/ListSessionResourceSessions`、`/ListSessionResourceSessionEvents`、`/ListSessionResourceAgents`、`/ListSessionResourceAgentOptions`、`/ListSessionResourceOptions(EnablePublicAccess,VpcId)`、`/ListPostgreSQLInstances(AgentId,Keyword,Region)` | |

### 3.10 上传 / 工作区（`upload_actions.py`）

| 态 | 端点 | 关键请求 |
| --- | --- | --- |
| ✅ | POST `/GetPresignedUrl(Filename)`、POST `/UploadFile`、GET `/AttachmentContent`、POST `/ListWorkspaceFiles(AgentId,Name?,Path?,Recursive?)`、POST `/AddWorkspaceFile`、POST `/DeleteWorkspaceFile(AgentId,Path)`、GET `/GetWorkspaceFileContent`、GET `/ExportWorkspaceZip` | — |

### 3.11 镜像（`image_actions.py` + REST `app/api/v1/images.py`）

| 态 | 端点 | 说明 |
| --- | --- | --- |
| ✅ | POST `/ListImageRegistries(ImageType,Keyword,Region)`、`/ListImageNamespaces(...)`、`/ListContainerImages(...)`、`/DescribeContainerImageDetails(Namespace,Repository,...)`、`/ListNamespaces`、`/ListRepositories`、`/ListImages`、`/GetImageInfo` | 镜像选择/查询 |
| 🟡 | POST `/CreateNamespace(AccessKey,Namespace,Public,SecretKey)` | 幂等键 |
| ✅ | REST `POST/GET /images/namespaces`、`GET /images/repositories`、`/images/tags`、`/images/info`（`app/api/v1/images.py:97-308`） | console/gateway 兼容面 |

### 3.12 观测 / 反馈 / 杂项

| 态 | 端点 | 说明 |
| --- | --- | --- |
| ✅ | POST `/GetObservabilityOverview(StartTime,EndTime)`、`/ListAgentRuntimeStats(...)`、`/ListAgentRuntimeResourceUsageHourly(AgentRuntimeId,ClusterId,...)`、POST/GET `/SetLangfuseAuthCookie`（浏览器 Cookie 面，SDK 不消费）、POST `/DescribeAgentMonitorMetrics(AgentId,Metrics,Period,...)` | — |
| ✅ | POST `/GetResponseFeedback`、`/UpsertResponseFeedback(AgentId,ResponseId,Rating,Comment,TraceId,RootSpanId)`、`/DeleteResponseFeedback` | upsert 天然幂等 |
| 🟡 | POST `/CreateDashboardAccessLink(AgentId,Name,LinkType,Path,ExpiresSeconds,ForceNew)` | 幂等键 |
| ✅ | POST `/ListDashboardAccessLinks`、`/DeleteDashboardAccessLink(LinkId)`、`/GetClientBootstrapConfig(ClientType,ClientVersion,Framework,Locale,Product,Region)`、GET/POST `/CheckIamRole(RoleName)`、POST `/ListAgentAndMcp`、`/ListAllAgentAndMcp(Region)` | — |
| ✅ | POST `/GetPluginDeliveryCapabilities`、`/UploadPluginArtifact`、`/GetPluginArtifactDownload(ArtifactId)`、`/ResolveAgentPluginArtifact(AgentId,ManifestSHA256)` | 不可变制品（digest 天然幂等），`RuntimeConfig.PluginArtifacts` 引用 |

### 3.13 A2A（`a2a_actions.py`，22 个端点，A2A 中心合同）

| 态 | 端点 |
| --- | --- |
| 🟡 | `CreateAToASpace`、`UpdateAToASpace`、`DeleteAToASpace`、`CreateAToAAgent`、`UpdateAToAAgent`、`DeleteAToAAgent`、`DeleteAToAAgentVersion`、`RunAToAAgent`（幂等键；其余字段齐全：AgentCard/凭据/空间成员/版本） |
| ✅ | `ListAToASpaces`、`GetAToASpace`、`GetAToAAgentCard`、`ListAToAAgents`、`GetAToAAgent`、`ListAToAAgentSpaces`、`ListAToAAgentVersions`、`GetAToAAgentVersion`、`ListAToASpaceAgents`、`GetAToARuntimeConfig`、`ListAToARuntimes`、`ListAToASpaceAvailableAgents`、`GetAToATask`、`CancelAToATask` |

### 3.14 内部面（`/agentengine/internal/*`，不对客户端开放）

| 端点 | 用途 | 鉴权 |
| --- | --- | --- |
| POST `/internal/gateway/responses-turns/mirror`、`/internal/gateway/session-routes/resolve` | gateway 会话镜像 / 粘性路由 | `X-Auth-Agent-Id`（网关注入） |
| GET `/internal/agent-kernel/instances/{agent_id}` | AgentInstance 目录解析（endpoint/ready/contract_digest） | `X-AgentEngine-Internal-Token`（可选配置） |
| POST `/internal/v1/agent-runtime/monitors/register\|delete`、`/internal/v1/agent-runtime/events`（`DedupKey` 幂等） | runtime 监控注册 / 事件摄取 | 内部 token |
| `/internal/dashboard/*`（login/overview/projects/agents/{id}/route-projection/links/langfuse-access/doctor-runs/logs/bootstrap/default-images） | Dashboard 聚合 | 内部 dashboard 登录 |
| `/health`、`/livez`、`/readyz`、`/metrics` | 存活/就绪/指标 | — |

---

## 4. 加法字段缺口清单（逐项核对）

| 加法字段 | 现状 | 已出现在 | 缺口端点 | 建议形态（只加不改） |
| --- | --- | --- | --- | --- |
| `kind`（`high-code\|spec`） | **无**（`ControlSource.kind`、schedule `kind` 是无关同名字段） | — | CreateAgentProduct / CreateAgent / GetAgent / ListAgents / UpdateAgent | 创建入参 + Get/List 回显的枚举字符串，缺省按 `DeploymentType/Framework` 推导 |
| `origin`（`cli\|studio`）/ `deployed_by` / `labels` | **无**（仅有 `Creator`、`Advanced.Tags: List[str]`、`IsPrivate`） | `agent.py:24-25`（creator/sub_account_id）、`agent_actions.py:2232`（Tags） | 同上 + ListAgents 过滤 | `Origin` 枚举 + `DeployedBy` 字符串 + `Labels: map<string,string>`；ListAgents 增加 `Origin/Labels/DeployedBy` 过滤参数（"各自管理"用显式过滤表达，避免破坏现有控制台默认行为） |
| `runtimeRef` | **部分**：`RuntimeConfig{Name,Version,ImageDigest,Package,Protocol}`、`AgentRuntimeId`、`runtime_id` | :212-231、`ListAgentItem.AgentRuntimeId`、`agent.py:39` | Get/List/Update 无统一引用对象 | 统一 `RuntimeRef{name, version, imageDigest}` 回显（值可与现字段并存） |
| `resourceRefs` | **部分**：`ComponentConfig{KnowledgeBase,Memory,Sandbox,SkillWorkspace(单个),SessionManagement,A2ASpace}` + `MemoryConfig` + `Advanced.Model*`；**MCP 不可绑资源 ID**，Skill 无 ID 列表 | :520-546、:469-510、`docs/数字员工托管Agent接口文档.md:266-312` | Create/Get/Update | 加法 `ResourceRefs[]{kind(mcp\|skill\|knowledge\|memory\|model\|sandbox), id, name}`；保留 `ComponentConfig` 原语义 |
| `capabilities` | **无**（A2A 的 `capabilities` dict、`GetPluginDeliveryCapabilities` 是无关概念） | `app/models/a2a.py:190` | Create/Get/List | `Capabilities[]{name, version?}` 声明式回显 |
| `deploymentRef`（Deployment→Build 产物） | **部分**：`Deployment.BundleDigest/AgentInstanceId/DeploymentPhase`、`AgentInstance{version_id,bundle_digest,contract_digest}`、`AgentVersion.artifact_path` | :2716-2730、`agent_instance.py:31-34`、`version.py:55-64` | Get/List/Update/Rollback 均无显式引用 | `DeploymentRef{deploymentId?, versionId, bundleDigest, artifactPath}` 回显对象 |
| `Idempotency-Key` | **部分**：`SubmitAgentControl.IdempotencyKey`、`SubmitInteraction.IdempotencyKey`（receipt 去重）、scheduler `idempotency_key`、内部 events `DedupKey`；**无 HTTP `Idempotency-Key` 头** | `agent_control_actions.py:54`、`interaction_actions.py:40`、`agent_instance.py:59-73` | 全部管理面写端点（Create/Update/Delete*/Run*） | 通用 `Idempotency-Key` 请求头（或 body 字段），服务端按 (account, action, key) 去重并回放首次结果 |
| typed error（`code/message/source/scope`） | **无**：`Code(int)+Message(中文文案)`；无稳定字符串错误码、无 source/scope | `base.py:67-85`、`error_translation.py:68-74` | 全部端点 | `Data.Error{code(稳定字符串), message, source, scope}` 加法对象 + `Code` 数字保持不变 |
| provenance（构建来源） | **无**（`CodeConfig.Checksum`、`ManagedRuntimeConfig.ManifestSHA256` 是完整性字段非来源字段；全仓无 `provenance` 命中） | :203-208、:300-315 | UploadCode / CreateAgent* / CreateVersion | `Provenance{builder, toolVersion, sourceUri?, commit?, builtAt?}` 加法对象 |
| 数字员工身份（名称/头像/角色） | **无专用字段**；`Name/Description/Tags` 可透传 | — | Create/Get/List/Update | 以 `Labels`/加法 `Identity{displayName?, avatar?, role?}` 纯透传，不做数字员工专用 API |

---

## 5. 鉴权 / 认证现状与缺口

| 层 | 现状 | 证据 |
| --- | --- | --- |
| 管理面（Action API） | 金山云 KOP 入口 `?Action=..&Version=2024-06-12` + **AWS V4 签名（service=aicp）**，即**云 AK/SK 账号级**；server 侧**不做签名校验**，直接信任上游注入的 `X-Ksc-Account-Id/X-Ksc-Region/X-Ksc-User-uuid` 等头 | `docs/数字员工托管Agent接口文档.md:19-56`；`base.py:256-341` |
| 数据面（Agent 运行调用） | `Authorization: Bearer <api_key>` → Ingress auth-url → server 查 `ApiKey.key_hash`（Redis 缓存→DB 回源），校验 active/过期/Agent 绑定后注入 `X-Auth-Agent-Id/X-Auth-Account-Id` | `docs/网关鉴权说明.md:1-67`；`app/models/agent.py:137-151` |
| 会话归属 | `VerifiedBusinessIdentity`（受信 `X-AgentEngine-*` 头或默认 IAM 映射）+ 会话目录归属校验（agent/user scope mismatch → 404） | `invocation_identity.py`；`base.py:182-237,418-454` |
| Agent Control | Server 签发 Ed25519 **permit**（TTL≤5min）+ JWKS 公开验签；命令不可变 + `AgentControlAudit` 审计 | `app/schemas/agent_control.py:25-120`；`chat_actions.py:1771` |
| 内部面 | `X-AgentEngine-Internal-Token` 共享密钥（可选配置；未配置=集群内网信任） | `app/internal_agent_kernel_api.py:8-15,36-39` |
| Dashboard | 内部登录（`/internal/dashboard/auth/login`） | `internal_dashboard_api.py:142` |

**缺口评估（service account / API key）：**
1. 现有 `AgentApiKey` 是**数据面单 Agent key**：仅绑定一个 `agent_id`，无 action/project/角色作用域，无轮换语义（只有删+建），`rate_limit`/`expires_at` 字段存在但限流未执行（`key_service.py`）。
2. 管理面没有 M2M 凭据：外部团队服务端直连只能拿**云账号 AK/SK**（账号全权），或经 BFF 受信身份头委托。
3. 受信业务身份头（`X-AgentEngine-*`）纯约定信任，无签名/令牌证明委托链。
4. 结论：**缺口为 🔴 级**——需要新凭据实体（service account：作用域、过期、轮换、审计归属）+ 生命周期端点 + 鉴权执行点，加法字段无法在现有端点上解决。

---

## 6. 会话 / 事件面对双客户端的可用性

| 能力 | 现状 | 双客户端可用性 |
| --- | --- | --- |
| canonical Session | `Session{id, agent_id, user_id, identity_namespace, business_tenant_id, subject_type, subject_id, title, summary, tags, revision, runtime_sync_status, created_at, updated_at}`（`conversation.py:31-44`） | ✅ TS/Python 一致可用 |
| canonical RuntimeEvent | `Event{EventId, SessionId, Author, EventType, Content, StateDelta, SeqId, Metadata, Timestamp, InvocationId}`（`chat_actions.py:892-909`）；`SeqId` 单调递增 | ✅ 一致可用 |
| 事件拉取对账 | `ListSessionEvents`（`AfterSeqId/BeforeSeqId/Offset/Limit/EventTypes`）+ `ListSessionMessages`（游标） | ✅ 可替代 SSE 续传做对账 |
| SSE `id: seq` | **未实现**（`_sse_event` 只发 `event:`/`data:`，:911-918）；kernel Responses 流内部有 `id: {seq}`（`agent_kernel_responses_stream.py:216`）但不覆盖会话订阅面 | 🟡 加法可行（帧内补 `id:` 行不破坏现有消费者） |
| `Last-Event-ID` 续传 | **未实现**（全仓无 `Last-Event-ID` 命中）；续传 = `SubscribeRunEvents.AfterSeqId` / `SubscribeSessionEvents.after_seq` 查询参数；`SubscribeRunEvents` 另有断连兜底全量对账（:3841-3860） | 🟡 可将 `Last-Event-ID` 作为 `AfterSeqId` 的加法别名；`SubscribeSessionEvents` 为 kernel 流透传，改动受合同 digest 冻结约束 |
| 心跳 | `: heartbeat` 注释行（`SSE_HEARTBEAT_INTERVAL_SECONDS`） | ✅ |
| 前端绑定 | `SetLangfuseAuthCookie`（浏览器 Cookie）、`GetAgentUiBootstrap` 偏 UI；核心会话/运行/事件端点均为纯 JSON Action，**无浏览器会话依赖** | ✅ ksadk-python / studio 服务端均可直调（走 KOP V4 或受控服务身份） |

---

## 7. 🔴 项说明（加法字段解决不了的）

1. **端点级：`FetchAgentInstanceStatus` 的失败态语义**（`agent_actions.py:4524-4525` 把 `FAILED` 改写为 `STARTING`）。
   加法字段无法让该端点可信表达失败——任何新增字段都与被改写的 `Status` 自相矛盾，必须**行为级变更**（停止改写/新增失败终态语义）。
   现阶段绕行：`GetAgent.Basic.Status/Phase/Message` 可信。
2. **需求级：管理面 service account / API key**。需要新凭据实体 + 生命周期端点（创建/列出/禁用/轮换）+ 鉴权执行点，
   不是任何现有端点加字段能承载的（现有 `AgentApiKey` 作用域模型不同，改其语义 = 行为级变更）。
3. **需求级：配额 / 限流**。全仓无执行实现（`ApiKey.rate_limit` 列未使用）。限流是请求-时间行为，
   没有字段能让现有端点拒绝超量请求，必须引入执行层（网关/中间件）行为 + `429` 语义。
4. **需求级：管理面审计查询面**。写侧部分存在（`AgentControlAudit`、`SessionTagsUpdated`），但暴露给外部团队查询需要**新端点**（如 `ListAuditEvents`），
   加法字段只能补充现有响应体，无法提供历史审计的检索面。

其余全部缺口（kind / origin / deployed_by / labels / runtimeRef / resourceRefs / capabilities / deploymentRef /
Idempotency-Key / typed error / provenance / 停止语义 `DesiredState` / revision 乐观锁 / SSE `id:`+`Last-Event-ID`）均可通过**加法字段/加法头**解决，
不违反"保留现有接口、只允许加法"硬约束。归属管理的"各自管理"建议以加法过滤字段显式表达，不改 `ListAgents` 现有默认行为、不建两套可见性 API。

---

## 8. 测试-0903 合同用例清单（双客户端各跑一遍）

> 目标：conformance 合同用例，C1 = agentkit-studio（spec/零代码），C2 = ksadk-python（high-code）。
> 每条用例两个客户端**各执行一遍**，断言同一合同；`交叉` 表示两客户端互相校验。

| 编号 | 用例 | 步骤（同一套 API） | 关键断言 | C1 | C2 |
| --- | --- | --- | --- | --- | --- |
| T01 | 创建（各自输入形态） | `UploadCode`(C2) → `CreateAgentProduct`（C2: `DeploymentType=Code/ManagedRuntime` + `CodeConfig.Checksum`/`ManagedRuntimeConfig.ManifestSHA256` + provenance；C1: `ManagedRuntimeConfig.Manifest` + `ComponentConfig` + `MemoryConfig`） | `Code=0`；返回 `AgentId/InstanceId`；回显 `kind/origin/deployed_by` 与传入一致；身份字段（labels/identity）原样透传 | ○ | ○ |
| T02 | 部署 → 状态 | 轮询 `GetAgent` / `FetchAgentInstanceStatus` / `ListInstances` 直到 ready | `Phase=Ready`、`ReadyReplicas=Replicas`、`AgentKernelReady=true`、`DeploymentRef` 回显稳定；**失败场景**必须出现失败终态（守卫 4524 行改写问题） | ○ | ○ |
| T03 | 更新 | `UpdateAgent` 局部改（C1: 换绑定模型/Skill；C2: 换 `CodeConfig`）+ `ExpectedRevision` | 未传字段不变；乐观锁冲突返回稳定错误码；更新后 `deploymentRef` 变化可观察 | ○ | ○ |
| T04 | 会话与运行 | `CreateSession` → `RunAgent`（`ApiFormat=responses`）→ `ListSessionEvents` | Session 归属正确；事件 `SeqId` 单调；`run_status` 终态可达 | ○ | ○ |
| T05 | 事件续传 | `SubscribeRunEvents` 中途断开 → 以 `Last-Event-ID`/`AfterSeqId` 重连 | 不丢不重（按 `SeqId` 去重后与 `ListSessionEvents` 全量一致）；`id: seq` 存在 | ○ | ○ |
| T06 | 停止 / 删除 | 停止（`UpdateAgent.DesiredState=stopped`，待加法）→ `DeleteAgent`（软删默认；再验 `HardDelete`） | 停止后不可 RunAgent；软删后 `ListAgents` 默认不见、审计保留；硬删后 API Keys/版本清掉 | ○ | ○ |
| T07 | 幂等重放 | 同 `Idempotency-Key` 重放 `CreateAgentProduct`、`UpdateAgent`、`DeleteAgent` 各一次 | 重放返回与首次相同 `AgentId`/结果，不产生第二个资源/订单；`(account,action,key)` 冲突载荷不同 → 稳定错误 | ○ | ○ |
| T08 | 归属过滤 | 各自创建 1 个 Agent → `ListAgents` 带 `Origin/Labels/DeployedBy` 过滤（交叉：互查对方） | 各入口只"默认"看到自己的（显式过滤表达）；交叉查询能按 filter 找到对方资源，但无越权写 | ○ | ○ |
| T09 | typed error | 构造 400/401/403/404/409/422/429 各一 | 响应含 `Error{code(稳定字符串), message, source, scope}`；`Code` 数字语义不变；同一错误两客户端解析出同一 code | ○ | ○ |
| T10 | 权限 / service account | 以 service account key（🔴 交付后）调用管理面；越权访问对方 Agent | 合法调用成功且审计归属到该 SA；越权返回 403 + scope 说明；key 轮换后旧 key 401 | ○ | ○ |
| T11 | 合同版本 | 请求带当前 `Version`/`ContractVersion` + 一个未来未知字段 | 未知字段被忽略（加法兼容）；响应回显合同版本；降级场景给出明确错误 | ○ | ○ |
| T12 | 控制与幂等基线 | `SubmitAgentControl(interrupt)` + `SubmitInteraction` 同 `IdempotencyKey` 重放 | receipt 去重（现行为回归）；审计行落库 | ○ | ○ |

执行矩阵：12 用例 × 2 客户端 = 24 次执行，外加 T08 交叉 2 次；T09/T11 覆盖全部错误与合同面。
当前（审计时点）预期失败项：T02 失败终态断言、T05 `id:/Last-Event-ID`、T07 幂等、T08 归属过滤、T09 typed error、T10 service account——对应 §4/§7 缺口。

---

## 9. 附：证据索引

- 统一包络/请求上下文：`app/api/v1/actions/base.py:33-114,127-165,256-341`
- Agent 合同：`app/api/v1/actions/agent_actions.py:195-560`（配置 Schema）、`:2222-2660`（Create/List/Update/Delete/Get 请求）、`:2663-2900`（GetAgent 响应）、`:3262-3296`（UploadCode/状态）、`:4463-4560`（Delete/状态处理）、`:4543-4620`（ListInstances）
- 幂等现状：`app/api/v1/actions/agent_control_actions.py:54`、`interaction_actions.py:40`、`app/models/agent_instance.py:59-73`、`internal_runtime_api.py:58`
- 错误结构：`app/core/error_translation.py:68-280`
- SSE/事件：`app/api/v1/actions/chat_actions.py:892-918,3686-3878`、`agent_control_actions.py:155-233`、`app/services/agent_kernel_responses_stream.py:216`
- 鉴权：`docs/网关鉴权说明.md`、`docs/数字员工托管Agent接口文档.md:19-56`、`app/internal_agent_kernel_api.py:8-39`、`app/schemas/agent_control.py`
- 合同冻结：`app/contracts/agent-kernel-v1.json`、`app/models/agent_instance.py:20-46`
