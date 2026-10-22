# Desktop releases and updates

AgentKit Studio uses the official DSH Electron shell and `electron-updater`.
The product App ID is `com.kingsoftcloud.agentkit-studio`. The installed desktop
build, Studio plugin version and pinned DSH version are separate values.

## Update origin and channel

Production builds require an HTTPS update origin and an explicit `stable` or
`preview` channel. The default Studio storage origin is
`https://agentkit.ks3-cn-beijing.ksyuncs.com`:

- Immutable DMG, ZIP and blockmap: `studio/<version>/`.
- Channel feed: `studio/feeds/mac-arm64/`.
- Compatibility feed for older installed Studio builds: `dsh-desk/feeds/mac-arm64/`.

Each release uses a strictly increasing semantic App version. Older installers
that embed another origin need one manual installation of the new signed DMG;
changing signed resources in an existing App is not a migration mechanism.

The updater checks the configured channel and offers a new version when its App
version is higher than the installed build. It downloads from the feed's HTTPS
URLs. A fresh DMG installation without a cached previous ZIP can require a full
download before subsequent updates can reuse bytes.

## Signing workflow

Run `.github/workflows/release-desktop.yml` in this repository with an immutable
`studio_ref`, the branch containing that commit, pinned `dsh_ref`/`dsh_commit`,
`build_version`, channel and HTTPS origin. The workflow verifies ancestry and then
checks out the exact commit; later branch edits cannot change the build input.

Configure these secrets in the protected `studio-signing` GitHub Environment:

- `STUDIO_APPLE_P12_BASE64`, `STUDIO_APPLE_P12_PASSWORD`.
- `STUDIO_APPLE_ID`, `STUDIO_APPLE_APP_PASSWORD`, `STUDIO_APPLE_TEAM_ID`.
- The KS3 upload secret names declared by the publication job.

Same-repository checkout uses `GITHUB_TOKEN`. Signing creates a temporary keychain,
packages the official pinned host with Studio, notarizes and staples the result,
checks the real module graph, and retains signed artifacts and checksums.
Credentials and temporary settings are removed after the job.

Keep `publish_feed=false` while qualifying a candidate. A successful signed
candidate can be reused by its `candidate_run_id`; identity and asset digests must
match. `release_tools_ref` may update publication tools without replacing signed
App bytes. It must never relabel a newer source commit as the signed candidate.

## Ship macOS and Windows together

Every desktop release covers both platforms in one batch. Publish the macOS feed
with `release-desktop.yml`; after the signed macOS build succeeds and
`publish_feed=true`, the workflow's `queue-windows` job dispatches
`release-windows.yml` automatically with the same immutable `studio_ref`,
`build_version`, channel and origin. Windows is then published explicitly with
`publish-windows.yml` (or `scripts/publish-windows-candidate.mjs` from the
retained artifacts) using the accepted candidate run id and the previous Windows
feed version. Both feeds refresh `studio/latest` through
`publish-download-alias.mjs`.

A macOS-only batch is incomplete: the download page and Windows automatic updates
would stay on the previous version, so do not report a release as shipped until
`studio/feeds/mac-arm64/preview-mac.yml` and `studio/feeds/win-x64/preview.yml`
report the same version and `studio/latest/latest.json` carries both platforms.

## Publish incremental or full updates

The repository release command publishes immutable assets before replacing the
channel feed. `studio` is the default layout, and verification reads exactly the
`studio/feeds/mac-arm64/` URL embedded in the App. A working legacy feed cannot
substitute for that canonical entry. Supply the previous version as a concurrency guard:

```sh
node scripts/desktop-release.mjs publish \
  --candidate /path/to/signed-artifacts \
  --origin https://agentkit.ks3-cn-beijing.ksyuncs.com \
  --storage-origin https://agentkit.ks3-cn-beijing.ksyuncs.com \
  --layout studio --channel preview \
  --update-mode incremental --expected-previous-version <current-version>
```

Upload credentials are resolved from the Host or trusted CI environment, never
from renderer requests or checked-in configuration. Select `--update-mode full`
to force a full ZIP download. DMG is the manual installer; ZIP/blockmap and feed
are used by the automatic updater.

KS3 supports the single-range requests used by the official differential
downloader. The product configuration disables multiple-range requests. SHA-512,
code signature, notarization and native installation checks remain in place.

A full release can replace the cached ZIP while leaving an old `current.blockmap`.
Compatibility patch `029` invalidates only those stale indexes after the native
full-download completion event. The next differential update obtains the matching
published blockmap. It does not modify the ZIP or replace the native installer.

## Qualification

Source tests and unsigned packages do not qualify a signed release. Validate the
actual signed App, online feed and installation before publication:

```sh
node scripts/desktop-release.mjs verify-feed \
  --origin https://agentkit.ks3-cn-beijing.ksyuncs.com \
  --layout studio --channel preview --version <candidate-version>
```

`verify-desktop-installed-update.mjs` verifies signature and Gatekeeper, launches
the real App, waits for native version replacement and automatic restart, and
checks retained files. Use the visible native update controls. Capture actual
successor workspace, Host connection and retained Session evidence; the observer
must not start the successor itself.

For distribution acceptance use `--native-profile`, because macOS LaunchServices
does not preserve custom command-line profile flags on automatic restart. Use
`--retain-file` and `--retain-session-title` for real persisted data, and
`--require-differential` or `--require-full` to require the intended transfer mode.
Do not seed updater caches or count a full fallback as a differential success.

The report distinguishes Runtime source hashes from the complete Studio package
hash. A forward rollback repackages a previously accepted source into a higher App
version; it must restore the expected package hash and pass restart/data retention
again. Never lower the feed version or disable signature validation to roll back.

See [Windows releases](windows-release.md) for the independent NSIS/signature and
installed App checks. A working macOS update does not prove Windows update support.

## Public download alias

The public site links to fixed `studio/latest/` URLs instead of a versioned folder;
`latest.json` carries the current versions and checksums:

```sh
node scripts/publish-download-alias.mjs \
  --origin https://agentkit.ks3-cn-beijing.ksyuncs.com --channel preview
```

The command reads the published update feeds, copies the current ZIP/EXE/DMG/blockmap
inside KS3 (no release bytes cross the operator machine) and rewrites `latest.json`
with `no-cache`. Existing alias objects are deleted before the copy because KS3
answers `ObjectAlreayExists` instead of overwriting a server-side copy.

Both publish paths run it automatically once the feed advance is verified:
`release-desktop.yml` publishes the macOS feed and `publish-windows.yml` publishes
the Windows feed, so the site follows a release without any manual step. The
workflows pass `STUDIO_DOWNLOAD_PROD_KS3_BUCKET/ACCESS_KEY/SECRET_KEY`, while a
local run keeps reading the Host configuration. The command stays runnable by hand
to repair the alias:


`studio/latest/` only serves the public download page. Update checks keep reading
`studio/feeds/<target>/<channel>.yml`, so the alias never affects hot updates,
feed version comparison or the automatic upgrade path.

## Version naming

Desktop builds are named `<dsh version>.<YYYYMMDD>.<build ordinal of the day>`,
for example `0.2.1-rc.2.20261021.1`:

- `0.2.1-rc.2` — the DSH runtime version the build embeds (tracks DSH releases)
- `20261021` — the packaging date
- `1` — the first build packaged that day; the ordinal keeps increasing

Because the suffix always advances, the feed version is greater than the
previous release and the updater sees a normal upgrade. `build_version` is an
explicit workflow input for `release-desktop.yml` / `release-windows.yml`; when
omitted the desktop version falls back to the bare DSH version.
