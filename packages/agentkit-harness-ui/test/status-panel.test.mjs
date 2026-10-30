// Source-semantic tests for the host-injected status panel.
// Run with: node --test test/status-panel.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStatusPanelComponents,
  statusPanelStyles,
  getStatusPanelTodoFocusWindow,
  resolveStatusPanelMiniSummary,
  classifyRowsByStatus,
  isEndedStatus,
  planStatusKind,
  DEFAULT_LABELS,
} from "../src/status-panel.mjs";

// ── Minimal React with hooks (single SSR render) ──────────────────────────

function createTestReact() {
  const hookStack = [];
  let hookIndex = 0;

  function createElement(type, props, ...children) {
    const flat = [];
    const push = (c) => {
      if (c == null || c === false || c === true) return;
      if (Array.isArray(c)) {
        c.forEach(push);
        return;
      }
      flat.push(c);
    };
    children.forEach(push);
    return { type, props: props || {}, children: flat };
  }

  const React = {
    createElement,
    useState(initial) {
      const arr = hookStack[hookStack.length - 1];
      const i = hookIndex++;
      if (!(i in arr)) arr[i] = typeof initial === "function" ? initial() : initial;
      return [arr[i], () => {}];
    },
    useMemo(fn) {
      return fn();
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      const arr = hookStack[hookStack.length - 1];
      const i = hookIndex++;
      if (!(i in arr)) arr[i] = { current: initial };
      return arr[i];
    },
    memo(Comp) {
      return Comp;
    },
  };

  function render(vnode) {
    if (vnode == null || vnode === false || vnode === true) return null;
    if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
    if (Array.isArray(vnode)) return vnode.map(render).filter((x) => x != null);
    if (typeof vnode === "object") {
      if (typeof vnode.type === "function") {
        const hooks = [];
        hookStack.push(hooks);
        hookIndex = 0;
        let result;
        try {
          result = vnode.type({ ...vnode.props, children: vnode.children });
        } finally {
          hookStack.pop();
        }
        return render(result);
      }
      const children = vnode.children.map(render).filter((x) => x != null);
      return { type: vnode.type, props: vnode.props, children };
    }
    return null;
  }
  React._render = render;
  return React;
}

// ── Tree query helpers ────────────────────────────────────────────────────

function walk(node, visit) {
  if (node == null || typeof node === "string") return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (typeof node === "object") {
    visit(node);
    (node.children || []).forEach((c) => walk(c, visit));
  }
}

function findAll(root, pred) {
  const out = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") return (node.children || []).map(textOf).join("");
  return "";
}

const byAttr = (name, value) => (n) => n.props && n.props[name] === value;
const hasAttr = (name) => (n) => n.props && n.props[name] != null;

// ── Setup ─────────────────────────────────────────────────────────────────

const React = createTestReact();
const h = React.createElement;
const { ConversationStatusPanel } = createStatusPanelComponents(React);
const L = DEFAULT_LABELS;

function render(props) {
  return React._render(h(ConversationStatusPanel, props));
}

function makeItem(id, content, status) {
  return { id, content, status };
}

// ── Tests: pure model helpers ─────────────────────────────────────────────

test("planStatusKind normalises both snake_case and camelCase", () => {
  assert.equal(planStatusKind("completed"), "completed");
  assert.equal(planStatusKind("in_progress"), "in_progress");
  assert.equal(planStatusKind("inProgress"), "in_progress");
  assert.equal(planStatusKind("pending"), "pending");
  assert.equal(planStatusKind("unknown"), "pending");
  assert.equal(planStatusKind(undefined), "pending");
});

test("isEndedStatus only treats explicit terminal values as ended", () => {
  assert.equal(isEndedStatus("done"), true);
  assert.equal(isEndedStatus("Completed"), true);
  assert.equal(isEndedStatus("cancelled"), true);
  assert.equal(isEndedStatus("error"), true);
  assert.equal(isEndedStatus("running"), false);
  assert.equal(isEndedStatus("pending"), false);
  assert.equal(isEndedStatus(undefined), false);
  assert.equal(isEndedStatus(null), false);
});

test("classifyRowsByStatus splits current vs ended by the status key", () => {
  const { current, ended } = classifyRowsByStatus(
    [{ id: "a", state: "running" }, { id: "b", state: "done" }, { id: "c" }],
    "state",
  );
  assert.deepEqual(current.map((r) => r.id), ["a", "c"]);
  assert.deepEqual(ended.map((r) => r.id), ["b"]);
});

