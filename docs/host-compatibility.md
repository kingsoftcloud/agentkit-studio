# Studio Host compatibility

Studio evaluates compatibility contract version 1 at Host startup and before native execution. The authenticated `host/compatibility` operation returns the current result; the browser's `__AGENTKIT_STUDIO__.hostCompatibility` field contains the result when its document is served. Neither operation exposes credentials, filesystem paths, or Session content.

The baseline comes from the running DSH package's public `getDshRuntimeVersion()` API and must equal `studio.plugin.json.requiredDsh`. Display metadata such as `AGENTKIT_STUDIO_DSH_VERSION` cannot authorize execution. An absent or unreadable runtime version fails the baseline check. A new DSH baseline requires an explicit manifest update and upgrade acceptance.

The integration contract version belongs to Studio's evaluator. It defines these required capabilities, each at version 1:

| Feature | Required Host capabilities |
| --- | --- |
| Agent preset admission | Preset registration and `pluginsFor` composition access |
| Local schedules, evaluations and channels | Preset admission, Session create/model/prompt/history operations, Agent initiator isolation, read-only command execution and approval policy |
| Frozen Build runtime | All automation requirements plus the Session Controller's explicit `promptFingerprintVersion: 1` |

The report includes required and observed baseline versions, required and implemented integration versions, observed capabilities, and availability and missing capabilities per feature. It reads the owning context's current services on each call. A registry replacement or removal is therefore visible immediately; another Host's successful check cannot authorize it. The probes inspect API availability without creating a Session, invoking a model, registering a preset or changing settings.

An incompatible operation reports `STUDIO_HOST_INCOMPATIBLE` with status 503 before native execution. Catalogs, model configuration and cloud management remain available. An incompatible frozen runtime does not open its HTTP listener; Studio keeps its management routes available and reports the missing capability. Other startup errors retain their existing failure behavior.

This runtime check detects missing APIs; it does not establish that every implementation behind those APIs is semantically correct. Build verification separately pins the upstream commit, maintenance commit, patched source tree and patch digest, and runs the affected Host tests. Real Host acceptance exercises persistence, replay, cancellation and scope teardown. The compatibility report never presents Studio's expected patch digest as the identity of the running Host.
