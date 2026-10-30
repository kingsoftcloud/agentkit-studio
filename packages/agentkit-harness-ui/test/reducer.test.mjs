import test from "node:test";
import assert from "node:assert/strict";
import { EventType, TaskState, ToolStatus } from "../src/protocol.mjs";
import { initialState, reduce, reduceAll } from "../src/reducer.mjs";
import { isTerminal } from '../src/project.mjs';
import { normalizeEvent } from '../src/protocol.mjs';

function ev(type, id, extra = {}) {
  return { v: 1, type, id, ...extra };
}

test('closed interruption preserves an unverified outcome and can resume only through a host state event', () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, 'start', { taskId: 'task' }));
  s = reduce(s, ev(EventType.TaskState, 'interruption', { state: 'interrupted' }));
  assert.equal(isTerminal(s), false);
  s = reduce(s, ev(EventType.TaskFinished, 'closed', { outcome: 'unverified', executionState: 'interrupted', summary: 'Original result unknown' }));
  assert.equal(s.taskState, 'interrupted'); assert.equal(s.taskOutcome, 'unverified'); assert.equal(isTerminal(s), true);
  s = reduce(s, ev(EventType.TaskState, 'recovered', { state: 'recovered' }));
  assert.equal(s.taskOutcome, null); assert.equal(isTerminal(s), false);
  for (const outcome of ['completed', 'failed', 'cancelled', 'blocked']) assert.throws(() => normalizeEvent(
    ev(EventType.TaskFinished, outcome, { outcome, executionState: 'interrupted' })), /unverified/);
});

test("task.started enters running and stores id/title/run", () => {
  const s = reduce(initialState(), ev(EventType.TaskStarted, "t1", { taskId: "task-1", title: "Build it", runId: "run-1" }));
  assert.equal(s.taskId, "task-1");
  assert.equal(s.taskTitle, "Build it");
  assert.equal(s.runId, "run-1");
  assert.equal(s.taskState, TaskState.Running);
});

test("task.state interruption then recovery then running is honored; invalid transitions ignored", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TaskState, "t1", { state: TaskState.Interrupted, reason: "approval" }));
  assert.equal(s.taskState, TaskState.Interrupted);
  assert.equal(s.taskReason, "approval");
  s = reduce(s, ev(EventType.TaskState, "t2", { state: TaskState.Recovered }));
  assert.equal(s.taskState, TaskState.Recovered);
  s = reduce(s, ev(EventType.TaskState, "t3", { state: TaskState.Running }));
  assert.equal(s.taskState, TaskState.Running);
  // invalid: completed -> running is not allowed
  s = reduce(s, ev(EventType.TaskFinished, "t4", { outcome: "completed" }));
  assert.equal(s.taskState, TaskState.Completed);
  const before = s.taskState;
  s = reduce(s, ev(EventType.TaskState, "t5", { state: TaskState.Running }));
  assert.equal(s.taskState, before, "terminal state must not transition back to running");
});

test("task.finished completed stores a host summary but never invents one", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TaskFinished, "t1", { outcome: "completed", summary: "All tests pass" }));
  assert.equal(s.taskState, TaskState.Completed);
  assert.equal(s.taskSummary, "All tests pass");
  assert.equal(s.taskOutcome, "completed");
  // without a host summary, the reducer must not synthesize success text
  s = reduce(initialState(), ev(EventType.TaskStarted, "t2", { taskId: "T2" }));
  s = reduce(s, ev(EventType.TaskFinished, "t3", { outcome: "completed" }));
  assert.equal(s.taskSummary, null);
  assert.equal(s.taskState, TaskState.Completed);
});

test("text.delta appends to an existing item and creates a new ordered item for a new id", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt-1", delta: "Hello" }));
  s = reduce(s, ev(EventType.TextDelta, "a2", { itemId: "txt-1", delta: " world" }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].text, "Hello world");
  assert.equal(s.items[0].streaming, true);
  s = reduce(s, ev(EventType.TextDone, "a3", { itemId: "txt-1" }));
  assert.equal(s.items[0].streaming, false);
});

test("thinking.start alone never creates a visible item; first non-empty delta does", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ThinkingStart, "k1", { itemId: "th-1" }));
  assert.equal(s.items.length, 0, "reasoning_start alone must not create transcript noise");
  assert.ok(s.pendingThinking.has("th-1"));
  // empty delta does not create the placeholder either
  s = reduce(s, ev(EventType.ThinkingDelta, "k2", { itemId: "th-1", delta: "" }));
  assert.equal(s.items.length, 0);
  // first non-empty delta creates it
  s = reduce(s, ev(EventType.ThinkingDelta, "k3", { itemId: "th-1", delta: "Planning" }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "thought");
  assert.equal(s.items[0].text, "Planning");
  assert.equal(s.items[0].streaming, true);
  // done stops streaming; no char/token count is ever stored
  s = reduce(s, ev(EventType.ThinkingDone, "k4", { itemId: "th-1" }));
  assert.equal(s.items[0].streaming, false);
  assert.equal(s.items[0].tokens, undefined);
  assert.equal(s.items[0].charCount, undefined);
});

test("thinking.delta without a prior start still creates the placeholder (provider fallback)", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ThinkingDelta, "k1", { itemId: "th-orphan", delta: "Reasoning without start" }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "thought");
  assert.equal(s.items[0].text, "Reasoning without start");
});

