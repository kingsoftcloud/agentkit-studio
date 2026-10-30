import test from "node:test";
import assert from "node:assert/strict";
import { EventType } from "../src/protocol.mjs";
import { initialState, reduce, reduceAll } from "../src/reducer.mjs";
import { createHarnessComponents, resolveVerticalMaskState, verticalMaskStyle, horizontalMaskStyle } from "../src/react-binding.mjs";
import { isElement } from "../src/view.mjs";
import { findByTestId, findAllByTestId, attr, textOf } from "./helpers.mjs";

// Minimal React shim: enough hooks to drive HarnessTimeline through one mount
// plus state-driven re-renders, and a createElement that returns plain objects
// so node:test can walk the tree. FollowBox/ScrollEnd are inert element types
// here (createElement does not render children components), which is exactly
// what lets us assert the wiring without a real reconciler.
function makeShim() {
  const instances = new Map();
  let current = null;
  let hookIdx = 0;

  function createElement(type, props, ...children) {
    return { $$typeof: Symbol.for("agentkit.harness-ui.element"), type, props: props == null ? {} : props, children };
  }
  const shim = {
    createElement,
    Fragment: Symbol("Fragment"),
    useState(init) {
      const h = current.hooks[hookIdx] || (current.hooks[hookIdx] = {});
      hookIdx += 1;
      if (!h.initialized) { h.state = typeof init === "function" ? init() : init; h.initialized = true; }
      const setState = (v) => { h.state = typeof v === "function" ? v(h.state) : v; current.dirty = true; };
      return [h.state, setState];
    },
    useRef(v) { const h = current.hooks[hookIdx] || (current.hooks[hookIdx] = {}); hookIdx += 1; if (!h.initialized) { h.ref = { current: v }; h.initialized = true; } return h.ref; },
    useEffect(fn, deps) {
      const h = current.hooks[hookIdx] || (current.hooks[hookIdx] = {});
      hookIdx += 1;
      const changed = !h.initialized || !deps || deps.length === 0 || deps.some((d, i) => !Object.is(d, h.deps?.[i]));
      h.deps = deps;
      if (changed) { h.initialized = true; current.effects.push(fn); }
    },
    useCallback(fn) { const h = current.hooks[hookIdx] || (current.hooks[hookIdx] = {}); hookIdx += 1; if (!h.initialized) { h.cb = fn; h.initialized = true; } return h.cb; },
    useMemo(fn) { const h = current.hooks[hookIdx] || (current.hooks[hookIdx] = {}); hookIdx += 1; if (!h.initialized) { h.value = fn(); h.initialized = true; } return h.value; },
  };

  function render(Comp, props) {
    let inst = instances.get(Comp);
    if (!inst) { inst = { hooks: [], effects: [], dirty: false, cleanups: [] }; instances.set(Comp, inst); }
    // Reset hook pointer and run the component body. Effects queued during the
    // run are collected, then applied. If an effect calls setState (dirty), the
    // body re-runs with the updated hook states until it settles. The deps
    // check in useEffect prevents the same effect from re-queueing within a
    // re-render unless its deps actually changed.
    function run() {
      current = inst; hookIdx = 0; inst.effects = [];
      const element = Comp(props);
      for (const fn of inst.effects) {
        const cleanup = fn();
        if (typeof cleanup === "function") inst.cleanups.push(cleanup);
      }
      return element;
    }
    let element = run();
    let guard = 0;
    while (inst.dirty && guard++ < 8) { inst.dirty = false; element = run(); }
    return element;
  }

  return { React: shim, render };
}

function ev(type, id, extra = {}) { return { v: 1, type, id, ...extra }; }

function fakeActionEl(attrs) {
  return {
    getAttribute: (n) => attrs[n] ?? null,
    closest: (sel) => sel === "[data-action]" ? { getAttribute: (n) => attrs[n] ?? null } : null,
  };
}

function click(root, actionEl) {
  const onClick = root.props.onClick;
  assert.equal(typeof onClick, "function", "root carries a delegated onClick handler");
  onClick({ target: actionEl, preventDefault() {} });
}

test("HarnessTimeline renders the timeline root with delegated onClick and shell class", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [ev(EventType.TaskStarted, "t0", { taskId: "T" })]);
  const tree = render(HarnessTimeline, { state });
  assert.ok(isElement(tree));
  const root = findByTestId(tree, "harness-timeline");
  assert.ok(root);
  assert.equal(typeof root.props.onClick, "function");
  assert.ok(root.props.className.includes("harness-timeline-shell"));
});

