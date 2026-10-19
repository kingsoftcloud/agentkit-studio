# Automatic installed assistant startup

The assistant Host fixture and the production entry smoke establish different things:

- `verify-personal-assistant-host.mjs` injects a controlled bootstrap/guard into real DSH Host roots. It exercises HTTP, native sessions, permissions, attachments and restart semantics, but disables automatic Studio entry loading for that injected composition.
- `verify-assistant-automatic-startup.mjs` launches the **installed** `scripts/start-agent-bundle.mjs`, which prepares a dedicated profile and starts the ordinary compiled DSH CLI. Studio loads through its normal `index.apply`. The smoke does not mount bootstrap/guard directly and does not disable the Studio bundle.

The second check uses only a loopback model, synthetic fixture credentials and temporary state. It checks cold startup, the official authenticated web route and Host compatibility, a real native managed-workspace write, full process shutdown, automatic restoration of an overdue native schedule before session prewarming, durable request replay, and a continued message in the same session after restart. Auxiliary title requests are recorded separately from tool-bearing conversation requests. It is not a browser, production account, Desktop upgrade or broad security audit.

Run it against an already built, patched DSH installation and a profile containing the exact packed Studio archive:

```sh
node scripts/verify-assistant-automatic-startup.mjs \
  --installation "$INSTALLATION" --tgz "$STUDIO_TGZ" \
  --expected-sha256 "$STUDIO_TGZ_SHA256" --report "$REPORT"
```

The archive hash and installed file comparison bind the evidence to the actual package. An optional source commit label is caller-supplied metadata; it does not replace the archive identity. The installation must contain `node_modules/@deepseek-ai/dsh` with its built CLI. No model account is required. Keep failure reports private until their diagnostics have been reviewed for accidental local environment details.

## Profile package ownership

A symlink for the *whole* profile `node_modules` moves Studio's real importer path outside the active DSH profile. Host-only imports such as `@deepseek-ai/dsh-llm` then cannot use DSH's profile resolution layer. The bundle launcher now stages a real module directory and scope directories, copies the exact Studio package into that profile, and links the other packages individually to the fixed installation. Private package dependencies remain individually linked as well. DSH continues to supply its canonical Cordis/LLM identities; no second runtime is bundled or copied.

Before publishing a new profile and on every restart, the launcher checks Studio file contents/modes and dependency links against the installed package. A mismatched or relocated installation is rejected rather than silently substituting code in retained state. The startup guard and managed permission rules are unchanged.

The portable profile also declares the official Schedule plugin's `studioFrozenRuntimeReady` dependency. Only a successfully initialized, live frozen runtime provides that service, after preset/model admission and workspace permission initialization. Native Schedule therefore performs its first restoration drive after the required runtime is ready. Withdrawal follows the owning Cordis dependency scope. Studio does not re-create tasks, fake schedule edits, prewarm sessions or invoke private timer methods. Ordinary Desktop profiles do not add this dependency.

## Existing legacy state

An existing whole-directory `node_modules` link or a profile missing the new Schedule readiness dependency is rejected with `BUNDLE_HOST_PROFILE_MIGRATION_REQUIRED`. This leaves session history, workspace files, the bundle receipt, profile and Settings patch untouched. There is no automatic migration or deletion of an old deployment.

An operator migration must be performed offline, with a restorable backup of the complete state directory and the same immutable portable bundle. Verify that the profile is the launcher-created `agentkit-runtime` profile and that its module link points to the expected installation. Retain its `cordis.patch.yml` (portable model Settings are legitimately persisted there), move the old profile aside outside the active profiles directory, and use the new `prepareBundleHost` API to prepare the replacement without starting the CLI. Merge the retained Settings entries into the newly generated patch before the ordinary launcher is started, preserving the new `schedule` readiness dependency. Do not overwrite the new patch wholesale with the legacy patch. Do not move or recreate the DSH session store, assistant workspaces, `agentkit` home or bundle receipt. A changed portable bundle requires its own deployment state as before.

This migration procedure is an explicit operator step, not a grant to alter an existing account or production deployment. The automated regression checks the refusal and preservation behavior; it does not claim a production migration was performed.
