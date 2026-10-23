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
未绑定任何空间时不挂载这组工具。所有实际调用通过原 DSH 工具注册、权限与审批管线，
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
服务认证头。组件状态如实显示已挂载工具和空间；**工作流执行后端仍未接入**，
`execute_skills` 当前明确返回 `skill_runtime_unavailable`，不把指令加载当作执行成功。

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