test("delegated click dispatches open-file with path/kind/callId", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Edit", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_diff", path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" } }),
  ]);
  const calls = [];
  const tree = render(HarnessTimeline, { state, onOpenFile: (t) => calls.push(t) });
  const root = findByTestId(tree, "harness-timeline");
  const chip = findByTestId(tree, "edit-chip");
  assert.ok(chip, "edit chip renders and is clickable when onOpenFile is provided");
  click(root, fakeActionEl({ "data-action": "open-file", "data-path": "a.ts", "data-kind": "patch", "data-call-id": "c1" }));
  assert.deepEqual(calls[0], { path: "a.ts", kind: "patch", callId: "c1" });
});

test("delegated click dispatches copy/open-terminal/retrieve-diff/jump-latest", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [ev(EventType.TaskStarted, "t0", { taskId: "T" })]);
  const copy = []; const term = []; const diff = []; const jump = [];
  const tree = render(HarnessTimeline, {
    state, onCopy: (t) => copy.push(t), onOpenTerminal: (t) => term.push(t),
    onRetrieveFullDiff: (t) => diff.push(t), onJumpLatest: () => jump.push(1),
  });
  const root = findByTestId(tree, "harness-timeline");
  click(root, fakeActionEl({ "data-action": "copy", "data-copy-text": "hello" }));
  click(root, fakeActionEl({ "data-action": "open-terminal", "data-call-id": "c1", "data-cwd": "/repo" }));
  click(root, fakeActionEl({ "data-action": "retrieve-diff", "data-call-id": "c1", "data-path": "a.ts" }));
  click(root, fakeActionEl({ "data-action": "jump-latest" }));
  assert.deepEqual(copy, ["hello"]);
  assert.deepEqual(term, [{ callId: "c1", cwd: "/repo" }]);
  assert.deepEqual(diff, [{ callId: "c1", path: "a.ts" }]);
  assert.deepEqual(jump, [1]);
});

test("delegated click on a thought-toggle prevents default and records the user toggle", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ThinkingDelta, "k1", { itemId: "th-1", delta: "reasoning" }),
  ]);
  const tree = render(HarnessTimeline, { state });
  const root = findByTestId(tree, "harness-timeline");
  let prevented = false;
  // A thought-toggle summary whose parent details has data-item-id and open=false
  const fakeSummary = {
    closest: (sel) => sel.includes("thought-toggle") ? {
      parentElement: { getAttribute: (n) => n === "data-item-id" ? "th-1" : null, open: false },
    } : null,
  };
  root.props.onClick({ target: fakeSummary, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "clicking a thought toggle prevents the native details toggle");
});

test("a host-opened thought auto-collapses when streaming ends and the user did not click it", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const streaming = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ThinkingStart, "k0", { itemId: "th-1" }),
    ev(EventType.ThinkingDelta, "k1", { itemId: "th-1", delta: "still thinking" }),
  ]);
  // Host opens it via initiallyExpandedThoughts (NOT a user click). While
  // streaming it is open.
  let tree = render(HarnessTimeline, { state: streaming, initiallyExpandedThoughts: ["th-1"] });
  assert.equal(attr(findByTestId(tree, "thought-details"), "open"), true, "host-opened thought is open while streaming");
  // Streaming ends; the autoCollapseKey transitions null→done and the binding
  // collapses the non-user-interacted thought back to its summary.
  const done = reduce(streaming, ev(EventType.ThinkingDone, "k2", { itemId: "th-1", text: "still thinking", duration: 3 }));
  tree = render(HarnessTimeline, { state: done, initiallyExpandedThoughts: ["th-1"] });
  assert.equal(attr(findByTestId(tree, "thought-details"), "open"), false, "auto-collapsed on stream end (no user interaction)");
  const label = findByTestId(tree, "thought-label");
  assert.match(textOf(label), /3s/, "host-supplied duration is shown; nothing invented");
});

test("a thought the user clicked open stays open when streaming ends (no auto-collapse)", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const streaming = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ThinkingStart, "k0", { itemId: "th-1" }),
    ev(EventType.ThinkingDelta, "k1", { itemId: "th-1", delta: "thinking" }),
  ]);
  // Mount collapsed (default), then simulate the user clicking the toggle open.
  let tree = render(HarnessTimeline, { state: streaming });
  const root = findByTestId(tree, "harness-timeline");
  root.props.onClick({
    target: {
      closest: (sel) => sel.includes("thought-toggle") ? {
        parentElement: { getAttribute: (n) => n === "data-item-id" ? "th-1" : null, open: false },
      } : null,
    },
    preventDefault() {},
  });
  // Re-render: the click set thoughtOpen[th-1]=true and recorded user interaction.
  tree = render(HarnessTimeline, { state: streaming });
  assert.equal(attr(findByTestId(tree, "thought-details"), "open"), true, "user click opened the thought");
  // Streaming ends; because the user interacted, auto-collapse must NOT fire.
  const done = reduce(streaming, ev(EventType.ThinkingDone, "k2", { itemId: "th-1", text: "thinking" }));
  tree = render(HarnessTimeline, { state: done });
  assert.equal(attr(findByTestId(tree, "thought-details"), "open"), true, "user-opened thought stays open across stream end");
});

