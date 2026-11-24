# KSXC Host configuration

KSXC is an execution target in the existing Studio DSH plugin. The Host starts a pinned KSXC App Server for the current caller. DSH owns the business session and passes its context to each ephemeral KSXC thread. The Host verifies the enterprise catalog and the App Server's effective model and provider before sending the user turn.

## Desktop

Set the following in the trusted Studio Host launch environment.

| Variable | Value |
| --- | --- |
| `AGENTKIT_KSXC_COMPANY_CONFIG_PATH` | Absolute path to the company configuration JSON with `baseUrl`, `code`, and `installerUrl`. |
| `AGENTKIT_KSXC_RELEASES_PATH` | Absolute path to the approved release lock. |
| `AGENTKIT_KSXC_WPS_GATEWAY` | Optional HTTPS origin for the KSCC Web authorization endpoints. Defaults to the company API origin. |
| `AGENTKIT_KSXC_ALLOW_HTTP` | Set to `1` for an explicitly approved HTTP test environment. |

The lock uses schema `agentkit.ksxc.releases/v1` and a `releases` array. Each entry contains `version`, `target` (for example `darwin-arm64`), `protocolProfile: "codex-app-server/v1"`, `archive` (an approved HTTPS tar.gz URL or an absolute staged path), `archiveSha256` and `sha256` (the executable digest). Use the official archive layout with `bin/codex`. Studio Settings installs the verified release, probes the version and handshake, and switches the active pointer. The OS profile owns the desktop credential record. Use **KSXC** in Studio Settings to connect, switch, or disconnect the enterprise account.

## Managed connection cache

The managed Host stores the Server-issued KSXC authorization record under the Agent-scoped mounted home at `~/.agentkit/studio/ksxc/runtime/connections`. The filename is a SHA-256 of the authoritative caller id. The record is encrypted with AES-256-GCM using a key derived from the platform runtime token, Agent id and company code. The PVC contains ciphertext only, with a `0700` directory and `0600` files. A different caller, Agent version, manifest or runtime token cannot open the record.

The Host reuses a valid cached authorization record after a Pod restart. A relay permit with an explicit expiry is discarded before expiry and redeemed again. A Server-issued record without an expiry may be retained until the Server invalidates the connection. The Server remains the authority for caller identity, current Agent version, manifest, connection binding and revocation. Disconnect removes the Server connection and clears the Host cache directory. The cache is a connection lease, not an Agent model preference, and it never enters the Agent manifest or Studio package.

## Managed Host

Use Node from the repository's `.node-version`, the DSH pin in `dsh-pin.json`, and the Studio tarball from the same source SHA. Pass the usual managed manifest identity, mounted state and private Runtime token. Set these additional values in the image or platform-owned bindings.

| Variable | Value |
| --- | --- |
| `AGENTKIT_KSXC_EXECUTABLE` | Absolute path to the pinned executable, with its packaged helpers installed beside it. |
| `AGENTKIT_KSXC_SHA256` | Executable SHA-256. |
| `AGENTKIT_KSXC_VERSION` | Expected KSXC version from the image build lock. |
| `AGENTKIT_KSXC_PROTOCOL_PROFILE` | `codex-app-server/v1`. |
| `AGENTKIT_KSXC_COMPANY_CONFIG_PATH` | Absolute path to the company configuration JSON. |
| `AGENTENGINE_RESOURCE_SERVER_URL` | Platform-projected private HTTPS Server origin. |
| `AGENTKIT_RUNTIME_TOKEN` | Existing platform credential for this Agent Host. |

`scripts/verify-agent-manifest.mjs` checks the mounted bytes against the platform SHA and probes the KSXC binary. `scripts/start-agent-manifest.mjs` validates the private Server origin before launching the installed Host. The company file is projected into an isolated runtime directory. The Host provides the caller's model credential only to the target App Server. The shell environment policy drops inherited values. The managed sandbox must isolate Host credentials from tool processes.

### Private resolver contract for integration

For model discovery and run admission, Server forwards the authenticated platform caller and its signed `agentengine.ksxc-caller/v1` permit. The Host checks that the permit names the same caller, Agent version and manifest before forwarding it to Server for signature verification and credential resolution. The Host redeems credentials again at App Server launch.

Send an empty `POST /agentengine/internal/v1/dsh/agents/{agent_id}/ksxc/connection` to the private Server origin with these headers.

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <AGENTKIT_RUNTIME_TOKEN>` |
| `X-AgentEngine-Target-Version-Id` | Current Agent version |
| `X-AgentEngine-Manifest-Sha256` | Effective manifest SHA-256 |
| `X-AgentEngine-Resource-Permit` | Original Server-signed permit for this request |

```json
{
  "Code": 0,
  "Data": {
    "AuthToken": "<private>",
    "CompanyCode": "example",
    "Environment": "pre",
    "ConnectionRef": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

Keep this response on the private hop. The connection reference scopes ephemeral state to one grant. A disconnected or rebound account requires a fresh connection or permit. In Studio Settings, select **托管 Agent** to manage the account for the current authenticated Server identity. This uses Server's `CreateKsxcConnection`, `GetKsxcConnectionResult`, `GetKsxcConnection` and `DeleteKsxcConnection`.

### Create and update

Studio uses `Framework=ksxc` and `ModelConfig={Mode:"ksxc",Model:"example-model"}` on creation, with `DeploymentType=ManagedRuntime` on both writes. The nested `ManagedRuntimeConfig` carries `RuntimeName=ksxc`, a platform-published `RuntimeVersion`, and the YAML declaration below.

```yaml
name: ksxc-example
framework: ksxc
artifact_type: ManagedRuntime
runtime:
  name: ksxc
  version: ksxc-test.1
model: example-model
prompt: Answer the user clearly.
```

The release metadata identifies the same immutable image and declares `runtimes: ["ksxc"]` and `bundleFormat: "agentengine.dsh-manifest/v1"`. The Server's storage capability includes `ksxc` for persistent Studio deployments. Publish the release through the target environment's Server catalog. The update carries the current `ExpectedVersionId` and an idempotent `ClientToken`. The Host verifies the canonical manifest returned by the Server and checks the currently observed version before accepting the receipt.

## Verification

```sh
node scripts/probe-ksxc-app-server.mjs --executable /path/to/ksxc --sha256 <digest>
node --test tests/ksxc-runtime.test.mjs tests/managed-runtime-actions.test.mjs tests/managed-runtime-host.test.mjs tests/studio-deployments.test.mjs
```
