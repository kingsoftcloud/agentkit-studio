# Native Skills ports

The Node Skills ToolPort defines `list_skill_spaces`, `list_skills`,
`load_skill`, `preview_skill`, `search_skills`, and `execute_skills`.
These modules are not yet mounted by the production Studio gateway. Existing
Studio skill registration continues through its current path. This is an
implementation milestone, not completed Skills parity.

These six names cover the legacy toolset surface. The formal Python Native
profile additionally has `skill_catalog`, `skill_read_manifest`,
`skill_read_instructions`, and `skill_read_resource` with Run-scoped disclosure
and receipt-based recovery. Resource plugins separately expose
`read_skill_resource`. Those distinct surfaces, child inheritance, and pinned
resource Build admission are still required for complete Studio Skills parity.

## Trusted execution boundary

Every call supplies the exact formal definition, complete Native Run identity,
original AbortSignal, and a trusted synchronous `assertCurrent(request)`.
`forAgent` binds an exact session and scope. The Studio provider additionally
binds Agent revision and an optional Frozen Build. A changed public definition
cannot change the internal formal. Calls recheck the original request and live
authority around asynchronous authorization, service access, loading, and
workflow execution. Service adapters receive the same guard for every page.

The production authority adapter, `createNativeToolAuthority`, reads the real
SQLite lease, current pending tool intent, call, fence, and locked definition.
A registered DSH tool or an earlier approval alone does not grant authority.
The final gateway integration must supply this adapter and retain the DSH
permission pipeline.

## Loader and workflow ports

`loadSkillFn` receives the selected `skillId`, `versionId`, `spaceId`, name,
content hash, and signal. A successful return must include matching identity
and hash alongside `content` and `rootDir`. This attestation is a trusted
loader responsibility: the ToolPort does not treat hashing SKILL.md as proof
of a cloud archive hash. `createNativeSkillLoader` implements exact version
selection, bounded streaming, archive SHA-256, stored/DEFLATE ZIP extraction,
unique manifest selection and model-invocation policy. It receives the live
ToolPort guard and rechecks it throughout loading. Its shared downloader is
used by existing Studio pre-Run cloud resource admission; mounting the exact
loader in the Native gateway remains integration work.

The content-addressed cache validates every expected file and rejects added
files or symlinks, including after a competing materializer publishes the same
digest. Verification reads at most the expected file length plus one byte.
Concurrent publication does not excuse verification of the actual winner.
Signed archive URLs are not included in network errors. The trusted service
chooses the HTTPS archive endpoint; the downloader sends no control-plane
credentials and rejects redirects, URL user credentials, and fragments.

After `executeWorkflow` dispatch, exceptions, malformed or incomplete results,
request drift, or cancellation return `uncertain` with the original operation
locator. They do not assert `executed: false` or automatically retry. A known
nonzero exit remains an executed failure. A legitimate approval preserves
Native `approval_required` and its `interactionId`; an approval without that
identity is not a usable result.

Incomplete service listings cannot silently establish a complete selection.
The Studio provider now uses `createNativeSkillService` with the real signed
KOP GET transport, replacing its provisional one-page/deduplicating wrapper.
The adapter checks every page's space and total, duplicates, version changes,
page size, and page budget. A full page without a total continues; a short page
with a remaining total reports incomplete. Public listing keeps the service's
single-request protocol. The two listing actions have been added to the
explicit Skill-only action allowlist.
The workflow backend, output artifact budgeting, cloud service protocol, per-Build
binding and production permission integration still require final assembly
and validation.

## Verification

At the earlier guarded-port checkpoint, the following targeted modules passed
on Node 26.5.0 and Node 22.19.0,
72 tests per runtime, zero failures or skips:

```sh
node --test tests/native-skills-authority.test.mjs \
  packages/agentkit-harness/test/native-skill-tools.test.mjs \
  tests/native-dsh-skills.test.mjs
```

