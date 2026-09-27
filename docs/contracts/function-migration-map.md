# Existing Studio → DSH plugin migration map

This map is the implementation boundary for the new `agentkit-studio` project. It is
deliberately a responsibility map, not a source-copy list. Existing Studio code remains
available as a behavioral reference and Host contract evidence; its React components and
Python UI entrypoint are not runtime dependencies of this plugin.

## Ownership rule

The official DSH host owns the interaction kernel. AgentKit Studio contributes only the
product domain and the adapter needed to expose a KsADK session to that kernel.

| Existing Studio capability | New owner | DSH reuse point | Migration status |
| --- | --- | --- | --- |
| Chat transcript, composer, streaming rows, reasoning, tool rows, Goal strip | Official DSH | `ui-conversation`, `ui-chat`, `ui-session`, `ui-tool`, `ui-goal`, `ui-workflow-run` | Reused; canonical user/assistant/reasoning/tool mapping reaches the official node store; Goal/interaction/artifact mapping remains opaque |
| Session persistence, snapshot/replay, history paging | Official DSH for native runs; KsADK Host only for an explicit remote runtime | Session Controller Remote and DSH node store | Native DSH path needs no bridge; remote KsADK path has a narrow adapter proof |
| Agent catalog and Agent draft/revision | Studio plugin; runtime-specific persistence | DSH `main` panel / sidebar slots | Standalone wizard and KsADK Host catalog are wired; DSH-native Revision registration is still open |
| Runtime and execution target selection | Studio plugin | DSH settings/panel slots | DSH Native is selectable for no-resource revisions; resource-bearing revisions fail closed until the Host adapter is implemented |
| Build, run, cancel, retry, resume | DSH Agent Loop for native runs; adapter for external runtimes | Official Session/Goal/Job UI consumes projected state | Native route is the default design; external receipts remain adapter work |
| Approval / interaction answers | KsADK Host | Official interaction/composer surfaces | Revision validator exists; end-to-end command pending |
| Workspace files and artifact preview | KsADK Host provides leases; official DSH renders | `ui-sidebar-files`, document preview, `ui-dockkit` | No second pane registry; real lease wiring pending |
| Browser | Official DSH host/guest | `ui-sidebar-browser` and Browser guest | Reuse inventory complete; open/close/recovery evidence pending |
| Cmd / terminal | Official DSH host/terminal lease | `ui-sidebar-terminal`, `ui-dockkit` | Reuse inventory complete; Studio lease wiring pending |
| Resource catalog, model/tool/MCP/skill binding | Studio plugin + KsADK Host | Studio domain panel and typed Remote | Model binding is now wired through the real catalog and Agent Revision endpoint; MCP/Tool/Skill adapters remain next |
| Knowledge base, memory and Skill Center | KsADK resource-connection service + Agent Revision compiler | `PlatformResourceBindings` contract and Host resource-connection routes | Reuse contracts and lifecycle; adapt the UI to DSH slots, do not copy old React page |
| DSH/Codex plugin marketplace | KsADK plugin ecosystem bridge + DSH Profile/Codex App Server | New Studio panel using `/api/v1/plugin-ecosystems/{ecosystem}/...` | Host APIs are reusable; old `PluginsPage` is reference behavior only because its router and reconnect ownership cannot be mounted inside DSH |
| Cloud Agent create/update/build/deploy/stop/delete | Studio plugin + AgentEngine Server | DSH panel and status projections | API gap classified; live Server contract still needs verification |
| Profile, Electron lifecycle, crash/restart, single-instance | Official DSH | `apps/desktop`, `apps/desktop-host`, Profile | Do not duplicate; Web profile restart proven, Desktop gate pending |

## What gets installed

The installable artifact is the npm package in this directory. Its `dsh.client` metadata tells
the official DSH Profile to add the browser half to the existing ClientModuleRegistry; the
Cordis patch adds the Host half as a profile bundle. The installed package therefore adds:

1. four first-class Studio main panels and sidebar rows below New Session; the original Studio
   domain split is preserved through secondary tabs under `Agents`, `资源库` and `运行中心`;
2. a native Studio Settings section inside the official Settings modal;
3. the Studio Host identity marker and, once implemented, typed Host Remotes;
4. the canonical Session adapter used by the Host bridge.

It does **not** install a second React runtime, a second Session store, an Electron main
process, a Browser iframe, or a replacement DSH conversation page.

## Migration order

1. Finish P0 with a real loopback Host health/capability Remote and one Session create/send/
   stream/reconnect path.
2. Freeze the P1 canonical event matrix and verify each promoted family against independently
   authored DSH node-store expectations; keep unsupported families explicit until DSH contracts
   exist.
3. Move Agent catalog, Draft/Revision, Build/Run and resource binding into the Studio panel;
   keep all command execution and credentials behind the KsADK Host.
4. Add the official DSH dock lease adapters for Files, Browser, Cmd and document preview.
5. Add cloud target operations only after the Server gap list has no unknown first-release
   operation.

Every row that adds a new UI surface must first gain a reuse-inventory entry and a runtime
acceptance test. A page being visible is not evidence that its Host command, recovery, or
single-owner state is wired.
