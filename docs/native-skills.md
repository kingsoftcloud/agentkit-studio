# Native Skills ports

The Node Skills ToolPort defines `list_skill_spaces`, `list_skills`,
`load_skill`, `preview_skill`, `search_skills`, and `execute_skills`.
These modules are not yet mounted by the production Studio gateway. Existing
Studio skill registration continues through its current path. This is an
implementation milestone, not completed Skills parity.

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
The initial Studio service wrapper is provisional; its pagination and service
semantics are being replaced by a separately reviewed adapter before mounting.
The workflow backend, output artifact budgeting, cloud service protocol, per-Build
binding and production permission integration still require final assembly
and validation.

## Verification

The following targeted modules passed on Node 26.5.0 and Node 22.19.0,
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
