# Native cloud execution: provisioner contract

Status: implemented for the managed-assistant runtime image as capability 1
(bounded cloud command and script execution). The executor launcher, file/egress
policy, grant gating and deployment evidence are documented in
[assistant-cloud-computer.md](assistant-cloud-computer.md); this page keeps the
provisioner contract and the reasoning that a capability string alone is not
isolation. It is not a claim that arbitrary cloud instances are isolated enough
for general commands: the shipped profile remains `workspace-managed/v1`, and
only instances whose image advertises the executor capability expose the tools.
Its separate native schedule admission is described in
[assistant-permission-model.md](assistant-permission-model.md).

## What the repository actually establishes

- `src/studio-deployments.mjs` requests one Container deployment with an AgentId,
  persistent storage and scaling 1/1. `src/deployment-images.mjs` describes an
  image digest and capabilities. Neither describes the image's UID, mounts,
  namespaces, credential boundary or executor provisioning.
- `src/bundle-host.mjs:prepareBundleHost` starts the Host with the runtime token
  and the bundle's required model/resource credentials. Its receipt binds a
  directory and bundle digest; it does not attest OS isolation.
- Native local tools can share that Host's process/filesystem world. Scrubbing
  secret-looking environment names from a subprocess is insufficient when the
  same UID can read parent process state, Host files or control sockets.
- Native `workspace-write` constrains file effects. It is not a network policy,
  and native reads are not confined by default. Native `danger-full-access`
  removes that file-effect restriction. Setting it on the current shared Host
  would not produce a private full-access cloud workspace.

The actual image Dockerfile/entrypoint, provisioner and deployment-specific
network policy are not supplied here. A release descriptor or a new capability
string cannot substitute for them.

## Smallest viable topology

Keep the trusted Host, model transports, Session persistence, runtime token and
resource credentials in the control world. Give each independently fenced
assistant conversation/Session a separate executor realm, with only that
Session's writable workspace and runtime temporary storage. A deployment may
share immutable toolchain image layers; it must not share readable Host or other
Session state, parent process namespaces, Docker sockets or cloud metadata
credentials. Full access means full access **inside this executor**.

The pinned DSH source already supplies a POSIX execution transport:

- `packages/ssh/ssh`: `SshConnection`, deployment-owned OpenSSH alias,
  `ready`, helper digest/protocol verification and lease cleanup.
- `packages/ssh/fs-ssh`: `SshFileSystem`.
- `packages/ssh/subprocess-ssh`: `SshSubprocessRuntime`, including PTY handles.
- `packages/ssh/sandbox-ssh`: `SshSandboxProvider`.
- `packages/ptc-runtime/ptc-runtime-node`: accepts `ctx.ssh.ptcLaunch`.

Compose these providers and the ordinary native tools in the same isolated
Cordis realm. Tools that capture their registration Context must be mounted in
that realm too: replacing an Agent field while leaving a global Bash tool
bound to local providers is not a remote executor. Do not fall back to local
providers when a remote service is absent. FS, subprocess, sandbox and PTC must
resolve to the same SSH connection and workspace. Keep the ordinary native tool
catalog, rather than replacing it with a six-tool product list. Host-management
plugins and credential tools do not become workspace tools merely by sharing a
registry.

SSH is an available integration seam, not isolation by itself. Its remote helper
and processes share the remote world's OS limits. The provisioner must establish
the executor realm before supplying the connection. Native SSH has no automatic
provisioning, reconnect, operation replay or Windows endpoint.

## Minimum provisioner inputs and outputs

The following fields are the private provisioner contract now implemented by
the Studio runtime image. They are not new accepted browser arguments or a
public API.

### Trusted inputs

1. Ownership tuple: tenant/owner reference, cloud AgentId, frozen buildId,
   deployment version and durable Session id; a unique executor id and generation.
   Resolve these from the authenticated deployment and Session, not model input.
