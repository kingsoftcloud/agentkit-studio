# Node Skill management checkpoint

Reference: `ksadk-python` `feat-ksadk-harness-2` at
`355059d78e47ed764bbdb3606304cdf34e9838a3`, `toolsets/skill_management.py`
and `studio/skill_discovery.py`. This checkpoint is implemented but does not
close the complete migration or all Skill parity requirements.

| Existing builtin | Node behavior |
| --- | --- |
| `skill_discover_github` | Search public GitHub or inspect a resolved immutable commit. Persist all candidate bytes before returning a token. |
| `skill_install` | Install selected bytes from that snapshot, without a mutable ref fetch or repository code execution. |
| `skill_bind_agent` | Validate installed ready resources and publish a new Agent revision using expected-revision comparison. |

Host bootstrap supplies the actual Studio Skill catalog and Agent store.
Native uses its own running intent, lease and execution fence. DSH Native and
Codex use their real Agent, Session, call, revision and Build; no synthetic
Native Run is created. Both paths keep registry policies, exact approval and
post-policy results. A missing Node management port cannot fall back to Python.

Contracts: `agentkit.studio-skill-management/v1`,
`agentkit.dsh-skill-management/v1`, `agentkit.github-skill-source/v1`.
The Native management binding enters the plugin-lock and Host capability
digests, which are checked when reconstructing an existing Run. The core state
machine does not depend on the GitHub client.

## Storage and recovery

State lives outside the model workspace. Inspection tokens belong to one Agent
and survive restarts. Immutable installed content belongs to the shared Studio
catalog, allowing two Agents to install the same resource at the same path.
Explicit overwrite retains earlier resource versions for frozen references.

The execution owner saves its complete intent before dispatch. Inspection
snapshots, package files and catalog publications are fsynced. Catalog and
Agent publication serialize across processes. Binding compares the latest
revision; editable Agent pointers have separate inodes from immutable history.
Live authority is rechecked after preparation and lock waits.

Process death after publication but before receipt leaves uncertainty. A cold
duplicate returns the original receipt or uncertainty without repeating the
installation or revision increment. A failed owner store after publication
cannot truthfully report `executed:false`. This is not external exactly-once.
The complete product reconciliation UI remains an overall acceptance gate.

Binding returns `effective_from: next_run`. New preset admission reads the new
Agent revision; existing frozen Sessions keep their original presets.
Automatic same-Session revision refresh is not claimed here.

## Protocol and remaining parity gaps

The source uses reconstructed `https://api.github.com` endpoints, no credentials
or environment tokens, and `redirect:error`. Commit/tree/blob identities are
distinct. Blob Git SHA-1 and canonical wrapped base64 are verified, preserving
binary and hidden files. Root and nested Skills retain complete subtrees.
Symlinks and submodules inside selected Skills are rejected; a valid submodule
outside selected Skills does not invalidate the repository.

These differences remain mandatory audit items before lossless parity:

- Node currently permits 10,000 tree entries, 16 candidates, 256 files per
  candidate, 512 KiB per file, 8 MiB per inspection and 256 blob requests.
  Python permits larger Skills (1,000 files and 100 MiB each, with separate
  archive/unpack limits). These stricter bounds remain a parity gap.
- Python's excluded directories and per-candidate risk/error presentation are
  not fully reproduced. Node currently fails inspection on an invalid candidate.
- The Git API replaces Git ref advertisement and repository ZIP downloads.
  URL `/tree/<ref>/<subdir>` uses a single ref segment; slash-bearing refs use
  the explicit `ref` argument with a plain repository URL.
- Resource IDs and inspection serialization use new Node formats. Historical
  Python database compatibility was excluded by the user.

## Evidence scope

Directed tests exercise actual Agent/catalog files, Native kernel/SQLite and
registry dispatch, exact binary content, denial/cancellation/authority loss,
cross-process publication, cold Node processes and actual SIGKILL after install
and bind publication. Controlled GitHub transport covers immutable identities,
malformed trees, digest/size limits and noncooperative network cancellation.

Packed Host verification uses actual DSH Native/Codex presets and registries,
cold Host restart and Python-unavailable PATH. GitHub responses are controlled
protocol fixtures. It does not establish online GitHub availability, fresh
dependency installation, model/Codex CLI execution, all Frozen/deployment
consumers or the final default switch. The full migration remains incomplete.
