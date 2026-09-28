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
