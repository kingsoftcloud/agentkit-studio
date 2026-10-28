import test from "node:test";
import assert from "node:assert/strict";
import { EventType, TaskState } from "../src/protocol.mjs";
import { initialState, reduce, reduceAll } from "../src/reducer.mjs";
import { buildViewModel, h, isElement } from "../src/view.mjs";
import {
  findByTestId, findAllByTestId, findByRole, findAllByRole, attr, textOf, hasText, childCount,
} from "./helpers.mjs";

function ev(type, id, extra = {}) { return { v: 1, type, id, ...extra }; }
function viewFor(state, options) { return buildViewModel(state, options); }

test('closed interrupted task displays the host disposition without a failure or success claim', () => {
  const state = reduceAll(initialState(), [ev(EventType.TaskStarted, 'start', { taskId: 'task' }),
    ev(EventType.TaskFinished, 'closed', { outcome: 'unverified', executionState: 'interrupted', summary: 'Original result still unknown' })]);
  const view = viewFor(state);
  assert.ok(hasText(view, 'Original result still unknown'));
  assert.equal(attr(findByTestId(view, 'task-state'), 'data-state'), 'interrupted');
  assert.equal(findByTestId(view, 'task-error'), null);
});

function streamScenario() {
  return reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T", title: "Build", runId: "r1" }),
    ev(EventType.ThinkingDelta, "k1", { itemId: "th-1", delta: "Step 1: read workspace\nStep 2: plan" }),
    ev(EventType.TextDelta, "a1", { itemId: "txt-1", delta: "Here is the answer." }),
    ev(EventType.ToolScheduled, "x1", { callId: "call-1", name: "Bash", input: { command: "npm test", cwd: "packages/ui" } }),
    ev(EventType.ToolStarted, "x2", { callId: "call-1" }),
    ev(EventType.ToolProgress, "x3", { callId: "call-1", message: "running 4 tests" }),
  ]);
}

test("root has stable selectors and an accessible log role", () => {
  const tree = viewFor(streamScenario());
  const root = findByTestId(tree, "harness-timeline");
  assert.ok(isElement(root));
  assert.equal(root.type, "section");
  assert.equal(attr(root, "role"), "log");
  assert.equal(attr(root, "aria-label"), "Task timeline");
});

test("items render in provider stream order: thought, text, tool", () => {
  const tree = viewFor(streamScenario());
  const items = findAllByTestId(tree, "thought-block").concat(
    findAllByTestId(tree, "text-block"),
    findAllByTestId(tree, "tool-block"),
  );
  // ordering by position in the tree
  const list = findByTestId(tree, "harness-timeline-list");
  const order = list.children.filter(isElement).map(n => n.props["data-testid"]);
  assert.deepEqual(order, ["thought-block", "text-block", "tool-block"]);
});

test("thought block is collapsed by default, shows a preview while streaming, and exposes a toggle", () => {
  const tree = viewFor(streamScenario());
  const thought = findByTestId(tree, "thought-block");
  const details = findByTestId(thought, "thought-details");
  assert.equal(attr(details, "open"), false, "thoughts default to collapsed");
  assert.equal(attr(details, "data-item-id"), "th-1");
  assert.equal(attr(details, "aria-expanded"), false);
  // streaming label + preview present; no token/char count ever rendered
  assert.equal(textOf(findByTestId(thought, "thought-label")), "Thinking…");
  assert.ok(findByTestId(thought, "thought-preview"), "collapsed streaming thought shows a bounded preview");
  assert.match(textOf(thought), /Step 2: plan/);
  assert.doesNotMatch(textOf(thought), /\d+\s*(token|char)/i, "no invented token/char count");
});

test("thought body only renders when expanded; expansion is presentation-only via options", () => {
  const base = streamScenario();
  const collapsed = viewFor(base);
  assert.equal(findByTestId(collapsed, "thought-body"), null);
  const expanded = viewFor(base, { thoughtOpen: new Map([["th-1", true]]) });
  const body = findByTestId(expanded, "thought-body");
  assert.ok(body, "expanded thought renders its body");
  assert.ok(hasText(body, "Step 1: read workspace"));
  // the open attribute is driven solely by the passed map, never written back
  assert.equal(attr(findByTestId(expanded, "thought-details"), "open"), true);
});