test("renderText is invoked for streaming assistant text but not for user messages", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.TextDelta, "a1", { itemId: "txt-1", delta: "hello" }),
  ]);
  const seen = [];
  render(HarnessTimeline, { state, renderText: (text, meta) => { seen.push({ text, streaming: meta.streaming }); return text; } });
  assert.deepEqual(seen, [{ text: "hello", streaming: true }]);
});

test("delegated click dispatches inspect-tool with callId for non-toggleable read/search", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_read", path: "a.ts" } }),
  ]);
  const inspect = [];
  const tree = render(HarnessTimeline, { state, onInspectTool: (t) => inspect.push(t) });
  const root = findByTestId(tree, "harness-timeline");
  click(root, fakeActionEl({ "data-action": "inspect-tool", "data-call-id": "c1" }));
  assert.deepEqual(inspect, [{ callId: "c1" }]);
});

test("resolveVerticalMaskState reports top/bottom fades from scroll metrics", () => {
  // Content fits ⇒ no mask.
  assert.deepEqual(resolveVerticalMaskState({ clientHeight: 100, scrollHeight: 100, scrollTop: 0 }),
    { showTop: false, showBottom: false });
  // Overflow at the top only.
  assert.deepEqual(resolveVerticalMaskState({ clientHeight: 50, scrollHeight: 200, scrollTop: 0 }),
    { showTop: false, showBottom: true });
  // Overflow on both sides mid-scroll.
  assert.deepEqual(resolveVerticalMaskState({ clientHeight: 50, scrollHeight: 200, scrollTop: 50 }),
    { showTop: true, showBottom: true });
  // Pinned to the bottom ⇒ only the top fades.
  assert.deepEqual(resolveVerticalMaskState({ clientHeight: 50, scrollHeight: 200, scrollTop: 150 }),
    { showTop: true, showBottom: false });
});

test("verticalMaskStyle and horizontalMaskStyle build a mask only when needed", () => {
  assert.equal(verticalMaskStyle({ showTop: false, showBottom: false }), undefined);
  const both = verticalMaskStyle({ showTop: true, showBottom: true });
  assert.match(both.maskImage, /linear-gradient\(to bottom/);
  assert.match(both.maskImage, /transparent 0px/);
  assert.match(both.maskImage, /transparent 100%/);
  assert.equal(horizontalMaskStyle(false), undefined);
  assert.match(horizontalMaskStyle(true).maskImage, /linear-gradient\(to right/);
});

test("command output freezes a rolling tail while reading, across completion, and resumes at bottom", () => {
  const { React, render } = makeShim();
  const { HarnessTimeline } = createHarnessComponents(React);
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t", { taskId: "T" }),
    ev(EventType.ToolScheduled, "s", { callId: "shell", name: "run_command", input: { command: "node job.mjs" } }),
    ev(EventType.ToolStarted, "r", { callId: "shell" }),
    ev(EventType.ToolProgress, "p", { callId: "shell", display: { kind: "command_output", stdout: "first window" } }),
  ]);
  const tree = render(HarnessTimeline, { state, initiallyExpandedTools: ["shell"] });
  function find(node) {
    if (!node || typeof node !== "object") return null;
    if (node.props?.freezeWhileReading) return node;
    for (const child of node.children || []) { const value = find(child); if (value) return value; }
    return null;
  }
  const viewport = find(tree);
  assert.ok(viewport, "execute output owns its reading snapshot");
  assert.equal(viewport.props.props["data-call-id"], "shell", "identity survives preview/result transition");
  const body = { scrollHeight: 500, clientHeight: 100, scrollTop: 0 };
  let node = render(viewport.type, viewport.props);
  node.props.ref.current = body;
  node = render(viewport.type, viewport.props);
  assert.equal(body.scrollTop, 500);
  body.scrollTop = 40;
  node.props.onScroll({ currentTarget: body });
  const next = { ...viewport.props, renderChildren: ["new rolling tail"] };
  node = render(viewport.type, next);
  assert.equal(textOf(node), "first window");
  assert.equal(body.scrollTop, 40);
  assert.equal(node.props["data-following"], "false");
  const final = { ...next, streaming: false, renderChildren: ["final summary"] };
  node = render(viewport.type, final);
  assert.equal(textOf(node), "first window", "completion preserves the reader's snapshot");
  body.scrollTop = 400;
  node.props.onScroll({ currentTarget: body });
  node = render(viewport.type, final);
  assert.equal(textOf(node), "final summary");
  assert.equal(node.props["data-following"], "true");
  assert.equal(body.scrollTop, 500);
});