test("focus window: <= 6 items render in full, no folding", () => {
  const items = Array.from({ length: 6 }, (_, i) => makeItem(`i${i}`, `t${i}`, "pending"));
  const win = getStatusPanelTodoFocusWindow(items);
  assert.equal(win.compact, false);
  assert.equal(win.precedingItems.length, 0);
  assert.equal(win.followingItems.length, 0);
  assert.equal(win.focusItems.length, 6);
});

test("focus window: > 6 items centre a 3-item window on the running item", () => {
  const items = Array.from({ length: 7 }, (_, i) =>
    makeItem(`i${i}`, `t${i}`, i === 3 ? "in_progress" : "pending"),
  );
  const win = getStatusPanelTodoFocusWindow(items);
  assert.equal(win.compact, true);
  assert.equal(win.precedingItems.length, 3);
  assert.equal(win.focusItems.length, 3);
  assert.equal(win.followingItems.length, 1);
  assert.equal(win.focusItems[0].id, "i3");
  assert.equal(win.focusItems[0].status, "in_progress");
});

test("focus window: all completed centres on the last three", () => {
  const items = Array.from({ length: 8 }, (_, i) => makeItem(`i${i}`, `t${i}`, "completed"));
  const win = getStatusPanelTodoFocusWindow(items);
  assert.equal(win.compact, true);
  assert.equal(win.precedingItems.length, 5);
  assert.equal(win.focusItems.length, 3);
  assert.equal(win.followingItems.length, 0);
  assert.equal(win.focusItems[0].id, "i5");
});

// ── Tests: mini-summary priority ──────────────────────────────────────────

test("mini-summary priority: current plan beats Git and completed", () => {
  const model = {
    git: { branchName: "main", added: 5, removed: 2, dirtyFileCount: 3 },
    plan: {
      items: [makeItem("1", "running one", "in_progress"), makeItem("2", "done", "completed")],
      completedCount: 1,
      totalCount: 2,
    },
    terminals: [{ id: "t", title: "t", state: "running" }],
    isRunning: true,
  };
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "currentPlan");
});

test("mini-summary priority: Git beats completed plan", () => {
  const model = {
    git: { branchName: "main", added: 5, removed: 2, dirtyFileCount: 0 },
    plan: {
      items: [makeItem("1", "done", "completed")],
      completedCount: 1,
      totalCount: 1,
    },
  };
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "git");
});

test("mini-summary priority: completed plan beats running count", () => {
  const model = {
    plan: {
      items: [makeItem("1", "done", "completed")],
      completedCount: 1,
      totalCount: 1,
    },
    terminals: [{ id: "t", title: "t", state: "running" }],
  };
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "completedPlan");
});

test("mini-summary priority: running count beats ended directory", () => {
  const model = {
    terminals: [
      { id: "t1", title: "t1", state: "running" },
      { id: "t2", title: "t2", state: "done" },
    ],
  };
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "runningCount");
});

test("mini-summary priority: ended directory is the meaningful non-empty fallback", () => {
  const model = {
    terminals: [{ id: "t", title: "t", state: "done" }],
    agents: [{ runId: "a", phase: "completed", title: "a" }],
  };
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "endedDirectory");
});

test("mini-summary priority: isRunning is the final fallback before null", () => {
  assert.equal(resolveStatusPanelMiniSummary({ isRunning: true }, L).key, "running");
  assert.equal(resolveStatusPanelMiniSummary({}, L), null);
});

test("mini-summary: unknown Git (added+removed == 0) does not promote the Git branch", () => {
  const model = {
    git: { branchName: "main", added: 0, removed: 0, dirtyFileCount: 0 },
    plan: { items: [makeItem("1", "done", "completed")], completedCount: 1, totalCount: 1 },
  };
  // No fake Git summary; falls through to the completed plan item.
  assert.equal(resolveStatusPanelMiniSummary(model, L).key, "completedPlan");
});

// ── Tests: rendered component ─────────────────────────────────────────────

test("empty model renders nothing", () => {
  assert.equal(render({ model: {} }), null);
  assert.equal(render({ model: { isRunning: false } }), null);
});

test("unknown Git: null Git yields no Git section and no fabricated +0/-0", () => {
  const tree = render({
    model: { plan: { items: [makeItem("1", "x", "pending")], completedCount: 0, totalCount: 1 } },
    variant: "panel",
  });
  assert.equal(findAll(tree, byAttr("data-status-section", "environment")).length, 0);
  assert.ok(!textOf(tree).includes("+0"));
});