test("thought summary carries a brain icon, a chevron, and reasoning mask data attributes", () => {
  const tree = viewFor(streamScenario());
  const thought = findByTestId(tree, "thought-block");
  // Streaming collapsed thought: brain icon + label + streaming preview + chevron.
  const svgs = [];
  (function walk(n) {
    if (n == null || n === false || typeof n !== "object") return;
    if (n.type === "svg") svgs.push(n);
    for (const c of n.children || []) walk(c);
  })(thought);
  assert.ok(svgs.length >= 2, "brain icon and chevron render as inline svg");
  // Streaming preview declares the horizontal mask hook (binding fills it in).
  const preview = findByTestId(thought, "thought-preview");
  assert.equal(attr(preview, "data-reasoning-streaming-mask"), "none");
  // Expanded thought body declares the vertical scroll-mask hook.
  const expanded = viewFor(streamScenario(), { thoughtOpen: new Map([["th-1", true]]) });
  assert.equal(attr(findByTestId(expanded, "thought-body"), "data-reasoning-scroll-mask"), "none");
});

test("execute tool block renders one part per callId, open while running, with $ command, progress and cwd", () => {
  const tree = viewFor(streamScenario());
  const tool = findByTestId(tree, "tool-block");
  assert.equal(attr(tool, "data-call-id"), "call-1");
  assert.equal(attr(tool, "data-status"), "running");
  assert.equal(attr(tool, "data-renderer"), "execute");
  assert.equal(attr(findByTestId(tool, "tool-details"), "open"), true, "running tools are open by default");
  assert.equal(textOf(findByTestId(tool, "tool-title")), "Bash");
  assert.equal(textOf(findByTestId(tool, "tool-command-summary")), "npm test", "collapsed summary shows the command");
  // ZCode DESKTOP execute: `$` prompt + monospace command in the body
  const cmd = findByTestId(tool, "execute-command");
  assert.ok(cmd, "execute command block renders");
  assert.equal(textOf(findByTestId(cmd, "execute-command-prompt")), "$");
  assert.ok(hasText(findByTestId(cmd, "execute-command-text"), "npm test"));
  assert.equal(textOf(findByTestId(tool, "tool-progress")), "running 4 tests");
  assert.equal(attr(findByTestId(tool, "tool-progress"), "role"), "status");
  assert.equal(textOf(findByTestId(tool, "execute-cwd")), "packages/ui");
});

test("tool can be collapsed via options; collapsed failed tool still shows the error", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Bash", input: { command: "bad" } }),
    ev(EventType.ToolError, "x2", { callId: "c", error: "exit 1 with token=secret" }),
  ]);
  const collapsed = viewFor(s, { toolOpen: new Map([["c", false]]) });
  const tool = findByTestId(collapsed, "tool-block");
  assert.equal(attr(findByTestId(tool, "tool-details"), "open"), false);
  const err = findByTestId(tool, "tool-error");
  assert.ok(err, "collapsed failed tool surfaces the error");
  assert.equal(attr(err, "role"), "alert");
  assert.ok(textOf(err).includes("exit 1"));
  assert.ok(!textOf(err).includes("secret"), "redacted");
});

test("edit tool renders an inline diff with real line numbers, never the full patch verbatim", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Edit", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c", display: { kind: "file_diff", path: "a.ts",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new" } }),
  ]);
  const tree = viewFor(s);
  const diff = findByTestId(tree, "edit-diff");
  assert.ok(diff, "edit diff block renders from the result display");
  const unified = findByTestId(diff, "edit-diff-unified");
  assert.ok(unified, "unified diff view renders");
  assert.ok(findByTestId(diff, "edit-diff-split"), "split diff view renders for responsive layout");
  const bodyText = textOf(unified);
  assert.ok(bodyText.includes("new"), "added line content is shown");
  assert.ok(!bodyText.includes("--- a/a.ts"), "file headers are not dumped");
  assert.ok(!bodyText.includes("@@ -1,2"), "hunk headers are not dumped");
  // Real line numbers from the @@ -1,2 +1,2 @@ header, not synthesized
  const oldLines = findAllByTestId(unified, "edit-diff-old-line").map(n => textOf(n));
  const newLines = findAllByTestId(unified, "edit-diff-new-line").map(n => textOf(n));
  assert.ok(oldLines.includes("1") && oldLines.includes("2"), "old gutter carries real line numbers");
  assert.ok(newLines.includes("1") && newLines.includes("2"), "new gutter carries real line numbers");
});

