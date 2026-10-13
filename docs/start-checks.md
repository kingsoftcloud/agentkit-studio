# Start checks

Overview → Start checks reads the current Host configuration, model credential status and runtime catalog. Use **Check again** after reconnecting a Host. Saving model credentials also refreshes this section.

- **Confirmed** means the configuration read succeeded. It does not certify a model call or tool execution.
- **Missing configuration** means the Host explicitly reported a missing credential or an empty runtime catalog. The model action opens the existing credential guide.
- **Unknown** means the Host could not answer, timed out, or the older connection supplied only its default native runtime entry. An unavailable catalog is not an empty catalog.

Each read has an eight-second limit. A later refresh supersedes earlier results. The check retains status fields only; API keys, full settings documents and raw Host errors are not displayed. It does not call a model, create a session or change any configuration.

DSH Native, AgentKit Harness and Codex still use their existing session and runtime contracts. Verify model requests, file delivery and tools through an actual conversation before relying on a runtime for work.