test("real Git delta counts and branch render in the Git section", () => {
  const tree = render({
    model: {
      git: { branchName: "feature/x", added: 7, removed: 3, dirtyFileCount: 2 },
    },
    variant: "panel",
    onOpenGitReview: () => {},
    onGitBranch: () => {},
    onGitCommitPush: () => {},
  });
  const gitSection = findAll(tree, byAttr("data-status-section", "environment"))[0];
  assert.ok(gitSection);
  const txt = textOf(gitSection);
  assert.ok(txt.includes("+7"));
  assert.ok(txt.includes("-3"));
  assert.ok(txt.includes("feature/x"));
  assert.ok(txt.includes("· 2"));
  const actions = findAll(gitSection, (n) => n.type === "button" && hasAttr("data-git-action")(n));
  assert.deepEqual(actions.map((a) => a.props["data-git-action"]).sort(), ["branch", "commit-push", "review"]);
});

test("Git with zero changes renders honest +0/-0, not fabricated nonzero", () => {
  const tree = render({
    model: { git: { branchName: "main", added: 0, removed: 0, dirtyFileCount: 0 } },
    variant: "panel",
  });
  const gitSection = findAll(tree, byAttr("data-status-section", "environment"))[0];
  assert.ok(gitSection);
  const txt = textOf(gitSection);
  assert.ok(txt.includes("+0"));
  assert.ok(txt.includes("-0"));
  assert.ok(!txt.includes("+1"));
});

test("all completed todos: fold uses the completed-fold label and header is complete", () => {
  const items = Array.from({ length: 8 }, (_, i) => makeItem(`i${i}`, `task ${i}`, "completed"));
  const tree = render({
    model: { plan: { items, completedCount: 8, totalCount: 8 } },
    variant: "panel",
  });
  const planSection = findAll(tree, byAttr("data-status-section", "plan"))[0];
  assert.ok(planSection);
  const txt = textOf(planSection);
  assert.ok(txt.includes("已完成 5 项"), `expected completed-fold label, got: ${txt}`);
  const count = findAll(planSection, hasAttr("data-plan-complete"))[0];
  assert.equal(count.props["data-plan-complete"], "true");
  assert.ok(textOf(count).includes("8/8"));
});

test("pending tail keeps the three pending rows and folds only the five completed predecessors", () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => makeItem(`d${i}`, `done ${i}`, "completed")),
    ...Array.from({ length: 3 }, (_, i) => makeItem(`p${i}`, `wait ${i}`, "pending")),
  ];
  const win = getStatusPanelTodoFocusWindow(items);
  assert.equal(win.compact, true);
  assert.equal(win.precedingItems.length, 5);
  assert.equal(win.followingItems.length, 0);
  // preceding are all completed -> completed fold label
  const tree = render({
    model: { plan: { items, completedCount: 5, totalCount: 8 } },
    variant: "panel",
  });
  const planSection = findAll(tree, byAttr("data-status-section", "plan"))[0];
  assert.ok(textOf(planSection).includes("已完成 5 项"));
});

test("collapsed SSR: terminals section defaults closed, rows absent", () => {
  const tree = render({
    model: { terminals: [{ id: "t1", title: "bash one", state: "running" }] },
    variant: "panel",
  });
  const terminalsSection = findAll(tree, byAttr("data-status-section", "terminals"))[0];
  assert.ok(terminalsSection);
  assert.equal(terminalsSection.props["data-state"], "closed");
  // No live rows rendered while collapsed.
  assert.equal(findAll(terminalsSection, byAttr("data-row-kind", "terminal")).length, 0);
});

