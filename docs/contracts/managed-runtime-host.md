# Mounted declaration Host

Status: implementation candidate. Container-side Session/Run/history Actions and
the public Server/Gateway hop are implemented and locally TCP-verified. Target
cloud deployment, real authentication and Pod/PVC acceptance remain incomplete.
Existing portable input remains supported through the same Host.

`scripts/start-agent-manifest.mjs --manifest FILE --state DIRECTORY --installation DIRECTORY`
starts the installed, pinned DSH CLI from a platform declaration. It uses the same
profile preparation, signal forwarding, preset admission, Session controller,
automation runner and Responses transport as the portable launcher. It does not
create a ZIP, Build, source project or a separate transcript store.

The Server-canonicalized YAML is verified by `managed-runtime-manifest.mjs` before
state is prepared. Only the currently consumed fields are admitted; resource
fields fail explicitly. The platform must inject:

- `AGENTENGINE_MANAGED_RUNTIME_NAME` and `AGENTENGINE_MANAGED_RUNTIME_VERSION`.
- `AGENTENGINE_MANIFEST_PROTOCOL=runtime-manifest/v1` and the exact mounted byte
  SHA-256 in `AGENTENGINE_MANIFEST_SHA256`.
- Stable `AGENTENGINE_AGENT_ID` and immutable `AGENTENGINE_AGENT_VERSION_ID`.
- `OPENAI_BASE_URL`, `AGENTKIT_MODEL_API_KEY` and a dedicated
  `AGENTKIT_RUNTIME_TOKEN` of at least 24 characters.
- Optional `AGENTKIT_RUNTIME_HOST` / `AGENTKIT_RUNTIME_PORT` for this Host listener.
  `AGENTKIT_MANAGED_CODEX_API` selects `responses` (default) or `chat-completions`.

Identity comes from the platform environment, not from caller-supplied YAML.
Bundle and manifest identities cannot be combined. The installed DSH version
must equal the Studio package's required version before launch.

Configured Codex model selection preserves an explicit `codexApi` value through
the runtime adapter. Both `responses` and `chat-completions` use the authenticated
turn-scoped loopback proxy with the selected model and credential. The Responses
route preserves native tools and SSE; its compatibility boundary omits only an
absent reasoning body serialized as `content: null`. The proxy bounds upstream
silence at two minutes, refreshing the deadline on received bytes. Active streams
may exceed that interval; caller cancellation and the outer turn limit still
apply. Native account model selection retains its existing path.

The dedicated state root is bound to one Agent. Each platform VersionId selects
`versions/<SHA256 of VersionId>` and pins its runtime name/version and manifest
digest. A changed manifest under the same VersionId fails. Reusing the same
version restores DSH state; another version uses another directory, while
rollback can return to the original directory. This does not implement routing
old sessions to concurrently running versions.

Configuration files contain credential references, not credential values. The
child inherits an explicit environment allowlist and isolated HOME, DSH_HOME,
CODEX_HOME and XDG directories. It does not import personal Node options, model
keys, plugins or Codex configuration. The definition store is read-only.

The authenticated `/v1/agentkit/runtime` probe reports the AgentId, VersionId,
manifest digest, runtime name and runtime version with format
`agentengine.managed-runtime/v1`; it does not invent a BuildId. Response and
conversation handles bind the platform version and manifest digest. The existing
portable format and Build-based handles keep their previous behavior.

Managed requests other than the identity probe/health endpoint must carry the
Server's private `X-AgentEngine-Target-Version-Id` and
`X-AgentEngine-Manifest-Sha256` headers. Both must match the loaded definition or
the Host returns `RUNTIME_DEPLOYMENT_CHANGED` (409) before native state/work is
created. Public callers use the existing AgentEngine Actions; Server/Gateway owns
this internal hop. This fences the race between a readiness probe and routing to
a retiring Pod. Portable Build-based callers do not require these headers.

Local candidate validation covers all three execution modes in an installed
Linux DSH image: only YAML input, first streamed delta before model completion,
multi-turn context, complete-run replay after process restart without another
model invocation, input conflicts and cancellation closing the model connection.
The model is a controlled loopback fixture. Early checks used a package overlay;
the 2026-10-19 candidate built from runtime source commit `309fa56` also passed
the mounted-YAML and public TCP checks with its installed package/launcher, with
no application overlay. It is a local image, not a registry/catalog publication.
Process restart over the same local state is not Pod/PVC validation.

