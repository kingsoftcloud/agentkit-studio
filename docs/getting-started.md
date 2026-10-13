# Getting started

## Desktop

Download a qualified installer from [GitHub Releases](https://github.com/kingsoftcloud/agentkit-studio/releases).
Release assets may also be served from the configured HTTPS object-storage origin.
macOS uses a signed DMG; Windows uses an NSIS EXE. Preview builds can change quickly.

Open Settings → Models and credentials to configure a provider, model and API key.
A new profile without model credentials opens the credential guide. Existing usable
credentials skip it. Settings → AgentKit Studio → Reopen credential guide opens it
again without resetting your configuration.

Create a conversation directly to use DSH Native, or select a Studio Agent to use
its frozen runtime configuration. Generated files are delivered through the host's
native file cards and sidebar preview.

Desktop Settings shows the installed App build, the Studio plugin version and the
pinned DSH baseline separately. Update availability compares the installed App build
with its channel feed; the version of the plugin package is not the App version.

## Development

Use Node.js 22.19.0+ (or Node.js 24), pnpm 10.33.2, Git, Make and a native compiler.
Keep the official DSH checkout outside this repository:

```sh
corepack enable
pnpm install --frozen-lockfile
make setup DSH_ROOT=../deepseek-harness
make dev DSH_ROOT=../deepseek-harness
```

`make setup` pins the host, applies reviewed patches, builds it and installs the
Studio plugin into the chosen profile. Use a separate `DSH_HOME` and `AGENTKIT_HOME`
for development. Windows desktop packaging runs on a Windows runner; Make-based
Host development on Windows uses WSL2.

Run `make doctor DSH_ROOT=../deepseek-harness` to check tools, host revision, build
outputs and the installed plugin. Credentials belong in Host settings; do not copy
profiles or secrets into source files.