2. Immutable executor image and helper artifact digests; absolute remote workspace;
   the exact provider composition and requested native permission preset.
3. Host-side SSH configuration reference. For `SshConnection` the existing native
   configuration is `host`, `helper`, `helperHash`, `workspace`, and `launch`:
   `{ kind: 'executable' }`, or `{ kind: 'node-script', node: '/absolute/node' }`.
   Script PTC additionally requires paired `bootstrapPath` and `bootstrapHash`.
   Install the helper/runtime read-only outside the workspace and replaced temp
   mounts. Configure bounded `requestTimeoutMs`, `maxPending`, `maxFrameBytes`
   and `leaseMs` using the native validated ranges.
4. Executor resource limits and a deployment-enforced network policy identifier.
   Ordinary public egress may be enabled; Host management, other tenants and
   cloud metadata endpoints must remain unreachable. Supply a positive egress
   test endpoint and synthetic negative-test endpoints for that policy.

The deployment system injects the alias, existing authentication material and
known-host entry only into the trusted Host. Never return private keys, stream
capabilities, runtime tokens or resource credentials to the browser/model, and
never mount them into the executor. The native connection requires strict host
key checking, batch mode, no agent forwarding and no inherited forwarding.
No key generation or real SSH connection is part of this change.

### Verified output

A trusted provisioner returns the ownership tuple, executor generation, image and
helper digests, host-key identity reference, workspace identity and network-policy
revision. It also returns a lifecycle handle for that exact executor. The Host
must compare the ownership tuple with its frozen receipt and durable Session,
then await the native connection's `ready` result (protocol, helper digest,
runtime kind, executable and canonical workspace). The native hello has no tenant
identity claim; the provisioner must bind it to the approved endpoint.

Persist a versioned, secret-free execution receipt containing these facts plus
provider identities, effective Session policy and acceptance-report digests.
The browser receives only status, generation and capability summaries. A static
receipt digest does not prove isolation; deployment provenance and live startup
checks are mandatory. An old or mismatched generation cannot authorize work.

## Ready, stop and restart behavior

1. Start behind the existing synchronous startup deny guard. Provision the realm,
   mount the paired services, await native plugin/Fiber readiness and `ssh.ready`,
   then verify the ownership/generation and run the synthetic checks below.
2. Create the Session with its immutable executor cwd. Confirm the effective
   native sandbox and approval folds, then publish a ready execution capability
   and release queued work. Missing/mixed/local providers, helper mismatch,
   unverified ownership or failed checks keep it unavailable.
3. Native full access is the `danger-full-access` preset: sandbox
   `danger-full-access`, approval `never`. A custom full-access/`ask` preset asks
   only when a tool requests approval. It does not understand shell semantics or
   automatically require approval for deletion, external sending, payment or
   permission changes. Product copy must not promise such coverage.
4. On stop, deny new work first, cancel turns, terminate and join processes/PTYs
   and streams, dispose the SSH connection, and flush Session writers. Only then
   detach or erase the matching workspace. SSH transport loss makes remote
   outcomes/cleanup unknown; lease expiry initiates remote cleanup but is not a
   client-observed success. Never replay an ambiguous write automatically.
5. On restart, re-provision/reconnect explicitly with a new generation and rerun
   admission before restoring work or dispatching timers. Reuse storage only
   after its owner and Session match. Preserve durable Session policy; never adopt
   an arbitrary pre-existing cwd or silently upgrade an old assistant.

## Product integration points and remaining changes

- Extend the deployment provider and image entrypoint with the private provisioning
  contract above. Today `studio-deployments.mjs` only creates the outer Container;
  there is no executor lifecycle call to wire into it.
- Add executor-bound Session creation/restoration at
  `personal-assistant-runtime.mjs` / `assistant-permission-model.mjs`, with a
  distinct versioned execution profile after the provider is implemented.
  Leave managed workspaces operational when that deployment capability is absent.
