# Cloud computer: execution domain and cloud browser

Status: development plan (2026-10-22). Capability 1 (cloud execution) and
capability 2 (cloud browser) are being implemented behind new image
capabilities; no existing assistant gains them without an explicit image upgrade
and an explicit user grant. Capability 3 (local bridge) is design-only and opens
no network path.

This document is the companion to [cloud-native-executor.md](cloud-native-executor.md),
which records why the current managed workspace profile refuses arbitrary shell
and which executor topology the platform must eventually provide.

## Capability vocabulary

| Capability | Meaning |
| --- | --- |
| `personal-assistant-code-execution/v1` | Bounded command and program execution inside the assistant deployment |
| `personal-assistant-browser/v1` | One cloud Chromium session per assistant Session, operated through bounded tools |
| `personal-assistant-local-bridge/v1` | Paired local runtime tasks (design only; not implemented) |

Capabilities are advertised by the image catalog release. The client offers a
grant only when the current image advertises the capability, the deployment
version is ready, and the native `workspace-managed/v1` permission model is
active. Existing assistants keep their current profile until the user clicks the
in-place image upgrade.

## Why the managed assistant cannot run commands today

`workspace-managed/v1` admits only the native `read`, `read_image`, `write`,
`edit`, `glob` and `grep` tools, the fixed `web_search`/`web_fetch` templates,
the schedule tools and one approval-only workspace file delete. Any `bash`,
`pwsh`, `terminal` or PTC `run_code` is refused, and the policy snapshot says
`arbitraryShell: false`.

Admitting the native tools directly would be wrong: the Host process holds the
runtime token, model gateway credentials and the DeepSeek search credential in
its environment, and native shell tools spawn children with that environment and
the Host's UID, network namespace and filesystem view. A model-written command
could read `/proc/<host>/environ`, call the deployment runtime API with the
Host's token, or reach in-cluster services. The executor therefore cannot be the
Host's own shell; it must be a separately confined child process that the Studio
plugin itself launches.

## Execution domain (capability 1)

The Studio plugin registers two approval-scoped tools per managed Agent once the
assistant has the `code-execution` grant and the image advertises the
capability:

- `cloud_bash` — run one shell command string.
- `cloud_run_code` — run one JavaScript (Node) or Python program.

Both tools spawn a child through a single confined launcher; the model never
receives a shell on the Host process.

### Confinement

- Environment: a fixed whitelist (`PATH`, `HOME`=workspace, `LANG`, `LC_ALL`,
  `TERM`, `TMPDIR`=sandbox temp, `PYTHONDONTWRITEBYTECODE=1`). No inherited
  variables, no `DSH_*`, no credentials, no proxy unless the capability phase
  enables egress.
- Filesystem: bubblewrap (`bwrap`) with read-only `/usr`, `/bin`, `/lib`,
  `/lib64`, `/etc/ssl`, `/etc/passwd`, `/etc/hosts`, a fresh `/proc`, a tmpfs
  `/tmp`, and the assistant workspace mounted read-write at its real path. No
  Host state directory, no `/var/run/secrets`, no deployment volume metadata.
- User namespace: `bwrap --unshare-user --unshare-pid --unshare-ipc
  --unshare-uts --die-with-parent` so the child cannot read the Host process
  environment under the same UID.
- Network: phase 1 executes with `--unshare-net` (offline). Phase 2 adds an
  allowlisted egress proxy and removes the network namespace only for the
  browser and for commands that opt in.
- Resources: wall-clock limit (default 120 s, maximum 300 s), stdout/stderr
  each capped at 64 KiB, file output capped by the workspace copy tool, process
  group `SIGKILL` on timeout or abort, and no background jobs or PTY sessions.
- Availability: if `bwrap` is missing or unprivileged user namespaces are
  denied, the tools refuse to run; they never fall back to an unconfined child.

### Explicitly unsupported in v1

Background processes, terminal/PTY sessions, package installation (offline),
mounting host paths, outbound network, arbitrary MCP tools, and any write
outside the assistant workspace.

