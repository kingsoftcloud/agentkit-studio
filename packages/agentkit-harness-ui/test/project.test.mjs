import test from "node:test";
import assert from "node:assert/strict";
import { EventType, TaskState, ToolStatus } from "../src/protocol.mjs";
import { initialState, reduce, reduceAll } from "../src/reducer.mjs";
import {
  visibleItems, isStreaming, isWaitingForFirstToken, isTerminal,
  planProgress, activeTool, failedTools, taskStatusLabel,
} from "../src/project.mjs";

function ev(type, id, extra = {}) { return { v: 1, type, id, ...extra }; }

test("isWaitingForFirstToken is true while running with no items; a thought delta clears it", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  assert.equal(isWaitingForFirstToken(s), true);
  // a start alone creates no item, so the placeholder stays (status, not transcript)
  s = reduce(s, ev(EventType.ThinkingStart, "k1", { itemId: "th" }));
  assert.equal(isWaitingForFirstToken(s), true);
  // the first non-empty delta creates a thought item and clears the placeholder
  s = reduce(s, ev(EventType.ThinkingDelta, "k2", { itemId: "th", delta: "x" }));
  assert.equal(isWaitingForFirstToken(s), false);
});

test("isStreaming tracks live text/thought items", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "t", delta: "hi" }));
  assert.equal(isStreaming(s), true);
  s = reduce(s, ev(EventType.TextDone, "a2", { itemId: "t" }));
  assert.equal(isStreaming(s), false);
});

test("planProgress reports completed/total and the in-progress item", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  assert.equal(planProgress(s), null);
  s = reduce(s, ev(EventType.PlanUpdated, "p1", { items: [
    { id: "a", content: "one", status: "completed" },
    { id: "b", content: "two", status: "in_progress" },
    { id: "c", content: "three", status: "pending" },
  ] }));
  const p = planProgress(s);
  assert.equal(p.total, 3);
  assert.equal(p.completed, 1);
  assert.equal(p.inProgress.content, "two");
  assert.equal(p.ratio, 1 / 3);
});

test("activeTool and failedTools select from the ordered items", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { path: "a" } }));
  s = reduce(s, ev(EventType.ToolResult, "x2", { callId: "c1" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x3", { callId: "c2", name: "Bash", input: { command: "x" } }));
  s = reduce(s, ev(EventType.ToolError, "x4", { callId: "c2", error: "boom" }));
  assert.equal(activeTool(s), null, "no running tool after error");
  assert.equal(failedTools(s).length, 1);
  assert.equal(failedTools(s)[0].callId, "c2");
});

test("taskStatusLabel reflects host-declared state and never invents success", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  assert.equal(taskStatusLabel(s), "Running");
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Bash", input: { command: "x" } }));
  assert.equal(taskStatusLabel(s), "Bash");
  s = reduce(s, ev(EventType.TaskState, "t1", { state: TaskState.Interrupted }));
  assert.equal(taskStatusLabel(s), "Interrupted");
  s = reduce(s, ev(EventType.TaskFinished, "t2", { outcome: "completed" }));
  assert.equal(taskStatusLabel(s), "Completed");
  assert.equal(isTerminal(s), true);
});