The authority test uses the actual NativeKernel and SqliteRunStore, commits a
successful tool receipt, reopens the database, and verifies that the original
request cannot call the service again after completion. The service and
workflow backends in these tests are deterministic ports. No online cloud,
production Host, browser, clean installation, or complete migration result is
claimed by this evidence.

A second targeted group passed on Node 26.5.0 and Node 22.19.0, 57 tests per
runtime, zero failures or skips:

```sh
node --test tests/native-skill-loader.test.mjs tests/skill-files.test.mjs \
  tests/local-resource-adapters.test.mjs tests/portable-bundle.test.mjs \
  tests/native-skills-authority.test.mjs
```

These tests use actual archives and cache directories. The production resource
adapter test stops a 50 MiB stream after reading 21 MiB against a 20 MiB limit,
without a Content-Length header, and cancels the remaining stream. Transport
responses are deterministic injected boundaries; this is not an online cloud
or whole-Host validation.

The subsequent service integration group passed 112 tests on each Node version,
with zero failures or skips:

```sh
node --test tests/native-skill-service.test.mjs tests/native-dsh-skills.test.mjs \
  tests/native-skills-authority.test.mjs tests/server-client.test.mjs
```

Its integration test runs the actual NativeKernel, SQLite store, guarded Studio
provider, Skill Service parser, signed AgentEngine client, downloader and ZIP
cache. Injected HTTP responses return a deterministic version and archive.
The committed successful receipt retains those exact instructions and version;
the archive request receives no control-plane authorization header. This does
not yet prove DSH registry/permission assembly or production gateway mounting.

## Complete explicit Skill bindings

Preset admission and local resource context now share `boundSkillResources`.
They resolve every enabled Skill Space alongside explicit Skills, preserve
binding order, and load each resource ID once. A later space failing to load
prevents admission of a partial preset. Disabled bindings are excluded and
malformed enabled Skill bindings fail explicitly.

The focused binding, local-runtime, preset-admission and portable-bundle tests
passed 76 tests on both Node versions. Related resource-check, Codex resource
context and Native authority tests passed another 15 on each. The new Frozen
case builds an actual Native archive, exports and imports three Skill resources,
deletes the source directory, and admits all three from target-only files with
the frozen engine pin retained. This proves multi-space admission and context
assembly; formal Native disclosure mounting and complete Frozen execution
remain separate acceptance requirements.
## 已准入的 Native Skill 文件来源

`createStudioNativeSkillSource` 现提供正式披露端口需要的只读 `manifest`、`fullText`、`resource` 和固定别名列表。它只接收宿主显式准入、允许模型调用的定义。`agentkit.studio-native-skill-source/v1` 绑定按别名排序的原 manifest UTF-8 SHA-256、完整目录摘要及每个相对文件的摘要；摘要不包含本机路径。完整目录摘要固定规范路径、文件字节、执行位和目录权限。冷重建必须严格匹配完整绑定，JSON 属性顺序不影响匹配。

目录扫描通过有界迭代限制为 2048 项、64 层和全包 64 MiB，单次资源返回最多 32768 字节。来源固定原根目录对象，拒绝根及祖先、后代符号链接和特殊文件；文件通过 `O_NOFOLLOW`、文件描述符身份及大小、时间、模式复查读取。每次披露前后重验全包；未读取文件的新增、删除、修改和执行权限变化也会失效。合法 `__proto__` 文件名保留为真正的资源键，错误不会公开宿主绝对路径。inline Skill 只提供原指令和 manifest，没有资源文件。

来源模块在 Node 26.5.0、22.19.0 各通过 31 项真实文件测试；独立探针另验证资源特殊键、规范 JSON 绑定重建、相同字节替换根目录和删除根后的路径脱敏。该模块尚未接入生产 Host 的正式四个披露工具或子任务 Skills 继承，当前证据不代表这些路径已完成。

## 远程 Skill Service 的生产组装

