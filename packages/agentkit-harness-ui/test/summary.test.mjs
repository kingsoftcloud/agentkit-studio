import test from "node:test";
import assert from "node:assert/strict";
import {
  latestNonEmptyLine, truncateText, redactValue, boundedDetailLines, SummaryQueue, SENSITIVE_KEYS,
} from "../src/summary.mjs";

test("latestNonEmptyLine returns the last trimmed non-empty line", () => {
  assert.equal(latestNonEmptyLine("first\nsecond\n\n  "), "second");
  assert.equal(latestNonEmptyLine(""), "");
  assert.equal(latestNonEmptyLine("\n\n  \n"), "");
  assert.equal(latestNonEmptyLine("only"), "only");
});

test("truncateText bounds lines and chars and appends a marker", () => {
  assert.equal(truncateText("line one\nline two\nline three", { maxLines: 2 }), "line one\nline two\n…");
  const long = "x".repeat(100);
  const t = truncateText(long, { maxChars: 10 });
  assert.ok(t.length <= 10);
  assert.ok(t.endsWith("…"));
  assert.equal(truncateText("", { maxLines: 3, maxChars: 10 }), "");
});

test("redactValue redacts sensitive keys and env names but not safe values", () => {
  assert.equal(redactValue("token", "abc"), "[redacted]");
  assert.equal(redactValue("API_KEY", "abc"), "[redacted]");
  assert.equal(redactValue("command", "npm test"), "npm test");
  const env = redactValue("env", { NODE_ENV: "production", SECRET: "x" });
  assert.deepEqual(env, { NODE_ENV: "[redacted]", SECRET: "[redacted]" });
  assert.ok(SENSITIVE_KEYS.has("password"));
});

test("boundedDetailLines redacts sensitive values and caps at four rows", () => {
  const rows = boundedDetailLines({
    command: "npm test", cwd: "/repo", token: "shh", api_key: "k",
  });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(rows.length, 4);
  assert.equal(map.token, "[redacted]");
  assert.equal(map.api_key, "[redacted]");
  assert.equal(map.command, "npm test");
  assert.equal(map.cwd, "/repo");
  // a cap beyond four rows appends a single truncation marker and stops
  const capped = boundedDetailLines({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  assert.ok(capped.length <= 5);
  assert.equal(capped.at(-1).key, "…");
});

test("SummaryQueue refreshes the same line in place and queues new lines", () => {
  const q = new SummaryQueue();
  let r = q.push("first");
  assert.equal(r.active.text, "first");
  assert.equal(r.outgoing, null);
  // same line grows in place
  r = q.push("first grows");
  assert.equal(r.active.text, "first grows");
  assert.equal(r.outgoing, null);
  // a new line queues and promotes the previous to outgoing
  r = q.push("first grows\nsecond");
  assert.equal(r.active.text, "second");
  assert.equal(r.outgoing.text, "first grows");
  // a third new line queues at most two
  r = q.push("first grows\nsecond\nthird");
  assert.equal(r.active.text, "third");
  // setLatest collapses to the newest line without a transition (reduced motion)
  r = q.setLatest("first grows\nsecond\nthird\nfinal");
  assert.equal(r.active.text, "final");
  assert.equal(r.outgoing, null);
});
