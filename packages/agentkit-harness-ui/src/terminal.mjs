// @kingsoftcloud/agentkit-harness-ui — terminal command/output helpers
//
// Pure extraction and sanitization for the terminal (execute) renderer. The
// command is derived from the host-supplied tool input across the common
// shapes (string, argv array, object with command/cmd/script/parsed_cmd);
// the output is derived from the `tool.result` display payload or the result
// body. ANSI escape sequences are stripped to plain text for the inline
// bounded preview — the preview NEVER uses innerHTML, so control sequences
// cannot inject markup. A host that wants a live PTY renders it through the
// `onOpenTerminal` callback, which is the only path to a real terminal.
//
// No invented success: a command with input but no result/exit renders as
// running, never as completed. Exit code and cwd are shown only when the host
// supplied them in the display payload.

const SHELL_PREFIX_RE = /^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/i;

/**
 * Extract the shell command string from a tool input across common shapes.
 * Strips a leading `zsh/bash/sh -lc ` invocation wrapper. Returns "" when no
 * command can be recovered.
 * @param {unknown} input
 * @returns {string}
 */
export function extractCommand(input) {
  const fromString = (s) => {
    const trimmed = String(s == null ? "" : s).trim();
    if (!trimmed) return "";
    return trimmed.replace(SHELL_PREFIX_RE, "").trim();
  };
  if (typeof input === "string") return fromString(input);
  if (Array.isArray(input) && input.every(i => typeof i === "string")) {
    const parts = input.map(i => i.trim()).filter(Boolean);
    if (!parts.length) return "";
    const lc = parts.findIndex(p => p === "-lc");
    if (lc >= 0 && parts[lc + 1]) return parts[lc + 1];
    // argv with a leading shell binary: drop the binary, join the rest.
    if (/^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)$/i.test(parts[0])) return parts.slice(1).join(" ");
    return parts.join(" ");
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = /** @type {Record<string, unknown>} */ (input);
    for (const key of ["command", "cmd", "script"]) {
      if (typeof rec[key] === "string") return fromString(rec[key]);
    }
    const parsed = rec.parsed_cmd;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "string") {
          const c = fromString(item);
          if (c) return c;
          continue;
        }
        if (item && typeof item === "object") {
          const r = /** @type {Record<string, unknown>} */ (item);
          for (const key of ["cmd", "command", "script"]) {
            if (typeof r[key] === "string") {
              const c = fromString(r[key]);
              if (c) return c;
            }
          }
        }
      }
    }
  }
  return "";
}

/**
 * Extract output text from a tool result body or display payload. The display
 * payload (host-supplied `command_output`) is authoritative; the result body
 * is a fallback for hosts that only emit a raw result.
 * @param {unknown} result
 * @param {Record<string, unknown>} [display]
 * @returns {{stdout: string, stderr: string, exit: number|null, cwd: string}}
 */
export function extractOutput(result, display) {
  const disp = isPlainRecord(display) ? display : {};
  const stdout = pickString(disp, ["stdout", "output", "fullText", "text", "content", "result"])
    ?? extractResultText(result);
  const stderr = pickString(disp, ["stderr", "error", "errorMessage"]) ?? "";
  const exit = parseExit(disp.exit ?? disp.exitCode ?? disp.code ?? disp.returncode);
  const cwd = normalizeCwd(typeof disp.cwd === "string" ? disp.cwd : "");
  return { stdout: sanitizeAnsi(String(stdout || "")), stderr: sanitizeAnsi(String(stderr || "")), exit, cwd };
}

/**
 * Strip ANSI CSI/SGR and other control sequences to plain text. The inline
 * preview renders this as text content (never innerHTML), so escape sequences
 * cannot inject markup. Keeps newlines and tabs; drops bells and other C0
 * controls that would only noisify a bounded preview.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeAnsi(text) {
  const value = String(text == null ? "" : text);
  if (!value) return "";
  return value
    // CSI sequences: ESC [ ... letter  (SGR colors, cursor moves, erases, etc.)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC sequences: ESC ] ... BEL or ST (title set, hyperlinks, etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other two-char ESC sequences (M-, etc.)
    .replace(/\x1b[=>78]/g, "")
    // Stray ESC and BEL, vertical tab / form feed, other C0 controls except
    // tab (\t, 0x09), LF (\n, 0x0a), CR (\r, 0x0d).
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Normalize a cwd string: trim and drop a single trailing slash. */
export function normalizeCwd(cwd) {
  const value = String(cwd == null ? "" : cwd).trim();
  if (!value) return "";
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseExit(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(rec, keys) {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function extractResultText(output) {
  if (output == null) return "";
  if (typeof output === "string") return output.trim() ? output : "";
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") return String(output);
  if (Array.isArray(output)) {
    return output.map(extractResultText).filter(t => t).join("\n");
  }
  if (isPlainRecord(output)) {
    const direct = pickString(output, ["output", "text", "content", "result", "stdout", "message"]);
    if (direct) return direct;
    if (isPlainRecord(output.rawOutput)) {
      const nested = extractResultText(output.rawOutput);
      if (nested) return nested;
    }
    if (Array.isArray(output.content)) {
      const joined = output.content
        .map(item => typeof item === "string" ? item.trim() : isPlainRecord(item) ? pickString(item, ["output", "text", "content", "result", "stdout", "message"]) ?? "" : "")
        .filter(Boolean).join("\n");
      if (joined) return joined;
    }
  }
  return "";
}