Native 整轮 Harness 现在按启用的 `skill-space` 资源绑定，以及 Host 的
`KSADK_SKILL_SPACE_IDS`（兼容 `SKILL_SPACE_ID`）、`KSADK_PUBLIC_SKILL_SPACE_IDS`
和 `KSADK_PUBLIC_SKILL_ALLOWLIST` 挂载六个正式工具：`list_skill_spaces`、
`list_skills`、`search_skills`、`preview_skill`、`load_skill`、`execute_skills`。
未绑定空间且没有启用本地 Skill 后端时不挂载这组工具。所有实际调用通过原 DSH 工具注册、权限与审批管线，
同时核对原 Native Run 的 SQLite 执行意图、权限和有效执行者；模型不能自行指定未绑定的空间。

`createNativeSkillConnection` 在 Host 启动时固定服务地址、区域、账户与凭据。
无专用覆盖配置时复用 Studio 已有的云端 Skill GET 接口及内部账户回退；全局配置
随后改变不会重定向已经接纳的连接，修改这些配置后须重启 Host。恢复绑定只保存
不透明摘要，不保存 AK/SK、token 或签名下载 URL；连接摘要变化时须按原恢复规则
重新核对，不能用新配置继续旧调用。

专用覆盖保留 Python 参考实现的 `KSADK_SKILL_SERVICE_URL`、`ENDPOINT`、`SCHEME`、
`TOKEN`、`ACCESS_KEY`、`SECRET_KEY`、`ACCOUNT_ID`、`REGION`、`API_VERSION`、
`SIGN_SERVICE` 配置（后十项均使用 `KSADK_SKILL_SERVICE_` 前缀），以及现有 KSYUN/KS3
凭据后备和显式 `KSADK_AICP_ENDPOINT_MODE=public|inner|internal`。
未显式选择 endpoint 时使用 Studio 配置，不在每次工具调用时探测网络并改变来源。
`pre-online` 固定为控制区域并保留 custom-source。

只有精确的三个 AICP 官方域名获得 KOP 签名；自定义服务使用配置的专用 Bearer token，
不向它签出全局云端 AK/SK，也不携带云端 session token。自定义 REST 的 `/docs`
转为 `/api/v1`，`/openapi.json` 转为所在根路径。REST 目录请求只传 `SpaceId`，
即使返回 100 项以上也不臆造分页；已知总数超过返回数量时报告
`pagination_unavailable`。服务元数据按 UTF-8 字节有界读取，并响应原取消信号。

加载端口下载真实 ZIP、检查 SHA-256 并使用现有安全原子包缓存。缓存位于工作区外，
按完整 scope 和 Session 隔离；Host 与 Session 关闭会撤销各自端口。下载请求不继承
服务认证头。组件状态如实显示已挂载工具、空间和实际执行后端；显式本地 Node
执行见下文 v3。未启用执行后端时返回 `skill_runtime_unavailable`。

新增定向命令：

```sh
node --test tests/native-skill-connection.test.mjs tests/native-remote-skills-host.test.mjs \
  tests/native-skill-service.test.mjs tests/studio-native-components.test.mjs
```

Node 26.5.0 / 22.19.0 各 57 项通过、无失败或跳过。实际本机 HTTP 请求通过生产
gateway、签名连接、加载器、NativeKernel 与 SQLite；DSH registry 是明确的测试替身。
Host 状态测试使用实际 Host 服务和账本，模型/会话传输边界有明确替身。
冷验证是 SQLite 重开，不能当作新 Host PID 证明。尚待完整工作流本地/E2B 执行、
实际打包 Host 的远程 Skills 与进程恢复、Frozen 配置与目标独立执行，以及全新无 Python
安装验收。本文早先各阶段的“尚未接入”描述只代表当时证据，不替代当前完整验收。

## 工具请求与取消边界 v2

