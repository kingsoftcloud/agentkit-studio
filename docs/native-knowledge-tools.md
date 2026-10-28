# Node knowledge tool checkpoint

Reference: `ksadk-python` `feat-ksadk-harness-2`, commit
`355059d78e47ed764bbdb3606304cdf34e9838a3`, especially
`ksadk/knowledge_base/{langchain_tool,tool,service,client}.py`.

`search_knowledge_base` now has a model-facing Node implementation in addition
to the existing Host context injection. Both serve the actual bound dataset;
context injection alone does not replace the tool. The existing Native local
Memory tools and the optional legacy `load_memory` / `save_memory` are separate
capabilities. This checkpoint does not finish their migration.

## Admission and configuration

Each local Harness, DSH Native or Codex preset captures enabled knowledge-base
resource IDs in `agentkit.studio-knowledge-bindings/v1`. Credentials and arbitrary
resource properties are excluded. The tool uses those IDs in order. With no
Agent dataset, the explicitly configured legacy `KSADK_KB_DATASET_ID` is used.
Absent configuration returns `knowledge_not_configured`, never a Python fallback.

Host activation captures a Node control-plane client, including its private
credential configuration. Later global configuration edits do not redirect an
admitted invocation. The public service binding contains only IDs, retrieval
parameters and a connection digest. It enters the Native plugin-lock and Host
capability digests; changing the datasets, transport or retrieval settings cannot
adopt an existing Run. The v1 Native origin recovery capsule is unchanged.

Python retrieval defaults are retained: `intelligence_search`, top 5 and reranking
off. `KSADK_KB_TOP_K`, `KSADK_KB_SEARCH_METHOD`, `KSADK_KB_RERANKING_ENABLE` and
`KSADK_KB_SCORE_THRESHOLD` are captured. An explicit zero score threshold enables
threshold filtering. The underlying Python `search_knowledge` accepts `top_k`;
its LangChain tool wrapper accepts only `query`. Node additionally exposes the
optional `top_k` override.

Queries are sent intact, including leading/trailing spaces and Unicode; there
is no silent 250-character truncation. A service-side rejection stays an error.
Successful records use the Python `[n] (来源: document) content` format, followed
by `答案` when present. Empty results are `未找到相关知识库内容。`.

`KSADK_KB_ACCESS_KEY`, `KSADK_KB_SECRET_KEY`, `KSADK_KB_SESSION_TOKEN`, region and
explicit endpoint overrides are supported, with common `KSYUN_*` credential and
region fallbacks. Secrets remain in the Host client closure. The transport uses
the existing Node signer and API version `2025-11-14`. The shared
[AICP resource connection](native-aicp-connections.md) additionally supports
`public`, `inner`, `internal`, `auto` and `detect` network selection, explicit
SDK host/port/scheme and the captured `KSADK_TRAFFIC_SOURCE` header. A custom SDK
origin is Host configuration and is signed only for resource actions; setting
the generic Studio server URL does not grant this authority.

## Lifecycle and recovery

The neutral `agentkit.studio-knowledge-tools/v1` service owns formatting and
transport. Native execution uses its actual tool intent, lease and execution
fence through the full registry pipeline. DSH Native and Codex use
`agentkit.dsh-node-knowledge/v1` with their original Agent, Session, call, revision
and Build. They do not fabricate a Native Run or fence.

DSH persists the full original call and binding before transport dispatch.
Finished duplicates and cold-process calls return the original receipt.
Interrupted executing calls remain uncertain and are not automatically queried
again. Lookup is read-only; Native retains its own safe-read recovery rules.
Cancellation, timeout, retirement and authority loss stop result publication;
noncooperative late responses and rejections remain observed. The complete
pre/guard/post policy pipeline and its model-facing redaction remain intact.

Malformed envelopes, service errors and transport failures return stable typed
errors. They cannot be converted into successful empty searches or echo raw
transport errors. These typed failures and rejecting structurally malformed
segments are explicit Node differences from the permissive Python text wrapper.
When multiple datasets are bound, a failed dataset cannot publish earlier partial
records as a complete successful search.

## Verification scope and remaining work

Directed tests cover the actual Native kernel and SQLite receipt, DSH intent
before dispatch, binding drift, cancellation, retirement, post-policy output,
the actual signed Node request, distinct-PID cold receipts, and SIGKILL during
real HTTP followed by cold recovery with no repeated query. The packed Host
fixture additionally exercises the real authenticated preset, SessionController
and DSH Native/Codex ToolRegistry with Python unavailable in its Node/bash PATH.

This does not prove online cloud availability, fresh dependency installation,
real model/Codex CLI execution, all Frozen/automation/deployment entry points, or
the full migration. Endpoint selection, explicit internal schemes and signed
custom origins now have reference-derived matrix tests and actual local HTTP
proofs, including the Native Kernel/SQLite gateway and packed DSH Native/Codex
Host with a distinct-PID restart. TCP outcomes in mode matrix tests are controlled;
real cloud reachability and all deployment network combinations remain unproven.
Optional legacy
Memory backends, remaining Python bridges, and the previously documented Skill,
E2B, A2A and product recovery gaps also remain. No default runtime switch is made.
