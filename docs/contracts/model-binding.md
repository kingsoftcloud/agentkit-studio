# Model binding contract

AgentKit Studio owns the model and credential form, while DSH remains the chat
runtime. A successful read or save of the Studio form reconciles every enabled
model profile in DSH's public `llm-pi-ai` settings namespace. Each profile gets
an independent route and credential reference; the profile marked `default`
also becomes the DSH default model for new sessions.

- route: `agentkit-studio-<profile-id>`
- protocol: `openai-completions`
- model catalog: the configured model id and display name
- endpoint: the configured OpenAI-compatible base URL
- credential reference: the profile's `credentialName` when a key is entered

The Studio page writes these routes through `remote.settings.mutate` and writes
each key through `remote.credentials.set`. DSH's official
`ui-model-selection` plugin stays enabled, so its composer model seat reads the
same provider directory and new sessions can select any configured model.
Existing sessions keep their own selected model snapshot by design; create a
new session or use the model selector to change it.

Studio Node Host resolves global/workspace defaults and cloud credentials. A
masked Host credential is never copied into the browser. When a key already
exists only in the Host session, the Host synchronizes it into DSH's credential
service without returning the secret to the UI; an explicitly entered key is
written to the same Host-owned store.

## Codex Agents

Runtime and model provider are independent choices. A local Codex Agent still
runs the pinned official `codex app-server` when a Studio-configured gateway
model is selected. The Host resolves the exact provider route and its model,
then uses Codex's public `model_providers` configuration with `wire_api=responses`,
`requires_openai_auth=false`, and HTTP streaming. The credential is supplied by
a per-child environment variable; argv, Session state and the personal Codex
configuration file do not contain the key. Two gateways with the same model
name must keep their own URL/key pair.

The native model picker can switch a Codex session between its native Codex
catalog and configured providers. Agent creation/editing lists both catalogs;
an explicitly bound configured model does not require an OpenAI account model
catalog lookup. Unknown, disabled or ambiguous provider routes fail explicitly,
and a model outside that provider's catalog is not silently replaced.

Each profile exposes **Codex 模型接口** in Settings:

- **Responses · 直接连接** (default) uses the provider's native Responses API.
- **Chat Completions · 本地协议代理** starts an authenticated, turn-scoped
  loopback endpoint and translates Codex Responses requests to Chat Completions.
  This is an explicit profile capability, not a retry after an arbitrary failure.

The proxy reuses Studio's existing model transform and SSE handler. It maps
namespaced functions, raw custom tools and client tool search in both directions,
retains tool call IDs and reasoning history, and streams text, reasoning (when
provided upstream), usage and completion events. Unsupported server-side tools
fail explicitly. Codex hosted web search is disabled only for this Chat path;
bound MCP search remains available. It does not reproduce OpenAI's hosted image,
search, connector authorization or every Responses feature. Tool-capable upstream
models are required. `previous_response_id` is unsupported: callers must supply
full history. Cancellation closes the upstream request and proxy listener.

Rate limits stay provider-owned: a 429 is surfaced as an actionable model limit,
not a missing adapter or an automatic switch to a different model. Existing
Codex plugins can add substantial tool/context tokens; passing a small probe
does not guarantee a resource-heavy turn fits the gateway TPM budget.

The proxy pins the selected model/URL/credential, rejects browser-origin requests,
and uses a random local bearer token. Upstream secrets stay in the Host; the child
process receives only the local token. No global Codex config or global proxy
setting is modified. The proxy ships inside Studio's plugin and desktop package;
users do not need a separate cc-switch installation.

Design reference: [cc-switch's Codex routing guide](https://github.com/farion1231/cc-switch/blob/main/docs/guides/codex-deepseek-routing-guide-en.md).
The adapter is implemented in Studio JavaScript using the existing public Codex
provider contract; cc-switch is not a packaged runtime dependency.

Run an isolated real CLI check (consumes model usage, no personal plugins or
OpenAI login copied):

```sh
node scripts/verify-codex-configured-model.mjs --execute --model deepseek-v4.1-flash
node scripts/verify-codex-configured-model.mjs --execute --model deepseek-v4.1-flash --api chat-completions
```

The input is an ordinary card question. The check independently asserts a
system-only output marker, an actually executed tool's random return value,
and incremental text. `--profile ID` selects a particular configured provider.
Official provider contract: [Advanced configuration](https://developers.openai.com/codex/config-advanced/).