`agentkit.native-skill-tools/v2` 封存完整可枚举 JSON 请求（原 `AbortSignal` 单独
固定），包含预算、交互及未来扩展字段；同步权限回调返回后也重新核验请求和信号。
读取、加载、审批和执行端口即使不合作地一直等待，原取消信号仍能结束等待，迟到
拒绝被观察。执行端口已经派发后保持未知结果，并保留原始完整运行、调用和已知
runtime 定位信息。错误路径使用独立深拷贝与深冻结的定位快照，后端不能修改它。

真正的派发前权限审批仍返回 `approval_required` 且不进入后端；已经进入执行后端的
回调自报审批需求，无法证明没有副作用，返回 `uncertain` 并保留交互证据。v2 工具
契约纳入远程 Skills 的 Host 绑定和 provider 摘要，防止旧配置无声继续执行。

父级独立复验 Claude 候选版本，保留了已知 runtime 定位信息丢失等失败日志后修复。
非合作端口测试等待真实进入闩锁后才取消，不释放阻塞端口帮助实现通过；取消结束后
再触发迟到拒绝。原核心 `scopeKey` 已使用无歧义 JSON 四域编码，审查中的斜杠拼接
碰撞假设不成立，没有按这个假设改动作用域算法。五个直接相关模块在 Node 26.5.0 /
22.19.0 各通过 103 项、无失败或跳过；其中真实 Kernel/SQLite 权限验证继续保留，
非合作后端用例是明确的端口反例，不当作线上服务或完整打包 Host 执行证明。

## Node 本地工作流后端与工具契约 v3

当前实现已接通显式 `KSADK_SKILL_RUNTIME_BACKEND=local_process`。没有选择后端且没有
模板时保持禁用；保留 `KSADK_SANDBOX_BACKEND` 后备选择，以及仅配置模板时选择 E2B。
`KSADK_SKILL_RUNTIME_TIMEOUT` 为 1–900 秒，默认 900 秒，
`KSADK_SKILL_PROJECT_NAME` 固定网页项目名，兼容参考变量 `KSADK_SKILL_ARTIFACT_PROJECT`。
`e2b` 走下面的独立后端；配置不完整时拒绝，不会改为本地执行。
组件状态只在后端和正式工具均已挂载时显示可用。

这层复用 Studio 现有的服务客户端、ZIP 解包器、已绑定本地 SkillSource 和持久命令
监督器。绑定本地 Skill 并启用本地后端时，无需远程服务或 Skill Space；绑定远程空间
时，按固定空间、版本和内容哈希获取包。没有新增服务进程，也没有依赖 Python/uv
实现工作流。Skill 自身脚本如需额外语言或软件，仍须由该 Skill 的运行环境提供。

确定性选择保留通用 `scripts/run-workflow.sh`、`web-artifacts-builder` 初始化及打包、
纯说明 Skill 和无入口的结果。网页项目已存在时报告冲突并保留原文件。纯说明结果
表示 Node 工作流求值完成，没有伪造脚本命令或进程回执；`workflow_status`、
`commands`、`command_ids` 和 sandbox 创建状态分别说明实际行为。

实际执行前先保存完整原请求、scope/Session/Run/Build/fence、配置及原 runtime 定位，
再把有界、无符号链接的包资源复制到单次调用目录。包版本、存档/清单和逐文件摘要
进入私有记录。每条脚本命令都在 Host 内重新验证原 Native intent 和权限，经过已有
命令策略后，先持久保存命令定位，再进入独立监督器。整体时限覆盖多条命令，进程
控制与退出核验使用现有机制。本地后端共享 Host 文件系统和网络，不是 OS 沙箱。