test("waiting placeholder appears before first token and disappears once progress arrives", () => {
  const waiting = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  const waitingTree = viewFor(waiting);
  const ph = findByTestId(waitingTree, "task-waiting");
  assert.ok(ph);
  assert.equal(attr(ph, "role"), "status");
  assert.equal(attr(waitingTree, "aria-busy"), "true");
  const progressTree = viewFor(streamScenario());
  assert.equal(findByTestId(progressTree, "task-waiting"), null);
  assert.equal(attr(progressTree, "aria-busy"), "false");
});

test("normal completion has no extra transcript status row or invented success message", () => {
  const withSummary = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.TaskFinished, "t1", { outcome: "completed", summary: "All green" }),
  ]);
  const tree = viewFor(withSummary);
  assert.equal(findByTestId(tree, "status-line"), null);
  assert.equal(withSummary.taskSummary, "All green");
  // without a host summary, no success text is invented
  const noSummary = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t2", { taskId: "T" }),
    ev(EventType.TaskFinished, "t3", { outcome: "completed" }),
  ]);
  const noTree = viewFor(noSummary);
  assert.equal(findByTestId(noTree, "task-summary"), null);
  assert.equal(findByTestId(noTree, "status-line"), null);
  assert.doesNotMatch(textOf(noTree), /succeeded|success|done!/i, "no invented success prose");
});

test("a failed task surfaces a redacted, bounded error with role=alert", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.TaskFinished, "t1", { outcome: "failed", error: "token=abc exploded " + "x".repeat(500) }),
  ]);
  const tree = viewFor(s);
  const err = findByTestId(tree, "task-error");
  assert.ok(err);
  assert.equal(attr(err, "role"), "alert");
  assert.ok(!textOf(err).includes("abc"), "secret redacted");
  assert.ok(textOf(err).length < 300, "error bounded");
});

test("plan dock shows completed/total and the current in-progress item", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.PlanUpdated, "p1", { items: [
      { id: "a", content: "one", status: "completed" },
      { id: "b", content: "two", status: "in_progress" },
    ] }),
  ]);
  const tree = viewFor(s);
  const dock = findByTestId(tree, "plan-dock");
  assert.ok(dock);
  assert.equal(textOf(findByTestId(dock, "plan-count")), "1/2");
  assert.equal(textOf(findByTestId(dock, "plan-current")), "two");
});

test("empty state renders when there is no content and no running task", () => {
  const tree = viewFor(initialState(), { emptyState: h("p", { "data-testid": "empty" }, "Welcome") });
  assert.ok(findByTestId(tree, "empty"));
});

test("jump-to-latest button renders only when following is false", () => {
  const s = streamScenario();
  assert.equal(findByTestId(viewFor(s), "jump-latest"), null);
  const tree = viewFor(s, { following: false });
  assert.ok(findByTestId(tree, "jump-latest"));
});

test("rootProps merge onto the root without clobbering selectors", () => {
  const tree = viewFor(streamScenario(), { rootProps: { id: "host-shell", onClick: "delegated" } });
  const root = findByTestId(tree, "harness-timeline");
  assert.equal(attr(root, "id"), "host-shell");
  assert.equal(attr(root, "role"), "log");
  assert.equal(attr(root, "onClick"), "delegated");
});

test("thinking.start alone produces no thought block in the view", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ThinkingStart, "k1", { itemId: "th-only-start" }),
  ]);
  const tree = viewFor(s);
  assert.equal(findByTestId(tree, "thought-block"), null, "reasoning_start alone creates no transcript item");
  assert.ok(findByTestId(tree, "task-waiting"), "still waiting for the first token");
});

test("replayed state is idempotent in the view: identical trees across a duplicate event", () => {
  const s1 = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.TextDelta, "a1", { itemId: "t", delta: "hi" }),
  ]);
  const s2 = reduce(s1, ev(EventType.TextDelta, "a1", { itemId: "t", delta: "hi" }));
  assert.equal(s2, s1);
  assert.deepEqual(viewFor(s1), viewFor(s2));
});
