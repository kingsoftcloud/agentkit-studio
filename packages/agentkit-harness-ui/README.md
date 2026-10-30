# @kingsoftcloud/agentkit-harness-ui

A reusable, framework-lightweight **task-process UI** for AgentKit Native. It
takes a stream of versioned events from a host (the Native runtime, a Studio
adapter, or a test harness) and renders an accessible React timeline of
streaming assistant text, provider-supplied thinking, and live tool calls —
with ordered items, replay-safe deduplication, bounded summaries, and redacted
errors.

The package is intentionally free of Studio / DSH / Python imports. React is a
**peer dependency** (`>=18`). Source is plain ESM (`.mjs`, no JSX) and is
exposed directly, with no transpiler required at runtime. The optional Markdown
renderer is bundled by `npm run build` before packing the package. The
pure logic modules (protocol, reducer, projection, summaries, tool details,
view model) do **not** import React and run in plain Node `>=22`; only the
React binding (`./components`) and the barrel (`.`) require React.

`./file-preview` exports `createFilePreviewComponents(React)`. Its read-only
`FilePreviewPane` displays one bounded UTF-8 page of an isolated child file.
The host supplies authenticated observations, byte cursors and navigation/copy
callbacks; the component never resolves execution roots or performs I/O. These
are current workspace observations, separate from immutable tool receipts and
task acceptance. Failed or canceled reads must not fall back to a parent file.

## Design

```
host events ──▶ normalizeEvent ──▶ reduce ──▶ state ──▶ buildViewModel ──▶ React
 (protocol v1)   (protocol.mjs)   (reducer.mjs)        (view.mjs)         (components.mjs)
                                          │
                                          └─▶ renderers.mjs (execute/read/edit/default)
                                                  diff.mjs · terminal.mjs
```

- **`protocol.mjs`** — the explicitly versioned, stable event contract
  (`PROTOCOL_VERSION = 1`). `normalizeEvent` validates and coerces each event,
  including the optional `display` presentation payload (`DisplayKind`:
  `command_output`, `command_preview`, `file_diff`, `file_read`, `file_edit`,
  `generic`).
- **`reducer.mjs`** — a pure `(state, event) => state` machine. Handles
  streaming text, provider thinking (with optional host-supplied real
  `duration`), single keyed tool calls (scheduled/started/progress/result/error),
  task-state interruption/failure/recovery, ordered items, and idempotent
  replay by event id. It never invents reasoning or success.

  A closed interrupted execution uses `task.finished` with
  `outcome: "unverified"` and `executionState: "interrupted"`. This separates
  stopping the driver from proving its effects. The host can supply a factual
  summary; the renderer never changes an unknown operation into success or
  failure. A resumable `task.state` interruption without a finished outcome
  remains distinct. Existing v1 events without this optional field are unchanged.
- **`project.mjs`** — read-only selectors (ordered items, streaming/waiting
  flags, plan progress, active tool, errors, status label).
- **`summary.mjs`** — bounded text helpers: latest-line preview, truncation,
  sensitive-key redaction, a deterministic summary-line queue.
- **`tool-detail.mjs`** — per-tool audit titles and bounded, redacted detail
  blocks; a bounded `file_diff` preview; error redaction.
- **`diff.mjs`** — pure unified-diff parsing: real line numbers from
  `@@ -oldStart,oldCount +newStart,newCount @@` headers (never synthesized),
  addition/deletion counts, operation-kind inference, bounded unified AND
  split representations. No file is read; no write is inferred from input.
- **`terminal.mjs`** — pure command/output extraction and safe ANSI
  sanitization for the execute renderer. Output is plain text (never
  innerHTML), so escape sequences cannot inject markup. Exit/cwd are shown
  only when the host supplied them.
- **`renderers.mjs`** — the tool-call renderer registry. Dispatches by tool
  name to `execute` (terminal: `$` prompt + bounded command, live
  stdout/stderr/exit/cwd, copy + open-terminal), `read` (file chip, opens via
  host callback, non-toggleable), `edit` (file chips, +N/-N count, inline diff
  with real line numbers, unified + split responsive, bounded preview with a
  full-retrieval callback), and `default` (bounded redacted detail for
  unknown/MCP tools). All host actions are `data-action` attributes; the tree
  stays function-free.