- Replace local `node:fs` assumptions in workspace ownership validation,
  `assistant-workspace-tools.mjs` and `assistant-workspace-attachments.mjs` with
  the remote provider/owned-transfer contracts for the new profile. An SSH cwd is
  not a Host path. Native Web workspace consumers likewise need provider-aware
  file access; the upstream SSH documentation currently supports headless/custom
  compositions, not transparent existing Web workspace access.
- Full execution can become the new-assistant default only for a version whose
  image/provisioner and live startup checks supply it. Existing assistants need
  an explicit upgrade entry: show old/new capabilities and workspace handling,
  then create a new deployment generation/profile (and a new Session when cwd
  changes). Roll back to the prior working version on failed readiness; do not
  reinterpret an old Session as full access.
- Display the verified live Session policy separately from image readiness and
  historical records. A read-only screenshot may depict a genuinely legacy or
  cold Session; neither a stale UI nor a successful policy upgrade can be inferred
  from the screenshot alone.

## Reproducible controlled acceptance

These checks require no production account. The first two can run with the
current source/profile. Later steps are a release gate for the missing executor
image/provisioner, not evidence supplied by this patch.

1. Run `node --test tests/assistant-schedule.test.mjs tests/assistant-permission-model.test.mjs` and
   `AGENTKIT_DSH_ROOT=/path/to/dsh node scripts/verification/verify-assistant-permission-model.mjs`.
   They exercise real native tool admission, late schedule service startup,
   Session-local CRUD, definition/body replacement refusal, restore and disposal.
   They do not establish arbitrary-code isolation.
2. Build/pack Studio into a disposable DSH profile and run
   `scripts/verify-personal-assistant-host.mjs` with its isolated homes. This
   checks controlled model tool round trips, persisted timers and Host restart.
   Run the normal `index.apply` startup verifier as well, since that script's
   Host-bootstrap mount alone does not prove normal plugin startup.
3. On a provisioner test machine, use a pinned SSH helper archive and existing
   synthetic test identities. The upstream `scripts/verify-ssh-helper-artifact.ts`
   verifies relocated artifacts/provider composition; `scripts/verify-ssh-helper-ssh.ts`
   exercises a disposable OpenSSH container. The latter creates disposable test
   identities, so it is an explicit test-environment step, not something run by
   this change. Record image, archive, source and report digests. These upstream
   transport checks do not replace the following deployment boundary checks.
4. Provision two synthetic owners/Sessions A and B plus a separate Host. Put
   distinct random non-secret canaries only in Host state and B's workspace.
   Through A's ordinary native model tool pipeline, write a random file with
   `write`, read it via Bash, mutate it with Bash, and read it via `read`; exercise
   glob/grep, PTY and PTC if advertised. Verify the observed cwd/identity and
   file hash match the same executor, not the Host or B.
5. From A, attempt reads/writes of Host/B canaries and inspect only the synthetic
   fixture's `/proc`/mount/control-socket exposure. Assert no Host token/credential
   canary exists in executor env/files/process state. Verify allowed egress to a
   controlled endpoint and blocked access to controlled management/other-tenant
   endpoints and metadata routes. Test exact deployment firewall rules, including
   redirects and alternate resolved addresses; a DSH file policy is not evidence.
6. Break the helper digest, binding, generation and one provider at a time;
   startup and timer restoration must stay denied without local fallback.
   Kill the synthetic SSH transport during a file mutation and long-running
   process. Record ambiguity, verify remote lease cleanup from the provisioner,
   then explicitly restart and reattest. Test late completion after stop, stale
   receipt reuse and workspace retirement while a writer exists. No operation
   may auto-replay; retirement cannot report complete before quiescence.

Release evidence must include both positive native-tool results and negative
boundary/lifecycle results for the exact deployed image. Until those artifacts
and the provisioner implementation are available, changing only the default
permission enum would enable a materially different, unverified Host boundary.
