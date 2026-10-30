// @kingsoftcloud/agentkit-harness-ui — bounded text helpers
//
// Pure, deterministic text utilities. No timers, no DOM. The animation timing
// from the reference LiveThinking/LatestSummaryLine stays in the React layer;
// this module owns the line-selection and truncation policy that the layer
// consumes, so the meaningful behavior is testable without a clock.

/** Keys whose values are redacted from any bounded preview. */
export const SENSITIVE_KEYS = Object.freeze(new Set([
  "token", "tokens", "secret", "password", "passwd", "api_key", "apikey",
  "authorization", "auth", "cookie", "session", "private_key", "key",
]));

/**
 * Latest non-empty, trimmed line of a streaming text. Used as the collapsed
 * preview of a thought while it streams, so the user sees progress without the
 * full reasoning being forced into view. Returns "" for blank text.
 * @param {string} text
 * @returns {string}
 */
export function latestNonEmptyLine(text) {
  const value = text == null ? "" : String(text);
  const lines = value.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/**
 * Bounded truncation. Keeps at most `maxLines` lines and at most `maxChars`
 * characters per line, appending a single `…` truncation marker when anything
 * is dropped. Never dumps large content verbatim.
 * @param {string} text
 * @param {{maxLines?: number, maxChars?: number}} [opts]
 * @returns {string}
 */
export function truncateText(text, opts = {}) {
  const maxLines = opts.maxLines && opts.maxLines > 0 ? Math.floor(opts.maxLines) : 0;
  const maxChars = opts.maxChars && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 0;
  const value = text == null ? "" : String(text);
  if (!value) return "";
  const lines = value.split("\n");
  let truncated = false;
  const kept = [];
  for (const line of lines) {
    if (maxLines && kept.length >= maxLines) { truncated = true; break; }
    if (maxChars && line.length > maxChars) {
      kept.push(line.slice(0, Math.max(0, maxChars - 1)) + "…");
      truncated = true;
    } else {
      kept.push(line);
    }
  }
  if (truncated && !kept.some(l => l.endsWith("…"))) kept.push("…");
  return kept.join("\n");
}

/**
 * Redact a value when its key looks sensitive. Returns the original value for
 * safe keys. For `env`/environment maps, keeps the names being set/unset but
 * drops the values, matching the tool-detail-block safety contract.
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactValue(key, value) {
  const lower = String(key == null ? "" : key).toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return "[redacted]";
  if (lower === "env" && value && typeof value === "object" && !Array.isArray(value)) {
    const names = Object.keys(/** @type {Record<string, unknown>} */ (value));
    return Object.fromEntries(names.map(name => [name, "[redacted]"]));
  }
  return value;
}

/**
 * Produce a bounded object preview for unknown/MCP tools or fallback display.
 * Redacts sensitive keys, truncates long string values, and keeps at most
 * `maxLines` rows so a single detail block stays small.
 * @param {Record<string, unknown>} input
 * @param {{maxLines?: number, maxChars?: number}} [opts]
 * @returns {{key: string, value: string}[]}
 */
export function boundedDetailLines(input, opts = {}) {
  const maxLines = opts.maxLines && opts.maxLines > 0 ? Math.floor(opts.maxLines) : 4;
  const maxChars = opts.maxChars && opts.maxChars > 0 ? Math.floor(opts.maxChars) : 80;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const rows = [];
  for (const [key, raw] of Object.entries(input)) {
    if (rows.length >= maxLines) { rows.push({ key: "…", value: "" }); break; }
    const value = redactValue(key, raw);
    rows.push({ key, value: previewValue(value, maxChars) });
  }
  return rows;
}

function previewValue(value, maxChars) {
  if (value == null) return String(value);
  if (typeof value === "string") return truncateText(value, { maxLines: 1, maxChars });
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncateText(JSON.stringify(value), { maxLines: 1, maxChars });
  } catch {
    return truncateText(String(value), { maxLines: 1, maxChars });
  }
}

/**
 * Deterministic summary-line queue. Mirrors the reference LatestSummaryLine
 * policy: refresh the current line in place when the newest non-empty line is
 * the same line (grew in place), otherwise queue at most two new lines and
 * promote the oldest queued line to active. This is a pure state machine over
 * the observed text history; the component owns the animation timers.
 */
export class SummaryQueue {
  constructor() {
    this.active = { key: 0, text: "" };
    this.pending = [];
  }

  /**
   * @param {string} text the full streamed text so far
   * @returns {{active: {key:number, text:string}, outgoing: {key:number, text:string}|null}}
   */
  push(text) {
    const next = latestNonEmptyLine(text);
    if (next.key === "" && text === "") return { active: this.active, outgoing: null };
    const key = lineKey(text, next);
    if (key === this.active.key) {
      this.active = { key, text: next };
      return { active: this.active, outgoing: null };
    }
    const existing = this.pending.findIndex(line => line.key === key);
    if (existing >= 0) this.pending[existing] = { key, text: next };
    else this.pending = this.pending.length >= 2 ? [this.pending[1], { key, text: next }] : [...this.pending, { key, text: next }];
    const outgoing = this.active;
    const promoted = this.pending.shift();
    if (promoted) this.active = promoted;
    return { active: this.active, outgoing };
  }

  /** Replace state without producing a transition (reduced-motion / completion). */
  setLatest(text) {
    const next = latestNonEmptyLine(text);
    this.active = { key: lineKey(text, next), text: next };
    this.pending = [];
    return { active: this.active, outgoing: null };
  }
}

function lineKey(fullText, line) {
  // Stable key: the index of the latest non-empty line within the full text.
  const lines = String(fullText).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === line) return i;
  }
  return 0;
}