`agentkit.native-skill-tools/v3` 在派发前固定 runtime/command 定位；即使后端不响应取消，
未知结果仍保留原定位。后端不能替换这些身份。重复调用命中原记录；活跃并发调用
只附着原意图，宿主被杀后留下未完成记录会返回未知，绝不自动重发。完整请求包含
扩展字段并保留超出安全整数范围的精确整数。配置摘要包含后端、超时、环境摘要、
本地来源和工具版本。取消或权限丢失后，后续命令不会获得新的执行权限。
单次请求限制为 2 MiB，运行记录读写使用相同的 16 MiB 上限；超限请求在包加载和
意图创建前拒绝，避免写入重开时无法读取的记录。

产物仅收集工作目录内的普通文件，拒绝根及祖先符号链接和硬链接；文件枚举、深度、
总字节与文本读取有明确上限。文本以完整 UTF-8 边界截断；HTML 等非文本白名单
文件保留为实际产物。产物原始字节经独占创建、fsync 交付到工作区
`.agentkit/skill-results/<runtime摘要>/`，回执包含 SHA-256 和字节数。它不是与外部
文件编辑器共享的跨文件系统事务；中断的部分交付需要核对原调用，不能盲目重试。

本阶段八个直接相关模块在 Node 26.5.0 / 22.19.0 各通过 144 项，无失败或跳过；
之后仅按实际变更重跑受影响模块。包括真实本地进程与 SIGKILL、并发重复调用、
第二条命令前权限失效、真实 NativeKernel/SQLite 网关的远程和纯本地执行、完整
产物字节以及重开不重放。网关用例的 DSH registry 是明确替身，不能替代完整打包
Host 验收。后续请求上限和同步定位检查分别定向复验运行时 10 项、工具边界 27 项，
两个 Node 版本均通过，没有为这些微调重复运行全量。

实际打包 Host 工作流已通过：
`node scripts/verify-studio-native-skill-workflow.mjs --source <已构建维护 SDK> --archive <Studio.tgz> --keep`。
它使用实际生产 mount、认证 preset 接纳、ToolRegistry、SessionController、SQLite、
HTTP 模型和目录、可信测试证书的 HTTPS ZIP，验证一次脚本执行、精确文本/二进制
产物和原意图/fence/命令身份。Host PATH 与脚本 PATH 只提供 Node 和 bash。旧 Host
实际退出后启动新 PID，恢复历史不新增 HTTP 请求或脚本，不改变完整 Native/工作流/
命令记录和包文件；原效果文件仍只有一条。两个 Node 版本均通过。

此证明使用固定已安装依赖图与正常退出重启；真实 SIGKILL 的不重放由定向运行时
测试另行覆盖，不能合称打包 Host 已通过 SIGKILL。E2B 基础后端的后续接线见下节；
产品显式核对/清理、完整 Skill 专用事件、Frozen/部署入口及全新无 Python 安装仍待验收。

## Node E2B 工作流后端

`native-skill-e2b-runtime.mjs` 挂载 `agentkit.native-skill-e2b-runtime/v1`，文件传输端口为
`agentkit.native-skill-e2b-files/v1`。两者与原工具 v3、模板和连接摘要一起进入 Host 绑定。
组件状态沿用已有字段，通过 `request_protocol` 报告 Node 后端契约；启用本地或 E2B
Skills 时不会再传入该状态契约未声明的 `isolated` 字段。

选择 `KSADK_SKILL_RUNTIME_BACKEND=e2b`，提供 `KSADK_SKILL_RUNTIME_TEMPLATE_ID`
或 `KSADK_SANDBOX_TEMPLATE_ID`，以及明确的 `E2B_API_URL`（HTTPS 根地址）、
`E2B_DOMAIN`、`E2B_API_KEY`。Skills 的选择可独立于交互命令后端；只绑定本地 Skill
时不要求远程 Skill Service。模板须提供 bash 和 Skill 脚本自身依赖，后端不安装、
探测或启动 Python，也不在沙箱内运行另一个 agent 循环。SDK 在执行时才加载；
读取组件状态不会加载 SDK、创建或连接沙箱。凭证只在可信闭包/监督器配置中传递，
不进入模型回执、组件状态或调用记录。

