# Model binding contract

AgentKit Studio owns the model and credential form, while DSH remains the chat
runtime. A successful read or save of the Studio form reconciles one product
route in DSH's public `llm-pi-ai` settings namespace:

- route: `agentkit-studio`
- protocol: `openai-completions`
- model catalog: the configured model id and display name
- endpoint: the configured OpenAI-compatible base URL
- credential reference: `AGENTKIT_MODEL_API_KEY` when a key is entered

The Studio page writes this route through `remote.settings.mutate` and writes
the key through `remote.credentials.set`. DSH's official `ui-model-selection`
plugin stays enabled, so its composer model seat reads the same provider
directory and new sessions can select the configured model. Existing sessions
keep their own selected model snapshot by design; create a new session or use
the model selector to change it.

KsADK Host remains the source for global/workspace defaults and cloud
credentials. A masked Host credential is never copied into the browser. When a
key already exists only in the Host session, the user must enter it once in the
Studio form to place it in DSH's credential store; the model catalog itself is
still synchronized without that step.