- **`view.mjs`** — builds a serializable element tree with stable
  `data-testid` selectors and accessibility attributes. Dispatches tool
  rendering through the registry. Carries the "no invented content"
  invariants (see below). Testable without a DOM.
- **`components.mjs`** — thin React binding; maps the tree to
  `React.createElement` and owns presentation-only state (expanded
  thoughts/tools, follow). Event handlers are delegated from the root.
- **`styles.mjs`** — an optional CSS string (light/dark, reduced-motion aware).

## Minimal usage

The host owns the event stream and the reducer state (e.g. in `useReducer` or
an external store); the component is a pure projection of that state.

```jsx
import { useReducer } from "react";
import { HarnessTimeline } from "@kingsoftcloud/agentkit-harness-ui";
import { initialState, reduce } from "@kingsoftcloud/agentkit-harness-ui/reducer";

function App({ eventStream }) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  // forward your runtime events to the reducer as they arrive
  useEffect(() => eventStream.on("event", e => dispatch(e)), [eventStream]);

  return <HarnessTimeline state={state} autoFollow workspaceRoot={process.cwd()} />;
}
```

Hosts that do not use React can import the pure subpaths directly and render
`buildViewModel(state)` with any renderer (the tree is React-element-shaped):
`@kingsoftcloud/agentkit-harness-ui/view`, `/reducer`, `/protocol`, etc.

## Host event integration

Emit one event per lifecycle transition. Every event carries `v: 1`, a stable
`type`, and a unique `id` (used for idempotent replay — re-applying the same
event is a no-op). `ts` and `seq` are optional diagnostics.

| Event | Payload | Reducer effect |
|---|---|---|
| `task.started` | `taskId`, `title?`, `runId?` | enters `running` |
| `task.state` | `state`, `reason?`, `message?` | validated transition (see below) |
| `task.finished` | `outcome`, `summary?`, `error?`, `reason?` | terminal; finalizes live streams |
| `text.delta` | `itemId`, `delta` | append (creates the item on first delta) |
| `text.done` | `itemId` | stop streaming |
| `thinking.start` | `itemId` | records pending; **creates no visible item** |
| `thinking.delta` | `itemId`, `delta` | first non-empty delta creates the thought |
| `thinking.done` | `itemId`, `duration?` | stop streaming; `duration` (seconds, host-supplied) is shown if present |
| `tool.scheduled` | `callId`, `name`, `input` | create/update the part (bounded input) |
| `tool.started` | `callId` | move to `running` |
| `tool.progress` | `callId`, `progress?`/`message?`, `display?` | running + progress text; a `command_preview` display streams live output before the result |
| `tool.result` | `callId`, `result?`, `display?` | `completed` + display payload |
| `tool.error` | `callId`, `error` | `failed` + redacted error |
| `plan.updated` | `items[]` | replace the task plan |

**`display` presentation payloads** (optional, on `tool.result`/`tool.progress`).
The UI renders a purpose-built block for each known `kind`; unknown kinds fall
back to the generic bounded object preview.

| `kind` | Fields | Renderer |
|---|---|---|
| `command_output` | `stdout`, `stderr`, `exit`, `cwd` | execute output with exit badge + cwd |
| `command_preview` | `fullText` | live streaming output while running |
| `file_diff` | `path`, `patch`, `changeStat?`, `operationKind?` | edit inline diff (real line numbers) |
| `file_read` | `path`, `entryType` | read file chip |
| `file_edit` | `files[]` (`path`, `patch`, `changeStat?`, `operationKind?`) | edit multi-file chips + per-file diff |
| `generic` / unknown | any | bounded redacted object preview |

**Task states:** `idle → running → interrupted → recovered → running`,
`running → failed → recovered/running`, `running → completed`, and
`cancelled` from any state. Invalid `task.state` transitions are ignored
rather than crashing the timeline.