The managed Host adds the existing `/agentengine/api/v1/` Actions:
`GetAgentUiBootstrap`, `ListAgentModels`, `CreateSession`, `GetSession`,
`ListSessions`, `DeleteSession`, `RunAgent`, `CancelRun`, `ListSessionMessages`
and session-scoped `ListSessionEvents`. RunAgent and `/v1/responses` use the same
runner and stream projector; there is no second execution path. Background runs,
checkpoints, scoped cancellation, event overview and nonzero legacy Offset are
not advertised or silently approximated. Tags remain the Server directory's
responsibility, including its existing revision checks.

Every managed data request requires the private runtime bearer and the complete
trusted business carrier: identity namespace, business tenant, subject type and
subject ID. The platform hop must rebuild these headers after authentication.
Body UserId/AccountId and metadata cannot grant authority. Native user keys use
the same canonical SHA-256 derivation as Server/KsADK. The bearer is a private
runtime-hop credential; it is not a browser or public API key.

Only metadata is stored under `agentkit/managed-sessions`: public/native IDs,
principal digest, immutable platform version, native source creation identity,
history epoch, lifecycle phase and request-ID mapping. Metadata writes use a
private atomic file and durability barrier. Message bodies remain in DSH.
Creating the same session is serialized and idempotent. A lost native source
cannot silently become an empty conversation. Each session admits one active
run; another returns `RUNTIME_SESSION_BUSY` before execution.

History uses the public native persistence handle's bounded read API, without
activating an Agent or parsing private files. Public seq is native seq plus one.
Messages pages retain complete invocation groups; event pages obey their event
limit and recover the enclosing turn when a cursor falls inside it. Epoch,
snapshot and source must agree on continuation; incompatible cursors return
`HISTORY_RELOAD_REQUIRED`. A read is bounded by 8192 events / 16 MiB; budget and
source failures are errors, not successful empty history. Native request headers
and discarded assistant attempts do not become public messages. Tool history
uses the existing Name/Args/Result/Status/ToolCallId Web contract.

Completed runs wait for native durability before their terminal response.
Cancellation and failure also settle native writers before the terminal frame;
an unconfirmed barrier returns failure. Session deletion first blocks new runs,
cancels active work and flushes before a durable tombstone hides the session and
rejects old handles. This is logical deletion: native bytes remain retained for
controlled Agent/version cleanup. It does not claim per-session physical erase.

The shared HTTP run transport writes bounded JSON lifecycle records to stdout:
`runtime.run.started` followed by `runtime.run.completed`, `runtime.run.failed`
or `runtime.run.cancelled`. Records identify the Agent, immutable version (or
portable Build), public session and invocation, runtime run, timestamp, duration
and safe failure code. Completion follows the native history durability barrier.
They contain no prompt, assistant output, tool arguments or credentials.
Logging failures do not change model execution, streaming or persistence.
The existing cloud collector exposes these through `GetAgentLogs` with
`LogType=Stdout`; this does not produce an application log file for `LogType=Log`.
These lifecycle records cover the public RunAgent/Responses transport. The
separate personal-assistant native submit carrier is outside this logging path.

The installed-image proof also covers these Actions, public/native invocation
mapping, source/epoch/snapshot paging, subject isolation, cancellation history and
logical deletion for all three executors. It is still a loopback-model container
proof. Effective startup overrides and independent manifest verification have
local installed-image evidence. Target-cloud startup/readiness, resources,
Server/Gateway authentication and directory synchronization, real model/tool
behavior, PVC and Hosted UI acceptance remain required before catalog enablement.
The current Docker LinuxKit command-sandbox checks failed before execution for
DSH Native and npm Codex; actual native preproduction-node proof is still needed.

## Managed resource transport candidate

Managed Hosts use `managed-resource-client.mjs` for cloud resource operations.
The Server-controlled `AGENTENGINE_RESOURCE_SERVER_URL` is forwarded through
the private launch plan. Requests carry only the workload token, platform
VersionId and manifest digest; personal cloud AK/SK are not a fallback. The
client exposes only the KB/Memory/MCP and Skill operations used by the existing
Node adapters. Local Studio and ZIP deployments retain their existing client.
Cloud resource bindings require this private root before native state is
created; direct MCP descriptors do not acquire that dependency. Skill Spaces
consume all declared pages, with explicit incomplete/duplicate-page errors.
Managed Space identity comes from the binding kind rather than UUID spelling.

The Server resolves bindings and access ownership from its version snapshot,
rechecks resource visibility, and serves only the frozen Skill index/version.
The managed Skill cache rechecks access before returning a cached definition.
These are source and controlled HTTP/ASGI/DB checks, not cloud acceptance.
Server-side snapshot production has separate controlled API/DB evidence;
real upstream protocol verification, installed-image integration and the complete A10 remain pending;
the public resource admission guard is still closed.