原 Native 调用首先持久保存完整意图和稳定的 `e2b-skill:<摘要>` / command 定位，再
加载固定包、创建单次调用独占沙箱。真实沙箱 ID 作为 `remote_runtime_id` / `sandbox_id`
单独保存，不能替换工具契约提前保留的定位。生命周期所有者先保存创建意图才调用
SDK；迟到创建响应的真实 ID 仍留在原 owner 记录中。SDK `connect` 可能恢复同一个
沙箱，因此它属于已记录原调用内的执行操作，不用于历史展示或自动恢复探测。

包先在 Host 私有目录按逐文件摘要固定，再上传到独占的远程私有目录，保存可执行位。
上传批次预校验路径、规范 Base64、摘要、文件和总量上限；拒绝已有目标，核对 SDK
响应身份，并重新下载核验实际字节。每条准备、权限设置和工作流命令均先保存定位，
再通过现有 E2B 持久命令监督器执行。网页初始化与打包分别重新检查原 intent/fence，
初始化阶段的临时 bundle 不被当作最终产物。通用工作流收集 artifacts 与显式声明，
网页工作流按参考实现仅交付最终 bundle，不把 node_modules 下载回 Host。

文件操作固定原沙箱、files 对象、方法、完整请求、函数和 signal；严格同步授权必须
返回 true。SDK 调用与每次流读取前后复核；不合作的 Promise 或 reader.cancel 不会
阻塞取消，迟到拒绝被观察、迟到流被关闭。规范路径、祖先类型和权限、清单直接子项、
传输前后元数据、字节数与摘要均核对。上限为单文件 20 MiB、总计 50 MiB、4000 条
枚举和 500 个产物。这些是 SDK 可观察值的约束，不能承诺远程 OS 原子 no-follow，
也不消除同一沙箱用户并发替换文件的 TOCTOU 风险。

产物按原始字节写入 Host 私有目录，再复用本地产物交付端口。成功必须取得对原沙箱
清理的明确 true；丢失响应、真假不明或权限失效不会报告成功，也不会自动再次清理。
未完成、取消、超时和真实进程被杀后的调用返回未知，保留原沙箱/命令记录，不重新
创建、上传或执行。取消后的沙箱和结果未知的外部副作用需要显式核对流程；相应产品
界面尚未全部完成。迟到创建身份可从该 runtime 原目录的 sandbox owner 记录核对。

测试使用真实 Node 编排、SDK 适配器、生命周期和命令监督器、真实 bash 与精确文件；
E2B 控制面及 SDK 文件 API 是明确替身。原 NativeKernel、SQLite、HTTP Skill Service、
网关和组件工具也有实际接线用例。覆盖通用/网页/说明模式、退出 7、超时、取消、
并发冲突、清理未确认、完整请求漂移、真实 SIGKILL 及重开不重放。日志位于
`.artifacts/native-migration/skill-e2b-reviewed/`；这不是线上 E2B 或全新安装证明。
输入文件、完整 Skill 专用事件、线上创建/重连/清理、显式核对产品入口、Frozen 和
部署组合仍需完成，不从原迁移范围中移除。

## DSH Native / Codex 的 Node Skill 读取

这两条 runtime 的 builtin 注册现接入 `agentkit.dsh-node-skill-read/v1`：`list_skill_spaces`、`list_skills`、`search_skills`、`preview_skill`、`load_skill` 直接使用 Node。完整 Native 与 DSH 共用读取层、服务客户端和 ZIP loader；各自的外层保留真实执行身份与权限检查，不用伪造 Native Run/fence 接入 DSH。