**Ordering, deduplication, and replay.** Items keep their first-appearance
(provider stream) order; a tool part is updated in place for the same `callId`
across its whole lifecycle — there is one visible row per call, not separate
pending/running/completed rows. Replaying an event with an already-seen `id`
is a no-op, so a host can replay a batch safely. A `tool.result`/`tool.error`
arriving without a prior `tool.scheduled` appends a minimal fallback part so
transcript rendering is never missing; a later `tool.scheduled` fills it in.

### Mapping a runtime to the protocol

The UI consumes only these events. A typical Native runtime adapter maps its
internal `SessionEvent`s once at the boundary: reasoning deltas →
`thinking.delta`, tool lifecycle → the `tool.*` family, assistant text →
`text.delta`/`text.done`, and run lifecycle → the `task.*` family. Do **not**
import runtime, provider, or session-store internals into the UI; keep the
event seam stable and versioned.

## No invented thinking or success

The UI is deliberately conservative, matching the reference TUI/Studio
behavior:

- A thought block exists **only** after a non-empty `thinking.delta`. A bare
  `thinking.start` produces no transcript item (only the neutral "Thinking…"
  status placeholder, which is a status indicator, not reasoning content).
- The UI never renders token/character counts for thinking, and never
  attributes aggregate turn usage to an individual segment.
- A completed task shows **only** a host-supplied `summary`. If the host
  provides none, the UI shows the declared `Completed` state label and no
  success prose.
- Tool inputs and errors are bounded and redacted; large content blobs are
  never dumped verbatim. Sensitive keys (`token`, `secret`, `password`,
  `api_key`, `authorization`, …) and `env` values are redacted.

## Stable selectors

The view model exposes stable `data-testid` hooks for host integration and
tests: `harness-timeline`, `harness-timeline-list`, `plan-dock`, `plan-count`,
`plan-current`, `task-waiting`, `status-line`, `task-state`, `task-summary`,
`task-error`, `text-block`, `thought-block`, `thought-details`, `thought-toggle`,
`thought-label`, `thought-preview`, `thought-body`, `tool-block` (carries
`data-renderer` ∈ `execute`|`read`|`edit`|`default`), `tool-details`,
`tool-toggle`, `tool-title`, `tool-status`, `tool-detail`, `tool-progress`,
`tool-error`, `tool-result`, `execute-command`, `execute-command-prompt`,
`execute-command-text`, `execute-output`, `execute-exit`, `execute-cwd`,
`execute-no-output`, `bash-output-preview-full` (streaming), `bash-result-output`
(done), `bash-result-stderr`, `read-chip`, `read-file-name`, `read-file-path`,
`edit-chips`, `edit-chip`, `edit-file-name`, `edit-diff`, `edit-diff-path`,
`edit-diff-count`, `edit-diff-unified`, `edit-diff-split`, `edit-diff-line`,
`edit-diff-old-line`, `edit-diff-new-line`, `edit-open-file`,
`edit-show-full-diff`, `jump-latest`. Roles: `log`
(timeline), `status` (streaming/progress/waiting), `alert` (errors).

## Accessibility

- The timeline is a `role="log"` container; streaming state sets `aria-busy`.
- Thoughts and tools use native `<details>`/`<summary>` for collapsible
  disclosure (keyboard-operable, no JS needed) with `aria-expanded` mirrored.
  Read chips are non-toggleable (one-line) and use a `<button>` when a host
  `onOpenFile` callback is provided.
- Streaming labels use `role="status"`; errors use `role="alert"`.
- The built-in CSS honors `prefers-reduced-motion` (shimmer/caret disabled).
- Expansion state is presentation-only and never written back to reducer
  state. Desktop thought auto-collapse: a thought that stops streaming
  collapses back to its summary UNLESS the user opened it themselves; a
  user-opened thought stays open across stream end.

## Host callbacks

`HarnessTimeline` accepts optional callbacks; the tree carries them as
`data-action` attributes and a single delegated click handler dispatches to
them (the view tree stays function-free and serializable):

