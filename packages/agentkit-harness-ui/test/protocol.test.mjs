import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION, EventType, TaskState, TaskOutcome, ToolStatus,
  TASK_TRANSITIONS, normalizeEvent, canTransition, isTaskState, isEventType,
} from "../src/protocol.mjs";

test("protocol version is pinned and stable", () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test("normalizeEvent accepts a well-formed envelope and fills optional fields", () => {
  const e = normalizeEvent({ v: 1, type: EventType.TextDelta, id: "e1", itemId: "t1", delta: "hi" });
  assert.equal(e.v, 1);
  assert.equal(e.type, "text.delta");
  assert.equal(e.id, "e1");
  assert.equal(e.ts, null);
  assert.equal(e.seq, null);
  assert.equal(e.itemId, "t1");
  assert.equal(e.delta, "hi");
});

test("normalizeEvent rejects an unknown protocol version", () => {
  assert.throws(() => normalizeEvent({ v: 2, type: "text.delta", id: "e1" }), RangeError);
  assert.throws(() => normalizeEvent({ v: 1, type: "bogus", id: "e1" }), RangeError);
  assert.throws(() => normalizeEvent({ v: 1, type: "text.delta" }), RangeError);
});

test("normalizeEvent coerces a string tool input into an object safely", () => {
  const e = normalizeEvent({ v: 1, type: EventType.ToolScheduled, id: "e", callId: "c1", name: "Bash", input: "not json" });
  assert.deepEqual(e.input, { value: "not json" });
  const parsed = normalizeEvent({ v: 1, type: EventType.ToolScheduled, id: "e2", callId: "c2", name: "Bash", input: '{"command":"ls"}' });
  assert.deepEqual(parsed.input, { command: "ls" });
});

test("normalizeEvent redaction-free: plan items keep a stable status fallback", () => {
  const e = normalizeEvent({ v: 1, type: EventType.PlanUpdated, id: "p", items: [
    { id: "a", content: "do thing", status: "in_progress" },
    { id: "b", content: "later", status: "weird" },
    "garbage",
  ] });
  assert.equal(e.items.length, 2);
  assert.equal(e.items[0].status, "in_progress");
  assert.equal(e.items[1].status, "pending");
});

test("canTransition allows the interruption/failure/recovery graph and cancels from anywhere", () => {
  assert.equal(canTransition(TaskState.Running, TaskState.Interrupted), true);
  assert.equal(canTransition(TaskState.Interrupted, TaskState.Recovered), true);
  assert.equal(canTransition(TaskState.Recovered, TaskState.Running), true);
  assert.equal(canTransition(TaskState.Failed, TaskState.Running), true);
  assert.equal(canTransition(TaskState.Failed, TaskState.Recovered), true);
  assert.equal(canTransition(TaskState.Running, TaskState.Completed), true);
  // cancelled is reachable from any state
  assert.equal(canTransition(TaskState.Recovered, TaskState.Cancelled), true);
  assert.equal(canTransition(TaskState.Completed, TaskState.Cancelled), false);
  // terminal states do not accept further transitions (except cancel)
  assert.equal(canTransition(TaskState.Completed, TaskState.Running), false);
  assert.equal(canTransition(TaskState.Cancelled, TaskState.Running), false);
  assert.equal(canTransition(TaskState.Running, TaskState.Idle), false);
  assert.equal(TASK_TRANSITIONS[TaskState.Idle].length, 1);
});

test("guards recognize valid enums", () => {
  assert.equal(isTaskState("running"), true);
  assert.equal(isTaskState("sprinting"), false);
  assert.equal(isEventType("tool.result"), true);
  assert.equal(isEventType("tool.bogus"), false);
  assert.equal(ToolStatus.Completed, "completed");
  assert.equal(TaskOutcome.Failed, "failed");
});


test("missing task outcomes never default to successful completion", () => {
  assert.throws(() => normalizeEvent({ v: 1, type: "task.finished", id: "bad" }), /task outcome/);
  assert.throws(() => normalizeEvent({ v: 1, type: "task.state", id: "bad", state: "unknown" }), /task state/);
});