test("tool lifecycle updates one part in place for the same callId across all events", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "call-1", name: "Bash", input: { command: "npm test" } }));
  s = reduce(s, ev(EventType.ToolStarted, "x2", { callId: "call-1" }));
  s = reduce(s, ev(EventType.ToolProgress, "x3", { callId: "call-1", message: "running 12 tests" }));
  s = reduce(s, ev(EventType.ToolResult, "x4", { callId: "call-1", result: { ok: true }, display: { kind: "file_diff", path: "a.ts", patch: "+new\n-old\n ctx" } }));
  assert.equal(s.items.length, 1, "one part per callId, not separate lifecycle rows");
  const tool = s.items[0];
  assert.equal(tool.callId, "call-1");
  assert.equal(tool.status, ToolStatus.Completed);
  assert.equal(tool.input.command, "npm test");
  assert.equal(tool.display.kind, "file_diff");
  assert.equal(tool.progress, "running 12 tests");
});

test("tool.error marks the existing part failed with the host error", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Bash", input: { command: "bad" } }));
  s = reduce(s, ev(EventType.ToolError, "x2", { callId: "c", error: "exit code 1" }));
  assert.equal(s.items[0].status, ToolStatus.Failed);
  assert.equal(s.items[0].error, "exit code 1");
});

test("out-of-order tool.result without a scheduled event appends a fallback part", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ToolResult, "x1", { callId: "late", result: { ok: 1 } }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, "tool");
  assert.equal(s.items[0].callId, "late");
  assert.equal(s.items[0].status, ToolStatus.Completed);
  assert.deepEqual(s.items[0].input, {});
  // a later scheduled event updates the same fallback part in place
  s = reduce(s, ev(EventType.ToolScheduled, "x2", { callId: "late", name: "Read", input: { path: "a.ts" } }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].name, "Read");
  assert.equal(s.items[0].input.path, "a.ts");
  assert.equal(s.items[0].status, ToolStatus.Completed);
});

test("items preserve the provider stream order across interleaved text/thought/tool", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.ThinkingDelta, "k1", { itemId: "th", delta: "think" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "answer" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Bash", input: { command: "ls" } }));
  s = reduce(s, ev(EventType.TextDelta, "a2", { itemId: "txt2", delta: "more" }));
  assert.deepEqual(s.items.map(i => i.kind), ["thought", "text", "tool", "text"]);
  assert.deepEqual(s.items.map(i => i.kind === "tool" ? i.callId : i.id), ["th", "txt", "c", "txt2"]);
});

test("deduplication: replaying the same event id is a no-op (idempotent replay)", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "one" }));
  const before = s;
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "one" }));
  assert.equal(s, before, "duplicate event id must return the same state object");
  assert.equal(s.items[0].text, "one");
});

test("reduceAll replays a batch idempotently and ignores a malformed event without corrupting state", () => {
  const batch = [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "hi" }),
    { v: 1, type: "nonsense", id: "bad" }, // throws in normalizeEvent
    ev(EventType.TextDone, "a2", { itemId: "txt" }),
  ];
  const s = reduceAll(initialState(), batch);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].text, "hi");
  assert.equal(s.items[0].streaming, false);
});

test("task.finished finalizes still-streaming items without inventing completion", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "partial" }));
  s = reduce(s, ev(EventType.ThinkingDelta, "k1", { itemId: "th", delta: "thinking" }));
  s = reduce(s, ev(EventType.ToolStarted, "x1", { callId: "c" }));
  s = reduce(s, ev(EventType.TaskFinished, "t1", { outcome: "failed", error: "boom" }));
  assert.equal(s.items.every(i => i.streaming === false), true);
  // No receipt arrived before termination, so it is interrupted rather than completed.
  const tool = s.items.find(i => i.kind === "tool");
  assert.equal(tool.status, ToolStatus.Interrupted);
  assert.equal(tool.streaming, false);
  assert.equal(s.taskError, "boom");
});

test("plan.updated replaces the plan and an empty plan clears it", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.PlanUpdated, "p1", { items: [{ id: "a", content: "step", status: "in_progress" }] }));
  assert.equal(s.plan.length, 1);
  s = reduce(s, ev(EventType.PlanUpdated, "p2", { items: [] }));
  assert.equal(s.plan, null);
});

test("reducer is immutable: later events do not mutate prior state snapshots", () => {
  let s = reduce(initialState(), ev(EventType.TaskStarted, "t0", { taskId: "T" }));
  s = reduce(s, ev(EventType.TextDelta, "a1", { itemId: "txt", delta: "one" }));
  s = reduce(s, ev(EventType.ToolScheduled, "x1", { callId: "c", name: "Bash", input: { command: "ls" } }));
  const snap = s;
  const snapText = snap.items[0].text;
  const snapToolInput = snap.items[1].input;
  // append more text and progress the tool; the snapshot must be unchanged
  s = reduce(s, ev(EventType.TextDelta, "a2", { itemId: "txt", delta: " two" }));
  s = reduce(s, ev(EventType.ToolProgress, "x2", { callId: "c", message: "running" }));
  s = reduce(s, ev(EventType.ToolResult, "x3", { callId: "c" }));
  assert.equal(snap.items[0].text, snapText, "prior snapshot text must not mutate");
  assert.equal(snap.items[0].text, "one");
  assert.equal(s.items[0].text, "one two");
  assert.equal(snap.items[1].input, snapToolInput, "prior snapshot tool input must not mutate");
  assert.equal(snap.items[1].status, "scheduled");
  assert.equal(s.items[1].status, "completed");
});


test("durable final text replaces streamed text and unverified outcome remains explicit", () => {
  let s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "s", { taskId: "r" }),
    ev(EventType.TextDelta, "a", { itemId: "m", delta: "partial" }),
    ev(EventType.TextDone, "b", { itemId: "m", text: "final" }),
    ev(EventType.TaskFinished, "f", { outcome: "unverified" }),
  ]);
  assert.equal(s.items[0].text, "final");
  assert.equal(s.taskState, "unverified");
  assert.equal(s.taskOutcome, "unverified");
});
