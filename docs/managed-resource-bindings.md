# Managed resource bindings

This is a source candidate, not an enabled cloud resource release. Public DSH
resource admission remains closed until authorization, scoped access, lifecycle
handling and real cloud acceptance are complete for all three runtimes.

The optional `resources` declaration supports one `knowledge_base`, one AICP
`memory`, multiple `skill_spaces` and multiple `mcp_servers`. References contain
`id` and optionally `region`. Both lists allow at most 16 unique IDs. The earlier
single `skill_space` remains compatible, but cannot be combined with the plural
field. Inline credentials and commands are not accepted in these references.

```yaml
resources:
  skill_spaces:
    - id: space-first
    - id: space-second
      region: cn-beijing-6
  mcp_servers:
    - id: mcp-first
    - id: crm
      endpoint: https://crm.example.test/mcp
      transport: http
      env_refs:
        Authorization: MCP_CRM_TOKEN
```

The definition loader creates existing platform plugin bindings. Preset admission
and conversation resource preparation enumerate every enabled Skill Space,
deduplicate by resource ID, and retain failures from any required Space. Native,
Harness and Codex share this enumeration. This proves neither cloud authorization
nor actual Skill script execution.

Direct MCP entries use an Agent-local `id` and an HTTP(S) `endpoint`; `transport`
defaults to `http` and also supports `sse`. They project into the existing
`endpointUrl`/`envRefs` descriptor and require no platform MCP registration.
Endpoints cannot contain credentials, query strings, fragments, whitespace or
backslashes. Authentication headers use at most 16 separate credential references;
protocol headers and case-insensitive duplicates are rejected. References use the
isolated `MCP_` environment namespace and must include KEY, TOKEN, SECRET or
PASSWORD so existing public API masking applies. Platform/model keys are never
accepted as these references. Inject values separately through deployment settings.
The managed launcher forwards only credential names referenced by the declaration
into the DSH child process. Missing, masked or invalid header values fail before
state creation. Unreferenced variables are not inherited, and credential values
are not written to the managed identity receipt or model configuration.
The native DSH tool bridge resolves the full MCP descriptor from its Agent's
frozen revision or build before calling the same adapter. It rejects unknown
Agents, unbound IDs and ambiguous aliases. A tool request cannot supply a new
endpoint or credential reference. Existing platform ID-only bindings retain
their adapter lookup path.

Native, Harness and Codex tool execution forward the run's cancellation signal
to the MCP adapter. An aborted call rejects with the caller's abort reason and
keeps the shared connection open so the SDK can send its cancellation
notification; subsequent calls can reuse that connection. Remote cancellation
is cooperative: a local cancellation acknowledgement does not confirm that an
external tool stopped. Acceptance must also observe the remote handler stopping
without completing its work.

The portable ZIP path freezes Skill files while building the package. MCP
endpoints are frozen as descriptors, with sensitive headers represented by
credential requirements and injected separately at deployment. The managed YAML
path must resolve and freeze Skill versions and file digests in the cloud. Direct
HTTP/SSE MCP descriptors now reuse the existing adapter and credential resolution.
Real loopback protocol tests cover both transports, credential rotation and
refusing cached access after credential removal. This remains a source candidate;
public cloud admission, deployed image and real cloud acceptance are pending.
