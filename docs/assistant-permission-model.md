# Managed assistant workspaces

New assistant specifications may explicitly select
`security.assistantPermissions.profile: workspace-managed/v1`. Missing and
unknown versions retain the legacy read-only policy. A changed product default
never migrates an existing Session or adopts its existing working directory.

## Authority and lifecycle

`createAssistantPermissionModel` requires the dedicated runtime receipt and its
matching bundle digest. The configured AgentKit and DSH homes must be real sibling
directories under that receipt-owned root. `newSessionCwd(sessionId)` creates a
private `assistant-workspaces/<owner digest>/files` directory, with its ownership
record outside the model-accessible files directory. The native Session must be
created with this exact immutable `cwd`.

Studio calls `installAssistantStartupGuard(ctx, env)` as the first synchronous
step in plugin startup, before loading presets or runtime factories. It guards
already-live candidates and registers `agent/created` immediately; an injection
hook also scans when native services become available. Candidate denial uses
only the expected home-directory shape, even if the bundle digest is missing or
malformed. It performs no I/O and grants nothing; receipt and digest validation
are mandatory before any grant. The model repeats this fence for independent callers and replaces
each agent-scoped native `tools.guard` without an unguarded interval, before
asynchronous receipt checks. Until validation finishes,
all tool calls are denied. The serial native creation listener awaits ownership
validation before releasing queued work; a validation failure aborts creation
with denial retained. The guard also covers restored and timer-activated
managed Sessions. Other native Sessions are unaffected.

For a genuinely created managed Session, `ensure(agent, true)` uses the public
`/permission workspace-write` command and verifies the actual sandbox/approval
folds: workspace-write plus ask. This is an explicit durable product default,
not a temporary ask-and-restore trick. Subsequent ensures preserve the Session's
stored knobs, including a later never policy. Cold snapshots say that permission
is not yet verified; they never restore an Agent merely to display permissions.

Disposing the facade aborts pending approval requests and leaves a denying guard
on still-live Agents until their native scope is disposed. A replacement facade
installs its own deny guard before removing the preceding one. The runtime must
also revoke its live approval connection, and retirement must remove the owned
workspace only after native execution and persistence writers have stopped.

## Operations

The default routine set is the official native `read`, `read_image`, `write`,
`edit`, `glob`, and `grep` tools, when those tools are actually mounted. Definitions
are captured and checked again at execution. The maintained DSH dispatch-identity
patch additionally checks the reviewed definition immediately before its body
runs, so an around-dispatch middleware cannot replace it after admission. Read/write paths must stay in the private
workspace. Raw parent (`..`) path segments are refused before normalization to
avoid POSIX physical-parent aliases. Symbolic links, hard-linked files, special files, directory changes
outside that workspace, and explicit sandbox escalation are rejected.

Recursive search first rejects links and non-regular entries in a bounded tree
(maximum 10,000 entries and 64 levels); it refuses an oversized tree rather than
partially validating it. This check does not eliminate external OS races.

`glob` and `grep` execute the official fixed ripgrep argument templates. This is
bounded search execution, not a general-purpose shell. Arbitrary bash, PowerShell,
terminal commands, `run_code`, unknown MCP tools, and all other unlisted tools are
refused. File sandbox mode alone is not a network policy. No network execution
permission is inferred from workspace-write.

The default sensitive operation is the real
`assistant_delete_workspace_file` tool. It handles one regular single-link file
up to 20 MiB. Directories, recursion, links and outside paths are unsupported.
Before approval, its exact invocation records a preview containing relative path,
byte count, SHA256 and filesystem identity. The production Studio live approval
bridge shows that concrete action. Only the native ApprovalService's
`allowed-once` outcome grants that execution object permission; the monotonic
guard refuses any pre-execute listener that skips the approval step.

Before deleting, the tool synchronously rechecks the file identity, metadata and
contents. A changed file requires a new preview and approval. No await or shell
operation separates this verification from deleting that single file. Refusal,
disconnection, cancellation, a stale response or disposal cannot grant a retry.
External sending, payment and account/permission mutations have no default
implementation and remain unsupported. A future trusted Host catalog must bind
an exact tool definition and a concrete per-call approval description; client
metadata and MCP self-description cannot grant authority.

## Actual confinement limits

The pinned DSH sandbox vocabulary controls file modifications, not network or
process visibility. The native `fs-sandbox` provider expressly describes its
canonical-path checks as trusted-code containment with a residual filesystem
TOCTOU window. Its reads are not sandboxed by default. Studio's path guard adds
workspace-only read admission and catches links before dispatch; native writes
also revalidate confinement when they execute. Native workspace-write also
permits its platform temporary areas; Studio admission still limits requested
paths to the assistant workspace. Verification keeps outside-write fixtures
outside those temporary areas so this distinction is exercised correctly.

These controls assume the receipt-owned workspace has no hostile concurrent
writer with the same operating-system identity. They are not a kernel boundary
against such a process. In particular, a hostile external process can race path
replacement between checks and native reads or final unlink. Claims of full
filesystem isolation would require an anchored safe filesystem provider or a
separate execution world. This implementation neither weakens the host OS
sandbox nor enables arbitrary code to manipulate workspace links.

The upstream contracts reviewed are pinned to DSH commit
`687f282e8625c6b8d11ff58211a90524be2e4317`:

- `packages/sandbox/sandbox/src/index.ts`: file-only sandbox vocabulary
- `packages/sandbox/sandbox-policy/src/index.ts`: per-Session policy resolution
- `packages/interaction/permission-presets/src/index.ts`: durable preset command
- `packages/core/tools/src/index.ts`: pre-execute pipeline and monotonic guards
- `packages/fs/fs-sandbox/src/index.ts`: containment and residual TOCTOU contract
- `packages/fs/tool-fs-search/src/{glob,grep}.ts`: fixed subprocess argv
- `packages/interaction/user-approval/src/index.ts`: one-shot outcomes and audit

## Verification

Run `node --test tests/assistant-permission-model.test.mjs` for receipt,
ownership, legacy and cold-state contracts. With the pinned DSH checkout, run
`AGENTKIT_DSH_ROOT=/path/to/deepseek-harness node scripts/verification/verify-assistant-permission-model.mjs`.
The latter executes real native commands, tools, filesystem writes/edits/search,
monotonic guard rejection, native approval audit and the production live bridge.
It includes changed-file refusal, pre-execute approval bypass, symlink swaps,
restored-agent denial and disposal during pending approval. Controlled package
integration is separate from installed Host and browser acceptance.