Host 固定的 Skill 连接支持既有签名客户端与自定义 REST 服务；两种 runtime 共用激活时的连接快照。Agent revision 的 Space 绑定与原有环境配置共同决定可访问空间，公开目录必须匹配已绑定空间和显式选择的空间。工具参数不能更改地址、凭据或绑定。预览不下载；加载校验包摘要、版本、清单名称与路径，完整返回指令和资源路径，不执行、安装或绑定脚本。内容缓存位于工作区外，按真实 Agent/Session 分隔，重开和每次服务/缓存操作都复核原信号、调用身份与根路径。目录不完整和摘要不符明确失败。

DSH 的 pre/guard/around/post/result 管线继续生效；策略拒绝不发起服务请求，后置结果替换保留。取消、关闭及不合作网络 Promise 的晚返回不能发布失效结果或继续下载。`component_status` 只列出已准入的 Node Skill 工具，并区分 Space 绑定与工作流执行器就绪。

定向验证在 Node 26.5.0 / 22.19.0 各通过 75 项；新增公共空间反例和真正新 Node 进程重开缓存后，只重跑变化的两个模块，各 39 项通过。生产安装包通过真实 Host、SessionController、两个 runtime 的 ToolRegistry、HTTP REST 目录和可信 CA 的 HTTPS ZIP 验证，逐字节核对完整指令及脚本资源，证明加载时脚本未执行；每个 runtime 恰好 7 次服务请求、1 次 HTTPS 下载，拒绝调用为零新增请求。原文件、Web、命令、完整输出与审批断言保留。Host PATH 只有 Node，Python 路径不可用。此证据使用固定依赖图，不包含全新安装、模型/Codex CLI 对话或整个 Host 的崩溃恢复。

随后本地 `execute_skills` 的 DSH 接线已补齐，见下节。DSH 的 E2B 工作流也已接入 Node，见后节；Skill 管理工具、Browser、A2A、记忆/知识库等尚未全部替换 Python builtin。整个 Python fallback 尚未移除，整体迁移仍未完成。

## DSH Native / Codex 的本地 Skill 工作流

显式选择 `KSADK_SKILL_RUNTIME_BACKEND=local_process`，并准入 `execute_skills`，
生产 builtin 工厂会挂载 `agentkit.dsh-node-skill-workflow/v1`。本地已绑定 Skill
无需 Skill Service；远程包复用固定连接、空间、目录与校验下载器。调用先走原 DSH
pre/guard/around/post/result 管线及真实 sandboxPolicy/一次审批，再进入持久工作流。
`component_status` 报告已挂载的本地执行器，仍明确不具备 OS 隔离。
显式 E2B 选择使用独立的 DSH Node 后端，见后节；绝不降级为 Host 执行。

本地执行器共用 Native 的命令监督和包/产物算法，但身份契约独立：
`agentkit.dsh-local-skill-runtime/v1` 记录实际 Agent、Session、callId 和完整参数，
不制造 Native Run、turn 或 fence。定位为 `dsh-local-skill:<摘要>` 与原 command ID。
Host 的 revision、实际 Build ID、Skill 文件内容、运行设置和服务摘要固定在绑定中；
相同调用 ID 的参数或绑定变化不能读取旧成功回执。缓存位于工作区外，按 Agent/Session
隔离，每次访问检查目录身份；本地脚本变更也不能悄悄替换已准入内容。

工作流意图先 fsync，再加载包、固定文件和启动脚本；逐条命令也先持久化定位。
完成调用复用原回执，执行中或被杀的调用返回原定位的结果未知，禁止自动重跑。
审批和不合作网络调用也受整次超时/取消约束，晚批准或晚响应不能启动后续命令。
取消请求不把可能已发生的效果报告成“未执行”。未知调用的显式产品核对/继续仍待补齐。

