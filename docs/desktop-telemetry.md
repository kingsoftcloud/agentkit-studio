# Desktop telemetry

AgentKit Studio desktop shows a data and privacy notice before any telemetry leaves the device. You can view the receiving address and change your choices in **Settings → Privacy and data**. Studio works without a telemetry connection and does not need cloud or model credentials to send an enabled report.

| Setting | Data sent | Initial state |
| --- | --- | --- |
| Basic statistics | First and daily opens, desktop version and platform, and startup and update outcomes | Off unless the official distribution is configured to enable it after notice |
| Crash statistics | Fault source, phase, and a fixed error category | Off |
| Local Run statistics | Local runner type, final status, duration and available token counts | Off |

An enabled report carries a random installation ID and comes from the one desktop sender. Prompts, conversations, credentials, tool input and output, account identifiers and complete diagnostic files stay outside telemetry. The [v1 event schema](../src/telemetry/schema-v1.json) lists the accepted fields.

**View queued data** shows the local request body. **View fixed sample** shows an example with synthetic identifiers. Both previews run locally. The diagnostics section shows send failures, dropped records and other counts for the current app process. **Stop all telemetry** prevents new reports, cancels in-flight requests and clears the queue. **Clear local telemetry data** also removes the identifier and resets the counts. To request deletion of data already received by the official instance, contact the distributor through its private support channel with the displayed installation ID. Official event records expire after 90 days. The server operator controls retention on self-hosted instances.

You can set `AGENTKIT_TELEMETRY_DISABLED=1` to turn all categories off. To self-host, set `AGENTKIT_TELEMETRY_ENDPOINT` to your collector's HTTPS `/v1/logs` URL. A different receiver asks for a new choice and starts a new queue. The client sends Studio's v1 records as OTLP/HTTP JSON.

## Packaging

The Studio packaging step accepts a public JSON policy through `AGENTKIT_TELEMETRY_RELEASE_FILE` or `AGENTKIT_TELEMETRY_RELEASE_POLICY`. The macOS and Windows workflows read the `STUDIO_TELEMETRY_RELEASE_POLICY` Actions variable. With an empty variable, the official receiver is unconfigured. An approved first-party distribution can set `defaultBasic` to `true` together with its HTTPS endpoint and approved `policyRevision`. Build with `AGENTKIT_TELEMETRY_BUILD=off` to omit the sender.

The two release workflows offer `qualify_telemetry` to exercise signed installations against a loopback HTTPS receiver. These fixture candidates have dedicated artifact names for test builds.
