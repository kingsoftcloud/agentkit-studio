# Automatic installed assistant startup

`verify-assistant-automatic-startup.mjs` launches the **installed** `scripts/start-agent-bundle.mjs`, which prepares a dedicated profile and starts the ordinary compiled DSH CLI. Studio loads through its normal `index.apply`; the smoke does not mount bootstrap/guard directly and does not disable the Studio bundle.

The check uses only a loopback model, synthetic fixture credentials and temporary state. It checks cold startup, the official authenticated web route and Host compatibility, a real native managed-workspace write, full process shutdown, automatic restoration of an overdue native schedule before session prewarming, durable request replay, and a continued message in the same session after restart. Auxiliary title requests are recorded separately from tool-bearing conversation requests. It is not a browser, production account, Desktop upgrade or broad security audit.

Run it against an already built, patched DSH installation and a profile containing the exact packed Studio archive:

```sh
node scripts/verify-assistant-automatic-startup.mjs \
  --installation "$INSTALLATION" --tgz "$STUDIO_TGZ" \
  --expected-sha256 "$STUDIO_TGZ_SHA256" --report "$REPORT"
```

The archive hash and installed file comparison bind the evidence to the actual package. An optional source commit label is caller-supplied metadata; it does not replace the archive identity. The installation must contain `node_modules/@deepseek-ai/dsh` with its built CLI. No model account is required. Keep failure reports private until their diagnostics have been reviewed for accidental local environment details.

## Profile package ownership

A symlink for the *whole* profile `node_modules` moves Studio's real importer path outside the active DSH profile. Host-only imports such as `@deepseek-ai/dsh-llm` then cannot use DSH's profile resolution layer. The bundle launcher now stages a real module directory and scope directories, copies the exact Studio package into that profile, and links the other packages individually to the fixed installation. Private package dependencies remain individually linked as well. DSH continues to supply its canonical Cordis/LLM identities; no second runtime is bundled or copied.

The launcher records its profile ownership, immutable bundle/Agent/Build identity, Studio code digest (including file modes), and dependency link text. Restarts verify the retained copy against that record before considering an image update. New code and links are staged and strictly checked against the current fixed installation. Old package-manager paths need not remain present after an image replacement: retained links are checked against their recorded text, and newly published links must resolve to the current installation. The startup guard and managed permission rules are unchanged.

The portable profile also declares the official Schedule plugin's `studioFrozenRuntimeReady` dependency. Only a successfully initialized, live frozen runtime provides that service, after preset/model admission and workspace permission initialization. Native Schedule therefore performs its first restoration drive after the required runtime is ready. Withdrawal follows the owning Cordis dependency scope. Studio does not re-create tasks, fake schedule edits, prewarm sessions or invoke private timer methods. Ordinary Desktop profiles do not add this dependency.

## Existing legacy state

The launcher automatically migrates the exact legacy `agentkit-runtime` profile when the state receipt, portable manifest, imported Agent Build and immutable bundle identity agree, and the old whole-directory module link points to the current fixed installation. Legacy `[]` patches and a missing Schedule readiness declaration are supported. Existing official Schedule configuration and unrelated Settings are retained; the staging patch gains only the required readiness dependency. Conflicting, disabled or duplicate Schedule declarations are refused.

A copied profile with the launcher ownership record may refresh to a newer image only after its old code digest and dependency link text match that record. An unmarked copied profile is adopted only when it exactly matches the current installation; an unknown old copy is not automatically trusted. Foreign links/profiles, changed code, changed bundle identity, invalid receipts and altered Agent Builds remain errors.

The launcher holds a cross-process kernel lock before inspecting any recovery journal and throughout profile preparation. POSIX uses the fixed installation's public native flock; Windows uses its declared public Koffi dependency for a named mutex and accepts abandoned-owner acquisition. A live competing launcher fails with `BUNDLE_HOST_PROFILE_BUSY`; process death releases or abandons ownership without a timeout or PID guess. The replacement is prepared in a sibling staging directory and verified before rename. A small ownership-bound transaction record lets an interrupted rename restore the previous complete profile on the next launch. A successful switch retains the complete old profile, including Settings, in a `.previous-*` sibling for explicit rollback; no backup is pruned automatically. This only replaces launcher-owned profile code/configuration. It does not recreate or move DSH sessions, assistant workspaces, the `agentkit` home, runtime receipt or Agent data partitions. A changed portable bundle still requires its own deployment state.

Add `--profile-migration` to the smoke to qualify this path with synthetic retained history and an exact legacy `[]`/whole-link layout, an overdue native schedule, preserved Settings, normal CLI startup/continuation, and a subsequent same-bundle code refresh and code rollback. The code-refresh probe adds an inert private file to an isolated installed Studio copy; published archive files remain byte-identical. This is local controlled evidence and does not itself claim a production migration or Desktop OS-upgrade acceptance. Native process exclusion and death recovery are exercised on the machine running the smoke; the Windows kernel API facade checks contention, abandoned-owner handling and handle cleanup, and is not a claim of a real Windows run.