定向回归五模块在 Node 26.5.0 / 22.19.0 各通过 52 项，随后仅重跑变化的工作流
模块，各 13 项通过。包含真实 bash、精确文本/二进制产物、新 Node PID 重开、
真实 SIGKILL 后不重跑、并发、重复、取消/Host 退出/超时、审批与源/缓存替换。
打包验证仍使用 `scripts/verify-studio-node-builtins.mjs`，在两个 Node 版本和两个
runtime 的实际 Host/SessionController/ToolRegistry 中执行远程包脚本：每个 runtime
恰好两次工作流目录/下载地址请求、一次脚本效果；重复和后置策略重放不增加请求。
加上五个读取工具，每个 runtime 总计九次服务请求、两次 HTTPS 下载。
Host/脚本 PATH 仅 Node/bash，Python 配置不可用；复用固定依赖图，没有模型/Codex CLI、
全新安装、线上 E2B 或整个打包 Host SIGKILL 的验收声明。


## DSH Native / Codex 的 E2B Skill 工作流

`execute_skills` 现在也支持 DSH 的显式 E2B 选择。它复用 Native 的 SDK 适配器、
工作流编排、逐命令监督、文件传输与产物交付，使用独立版本契约
`agentkit.dsh-skill-e2b-runtime/v1`、`agentkit.dsh-e2b-sandbox-owner/v1` 和
`agentkit.studio-dsh-e2b-host/v1`。持久身份来自真实 Agent、Session、call；不会构造
Native Run、turn 或 executionFence。原 Native 的契约、定位算法和记录字段保持兼容。

配置沿用上文 E2B 的显式 HTTPS API、domain、key、template 与超时要求。Skills 后端
独立于交互命令后端：`KSADK_SKILL_RUNTIME_BACKEND=e2b` 可以和本地 `run_command`
并存。状态只在配置通过实际工厂准入后报告 E2B 工作流就绪，不加载 SDK 或探测服务。
Agent revision、Frozen Build、后端及连接摘要均固定在绑定中；改变绑定不能复用旧回执。
凭据不写入记录。每个调用独占沙箱，创建、命令和清理前均保存意图；创建晚返回的
真实 ID 保留用于核对。未知、取消、超时或未确认清理均不会触发重新创建和自动执行。
显式沙箱采用必须验证 DSH 专用远程 metadata，且不代表命令效果已经核对。

定向用例覆盖实际 Bash 脚本、精确 Unicode/二进制产物、确认与未确认清理、脚本错误、
取消、Host 关闭、超时、并发、绑定漂移、真实子进程 SIGKILL、冷恢复及严格同步权限。
其中 E2B 控制面与文件 SDK 是明确替身，不能证明线上 E2B 或远程 OS 隔离。
受影响三个模块在 Node 26.5.0 / 22.19.0 各通过 44 项。初轮并行验证暴露的临时记录
扫描竞态已改为只读取工作流正式记录；超时测试仍要求脚本实际产生效果后才验收未知
结果，给进程启动留出时间，没有删除“不重跑”的关键断言。

打包验收命令为：

```sh
node scripts/verify-studio-node-builtins.mjs --source <已构建维护 SDK> --archive <Studio.tgz> --skill-backend e2b --keep
```

该模式通过实际安装的 E2B SDK 请求明确拒绝连接的 HTTPS 地址，验证两个 runtime 的
真实 Host/preset/ToolRegistry/SessionController、一次审批、HTTP Skill Service 与可信
HTTPS ZIP。创建失败保留原 DSH 意图和 unknown；旧 Host PID 确认退出后，新 PID 恢复
同一会话和 call，记录字节不变、零新增服务请求/下载/命令。未指定后端的原本地模式
保留真实脚本和精确产物断言。Host PATH 只含 Node/bash，Python 配置不可用；复用固定
依赖图，不代表全新安装、线上 E2B 成功、模型/Codex CLI 或完整产品验收。

DSH 的交互式 E2B 命令随后也已接入 Node，见 [E2B 命令](native-e2b.md#dsh-native--codex-的交互式-node-命令)。其他剩余 builtin、Skill 输入文件与完整专用事件，以及未知
结果的产品核对/清理入口仍需继续迁移和验收。完整 Python fallback 尚未移除。