## Cloud browser (capability 2)

The image ships Chromium and an egress proxy; the Studio plugin launches one
Chromium process per managed Session and drives it over CDP (no additional
Playwright dependency in the bundle).

Tools: `cloud_browser_open`, `cloud_browser_snapshot`, `cloud_browser_click`,
`cloud_browser_type`, `cloud_browser_press`, `cloud_browser_screenshot`,
`cloud_browser_download`, `cloud_browser_close`. Every result is bounded:
snapshot text ≤ 32 KiB, screenshot ≤ 4 MiB at 1280×800, downloads ≤ 64 MiB and
only into `workspace/files/downloads`.

### Network enforcement

Chromium runs with `--proxy-server=socks5://127.0.0.1:<egress-port>` and a
private `--user-data-dir`. The image's egress proxy resolves every destination,
refuses loopback, private, link-local, multicast, cluster, Kubernetes and cloud
metadata ranges on both IPv4 and IPv6, allows only ports 80/443, applies connect
and idle timeouts, and never forwards credentials. The plugin additionally
refuses obviously internal literals before navigation (the same early refusal as
`web_fetch`) and checks the final URL after redirects. CDP request interception
is a third layer for direct-IP requests; the proxy is authoritative.

Browser state: one browser per Session, disposed with the Session runtime;
closed on assistant disable, grant revocation, image upgrade or deployment
rollout. Cookies and logins are not restored from the Session log.

## Authorization and UI

- The assistant record gains `security.assistantPermissions.grants` with the
  allowed values `code-execution` and `browser`. Existing assistants have no
  grants.
- Setup and settings show one switch per granted capability with a plain
  description of what it means, the current limits, and a revoke action. Revoke
  kills child processes and closes the browser immediately.
- Every `cloud_bash` / `cloud_run_code` call is an item in the transcript with
  the exact command, exit status, and truncated output. Every browser action is
  likewise recorded. Commands and screenshot metadata are never hidden.
- The policy snapshot exposes `execution` (`bounded-cloud-exec/v1` or
  `disabled`), `shellTools`, `browserTools`, and the actual `network` mode
  (`offline` or `public-web-only`).

## Local bridge (capability 3, design only)

The user decision on 2026-10-22 is one pairing and one authorization: pair the
device once with a short-lived code, then authorize the bridge once with an
explicit scope (workspace paths, maximum runtime, command classes). The cloud
tool `send_local_task` then delivers a bounded task to the paired desktop app,
which shows the task, runs it in a local DSH Session, streams progress, and
returns the result to the cloud conversation. Either side can revoke at any
time; every task is audited on both sides. This milestone implements none of
this and opens no inbound or outbound device channel.

## Phases

| Phase | Content | Exit evidence |
| --- | --- | --- |
| P0 | Capability contract, confined launcher, `cloud_bash`/`cloud_run_code`, policy/grants, unit tests | `node --test` green; launcher refuses unsafe cases |
| P1 | Image v3: Chromium, Playwright-free CDP, egress proxy, bwrap probe, smoke | image build + proxy/executor smoke evidence |
| P2 | Browser tools, Session ownership, integration tests | CDP tools pass against a real Chromium |
| P3 | Client UI/consent, `.7` macOS+Windows release, catalog default, upgrade | both feeds and `studio/latest` at `.7`; upgraded assistant snapshot advertises grants |
| P4 | Real deployment acceptance | commands run confined; browser reaches public sites only; cluster/metadata tests denied |

## Acceptance checks

- `env`, `/proc/1/environ`, `/var/lib/agentkit`, and the runtime token paths are
  unreadable or absent inside the executor.
- Commands cannot write outside the assistant workspace; symlink and `..`
  escapes fail.
- A runaway command is killed at its timeout; output is truncated at the cap.
- The browser cannot reach cluster services, metadata endpoints, loopback or
  private ranges; downloads land only in the workspace with a size cap.
- Revoking a grant terminates child processes and the browser within one tool
  boundary.
- macOS and Windows desktop builds ship in the same batch.
