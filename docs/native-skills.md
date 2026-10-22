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