test("expanded SSR: controlled-open terminals section renders the rows", () => {
  const tree = render({
    model: { terminals: [{ id: "t1", title: "bash one", state: "running" }] },
    variant: "panel",
    terminalSectionOpen: true,
  });
  const terminalsSection = findAll(tree, byAttr("data-status-section", "terminals"))[0];
  assert.equal(terminalsSection.props["data-state"], "open");
  const rows = findAll(terminalsSection, byAttr("data-row-kind", "terminal"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props["data-row-state"], "running");
  assert.ok(textOf(rows[0]).includes("bash one"));
});

test("auto variant uses a CSS container query, not display-mode state", () => {
  const tree = render({
    model: { git: { branchName: "main", added: 1, removed: 0, dirtyFileCount: 0 } },
    variant: "auto",
  });
  const aside = findAll(tree, (n) => n.type === "aside")[0];
  assert.ok(aside);
  assert.equal(aside.props["data-display-mode"], "auto");
  assert.equal(aside.props["data-state"], "expanded");
  // The auto decision lives in CSS, not in a data attribute.
  assert.ok(statusPanelStyles.includes("@container"));
  assert.ok(statusPanelStyles.includes("1280px"));
  assert.ok(statusPanelStyles.includes("container-name:harness-status-panel"));
});

test("explicit mini and panel overrides are reflected on the shell", () => {
  const mini = render({
    model: { git: { branchName: "main", added: 1, removed: 0, dirtyFileCount: 0 } },
    variant: "mini",
  });
  const miniAside = findAll(mini, (n) => n.type === "aside")[0];
  assert.equal(miniAside.props["data-display-mode"], "mini");
  assert.equal(miniAside.props["data-state"], "collapsed");
  assert.equal(findAll(mini, byAttr("data-status-section", "environment")).length, 0);

  const panel = render({
    model: { git: { branchName: "main", added: 1, removed: 0, dirtyFileCount: 0 } },
    variant: "panel",
  });
  const panelAside = findAll(panel, (n) => n.type === "aside")[0];
  assert.equal(panelAside.props["data-display-mode"], "panel");
  assert.equal(panelAside.props["data-state"], "expanded");
});

test("current/end status: running rows sit in the section, ended rows in the finished-child directory", () => {
  const tree = render({
    model: {
      terminals: [
        { id: "live", title: "running bash", state: "running" },
        { id: "dead", title: "finished bash", state: "done" },
      ],
      agents: [
        { runId: "alive", sessionId: "s1", parentRunId: "r", role: "researcher", title: "live agent", phase: "running" },
        { runId: "gone", sessionId: "s2", parentRunId: "r", role: "coder", title: "done agent", phase: "completed" },
      ],
    },
    variant: "panel",
    terminalSectionOpen: true,
    agentSectionOpen: true,
  });
  // current (running) rows are present in the live sections
  const liveTerminalRows = findAll(tree, (n) => n.props && n.props["data-row-kind"] === "terminal" && n.props["data-row-state"] === "running" && n.props["data-row-ended"] == null);
  assert.equal(liveTerminalRows.length, 1);
  const liveAgentRows = findAll(tree, (n) => n.props && n.props["data-row-kind"] === "agent" && n.props["data-row-state"] === "running" && n.props["data-row-ended"] == null);
  assert.equal(liveAgentRows.length, 1);
  // ended rows live under the finished-child directory affordance
  const endedDirectories = findAll(tree, hasAttr("data-ended-kind"));
  const endedTerminalDir = endedDirectories.find((n) => n.props["data-ended-kind"] === "terminal");
  const endedAgentDir = endedDirectories.find((n) => n.props["data-ended-kind"] === "agent");
  assert.ok(endedTerminalDir, "expected a finished-child directory for ended terminals");
  assert.ok(endedAgentDir, "expected a finished-child directory for ended agents");
  assert.ok(textOf(endedTerminalDir).includes("finished bash"));
  assert.ok(textOf(endedAgentDir).includes("done agent"));
  assert.equal(endedTerminalDir.props["data-ended-kind"], "terminal");
  // running rows are not flagged as ended
  assert.equal(liveTerminalRows[0].props["data-row-ended"], undefined);
});

test("no fabricated mutation controls: no stop buttons without a real onCancel", () => {
  const tree = render({
    model: { terminals: [{ id: "t", title: "bash", state: "running", canCancel: true }] },
    variant: "panel",
    terminalSectionOpen: true,
  });
  assert.equal(findAll(tree, hasAttr("data-row-cancel")).length, 0);
  // No pause/resume goal controls exist at all (the host gives no such callbacks).
  assert.equal(findAll(tree, (n) => n.props && (n.props["data-goal-action"] || n.props["data-goal-elapsed-seconds"])).length, 0);
});

test("stop button requires both a real onCancel and row.canCancel === true", () => {
  const withStop = render({
    model: { terminals: [{ id: "t", title: "bash", state: "running", canCancel: true }] },
    variant: "panel",
    terminalSectionOpen: true,
    onCancel: () => {},
  });
  assert.equal(findAll(withStop, hasAttr("data-row-cancel")).length, 1);

  const onCancelButNotCancellable = render({
    model: { terminals: [{ id: "t", title: "bash", state: "running", canCancel: false }] },
    variant: "panel",
    terminalSectionOpen: true,
    onCancel: () => {},
  });
  assert.equal(findAll(onCancelButNotCancellable, hasAttr("data-row-cancel")).length, 0);

  const onCancelButAbsentFlag = render({
    model: { terminals: [{ id: "t", title: "bash", state: "running" }] },
    variant: "panel",
    terminalSectionOpen: true,
    onCancel: () => {},
  });
  assert.equal(findAll(onCancelButAbsentFlag, hasAttr("data-row-cancel")).length, 0);
});

test("no fabricated mutation controls: Git actions only render for supplied callbacks", () => {
  // Git facts (changes/branch) render read-only; no action buttons without callbacks.
  const tree = render({
    model: { git: { branchName: "main", added: 2, removed: 1, dirtyFileCount: 0 } },
    variant: "panel",
  });
  const actionButtons = findAll(tree, (n) => n.type === "button" && hasAttr("data-git-action")(n));
  assert.equal(actionButtons.length, 0);
  // Facts are still shown.
  const txt = textOf(tree);
  assert.ok(txt.includes("+2"));
  assert.ok(txt.includes("main"));

  const withCallbacks = render({
    model: { git: { branchName: "main", added: 2, removed: 1, dirtyFileCount: 0 } },
    variant: "panel",
    onOpenGitReview: () => {},
    onGitCommitPush: () => {},
  });
  const withActionButtons = findAll(withCallbacks, (n) => n.type === "button" && hasAttr("data-git-action")(n));
  assert.deepEqual(
    withActionButtons.map((b) => b.props["data-git-action"]).sort(),
    ["commit-push", "review"],
  );
});

test("header exposes collapse-to-mini and display-mode-auto actions", () => {
  const tree = render({
    model: { git: { branchName: "main", added: 1, removed: 0, dirtyFileCount: 0 } },
    variant: "panel",
  });
  assert.equal(findAll(tree, hasAttr("data-collapse-to-mini")).length, 1);
  assert.equal(findAll(tree, hasAttr("data-display-mode-menu")).length, 1);
});

test("mini summary expand action calls onVariantChange('panel')", () => {
  let called = null;
  const tree = render({
    model: { plan: { items: [makeItem("1", "doing", "in_progress")], completedCount: 0, totalCount: 1 } },
    variant: "mini",
    onVariantChange: (v) => {
      called = v;
    },
  });
  const trigger = findAll(tree, hasAttr("data-mini-summary"))[0];
  assert.ok(trigger);
  assert.equal(trigger.props["data-mini-summary"], "currentPlan");
  trigger.props.onClick();
  assert.equal(called, "panel");
});

test("terminal open callback receives the row as the target", () => {
  let target = null;
  const tree = render({
    model: { terminals: [{ id: "t9", title: "bash", state: "running" }] },
    variant: "panel",
    terminalSectionOpen: true,
    onOpenTerminal: (t) => {
      target = t;
    },
  });
  const openBtn = findAll(tree, byAttr("data-row-open", "terminal"))[0];
  assert.ok(openBtn);
  openBtn.props.onClick({ stopPropagation: () => {} });
  assert.equal(target.id, "t9");
});

test("plan item icons and completed strikethrough match the source", () => {
  const items = [
    makeItem("1", "done task", "completed"),
    makeItem("2", "active task", "in_progress"),
    makeItem("3", "pending task", "pending"),
  ];
  const tree = render({
    model: { plan: { items, completedCount: 1, totalCount: 3 } },
    variant: "panel",
  });
  const planItems = findAll(tree, hasAttr("data-plan-status"));
  const byStatus = {};
  for (const li of planItems) byStatus[li.props["data-plan-status"]] = li;
  assert.ok(byStatus.completed);
  assert.ok(byStatus.in_progress);
  assert.ok(byStatus.pending);
  // completed item carries the strikethrough content class
  const completedContent = findAll(byStatus.completed, (n) => n.props && (n.props.className || "").includes("harness-status-panel__plan-content--done"))[0];
  assert.ok(completedContent, "completed item content should have the --done (strikethrough) class");
});

test("unobserved background work remains visible without claiming it is running", () => {
  const model = { terminals: [{ id: "unknown", title: "owned command", state: "unknown" }] };
  assert.equal(resolveStatusPanelMiniSummary(model, DEFAULT_LABELS).key, "unconfirmed");
  const tree = render({ model, variant: "panel", terminalSectionOpen: true });
  const panel = findAll(tree, hasAttr("data-running-terminal-count"))[0];
  assert.equal(panel.props["data-running-terminal-count"], "0");
  assert.ok(textOf(tree).includes("owned command"));
  assert.ok(textOf(tree).includes("状态待确认"));
});
