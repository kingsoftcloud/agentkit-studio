import test from "node:test";
import assert from "node:assert/strict";
import { extractCommand, extractOutput, sanitizeAnsi, normalizeCwd } from "../src/terminal.mjs";

test("extractCommand unwraps zsh/bash -lc and joins argv, drops the shell binary", () => {
  assert.equal(extractCommand("npm test"), "npm test");
  // The reference does not strip quotes from -lc args; the raw command is kept.
  assert.equal(extractCommand("/bin/zsh -lc 'npm test'"), "'npm test'");
  assert.equal(extractCommand("bash -lc npm test"), "npm test");
  assert.equal(extractCommand(["/bin/bash", "-lc", "echo hi"]), "echo hi");
  // The reference only special-cases -lc; -c is not stripped, matching the
  // desktop secondary-text behavior.
  assert.equal(extractCommand(["zsh", "-c", "echo", "hi"]), "-c echo hi");
  assert.equal(extractCommand({ command: "npm test" }), "npm test");
  assert.equal(extractCommand({ cmd: "echo hi" }), "echo hi");
  assert.equal(extractCommand({ script: "node ." }), "node .");
  assert.equal(extractCommand({ parsed_cmd: [{ cmd: "make build" }] }), "make build");
  assert.equal(extractCommand({ parsed_cmd: ["make build"] }), "make build");
  assert.equal(extractCommand(""), "");
  assert.equal(extractCommand(null), "");
  assert.equal(extractCommand({}), "");
});

test("extractOutput prefers the display payload and falls back to the result body", () => {
  const out = extractOutput({ stdout: "ignored" }, { kind: "command_output", stdout: "real stdout", stderr: "err", exit: 0, cwd: "/repo/" });
  assert.equal(out.stdout, "real stdout");
  assert.equal(out.stderr, "err");
  assert.equal(out.exit, 0);
  assert.equal(out.cwd, "/repo");
  // Fallback to result body when display has no stdout
  const fb = extractOutput("fallback output", {});
  assert.equal(fb.stdout, "fallback output");
  assert.equal(fb.exit, null);
  assert.equal(fb.cwd, "");
  // Nested result shapes
  const nested = extractOutput({ content: [{ text: "a" }, { text: "b" }] }, {});
  assert.equal(nested.stdout, "a\nb");
});

test("extractOutput parses exit code across exit/exitCode/code/returncode", () => {
  for (const key of ["exit", "exitCode", "code", "returncode"]) {
    const out = extractOutput(null, { kind: "command_output", [key]: 2 });
    assert.equal(out.exit, 2, `${key} → 2`);
  }
  assert.equal(extractOutput(null, { exit: "abc" }).exit, null);
  assert.equal(extractOutput(null, { exit: "" }).exit, null);
});

test("sanitizeAnsi strips CSI/SGR/OSC sequences and control chars but keeps tabs and newlines", () => {
  const dirty = "\x1b[31mred\x1b[0m text\x1b[2K\x1b[?25h";
  assert.equal(sanitizeAnsi(dirty), "red text");
  assert.equal(sanitizeAnsi("\x1b]0;title\x07body"), "body");
  assert.equal(sanitizeAnsi("line1\nline2\ttabbed"), "line1\nline2\ttabbed");
  assert.equal(sanitizeAnsi("a\x07b\x00c"), "abc", "bell and NUL dropped");
  assert.equal(sanitizeAnsi(""), "");
  // Escape sequences must not survive into the preview (no innerHTML injection vector)
  assert.ok(!sanitizeAnsi("\x1b[1m<script>\x1b[0m").includes("\x1b"));
});

test("normalizeCwd trims and drops a single trailing slash but keeps root", () => {
  assert.equal(normalizeCwd("/repo/"), "/repo");
  assert.equal(normalizeCwd("/repo"), "/repo");
  assert.equal(normalizeCwd("/"), "/");
  assert.equal(normalizeCwd(""), "");
  assert.equal(normalizeCwd("  /a/b/  "), "/a/b");
});

test("extractOutput never invents success: input with no result/exit renders as empty/running", () => {
  const out = extractOutput(null, { kind: "command_output" });
  assert.equal(out.stdout, "");
  assert.equal(out.exit, null);
});