- `onOpenFile({path, kind, callId?})` — open a file or patch (read chip, edit chip, edit-diff "Open").
- `onCopy(text)` — copy command or output.
- `onOpenTerminal({callId, cwd?})` — open a live terminal for an execute call.
- `onRetrieveFullDiff({callId, path})` — fetch the full diff when the bounded preview is truncated.
- `onJumpLatest()` — jump the timeline to the bottom (falls back to the built-in scroll when omitted).

## Testing

Focused tests use `node:test` (no DOM, no React required):

```sh
cd packages/agentkit-harness-ui
node --test test/*.test.mjs
```

The tests cover the protocol graph (incl. display kinds), the reducer
lifecycle/ordering/dedup/replay, bounded summaries and redaction, per-tool
detail blocks, the unified-diff line-number parser and ANSI sanitization, the
renderer registry (execute/read/edit/default), the projection selectors, the
view-model invariants (stable selectors, accessibility, ordering, the
no-invented-content rules), and the React binding (delegated callbacks, desktop
thought auto-collapse, scroll-follow wiring) via a minimal React shim.

## Exposed API

```
.                  # barrel (pulls React via the binding)
./protocol         # PROTOCOL_VERSION, EventType, TaskState, ToolStatus, DisplayKind, normalizeEvent, isDisplayKind, …
./reducer          # initialState, reduce, reduceAll
./project          # visibleItems, isStreaming, isWaitingForFirstToken, planProgress, activeTool, …
./summary          # latestNonEmptyLine, truncateText, redactValue, boundedDetailLines, SummaryQueue
./tool-detail      # toolTitle, toolDetailLines, workspaceRelative, fileDiffPreview, redactError
./diff             # parseDiffHunks, countChangeStat, patchFilePath, inferOperationKind, diffPreviewLines
./terminal         # extractCommand, extractOutput, sanitizeAnsi, normalizeCwd
./renderers        # renderTool, toolRendererKind
./view             # buildViewModel, h, isElement, DEFAULT_VIEW_OPTIONS
./components       # HarnessTimeline (React peer dep)
./styles           # styles (CSS string)
./react-binding    # createHarnessComponents (host-injected React)
```

## License

Apache-2.0. See `LICENSE`. Third-party notices (vercel/ai-elements reasoning
semantics retained under Apache-2.0) are in `NOTICE`.

## Markdown renderer

`createMarkdownComponents(React, ReactDOM)` from `./markdown` uses the same React instances as the host. Render `MarkdownResponse` with a string child and the actual `streaming` flag; inject `markdownStyles` once. Code stays plain while streaming and is highlighted after completion. Unknown languages remain plain text. File/external link callbacks perform host navigation, while image rendering requires a host resolver; this package does not read files or fetch images. Pass a `scopeKey` for the session/workspace to release stale navigation closures when switching contexts. The host must validate the original file href before opening it.

Build with `node markdown/build/build-markdown.cjs` after installing the pinned development dependencies. The distributed ESM factory is self contained except for the injected React/ReactDOM. Dependency notices ship with it.

### Context notices

Hosts emit `context.marker` with `marker: { id, status, origin, after }`. The
`after` boundary is `start`, a `tool` call ID, or a `message` source ID. Text and
reasoning completion events may carry `sourceMessageId` for stable anchoring.
The reducer updates a marker in place; the view renders a single divider row.
Only an adopted summary may be marked completed, not a summary model response.
Unloaded history anchors remain hidden until the corresponding items arrive.
Token counters and policy diagnostics belong in the host's run details.
Ordinary `unverified` completion has a neutral finish label; an explicit host
`verificationRequired: true` enables the verification warning without changing
the stored outcome.

`@kingsoftcloud/agentkit-harness-ui/command-output` exports
`appendCommandOutput(previous, page, request)` and
`createCommandOutputComponents(React).CommandOutputPane`. The Host supplies
authenticated `agentkit.studio-command-output/v1` pages and owns disclosure,
byte cursors, docking and cancellation. Display redaction never changes raw
continuation cursors. The view retains the latest 131072 Unicode code points
per channel and labels omissions; stdout/stderr remain plain sanitized text.
Process states and known exits come from observations, not synthetic Harness
events. Unknown evidence is never rendered as successful execution.
