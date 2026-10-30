/** Serializable browser evidence. A successful action is never an acceptance verdict.
 *
 * Ported from ksadk/harness/native/browser_contract.py (commit 355059d). Pure runtime
 * validators and normalizers; no Host services, browser driver, filesystem or crypto. A
 * caller-provided digest callback supplies cryptographic hashing (see browserObservationDigest).
 *
 * Documented format differences from the Python source (no attempt to match historical
 * serialized bytes, per the migration contract):
 *  - schemaVersion uses the agentkit.* namespace (agentkit.browser-session/v1,
 *    agentkit.browser-observation/v1) instead of ksadk.browser-*, matching the TS core.
 *  - Field names are camelCase (Python: snake_case), matching the TS core.
 *  - RunScope validation reuses the core's scopeKey, which requires four non-blank trimmed
 *    string components and rejects extra keys; Python RunScope used Field(min_length=1) and
 *    accepted whitespace-only components.
 *  - Integer fields use Number.isSafeInteger (consistent with the core). Python left a few
 *    integer fields non-strict (timeout_ms, status_code, width, height, generation,
 *    lease_epoch, action_seq, last_action_seq, viewport) and would coerce whole floats/strings.
 *    JS has one number type, so a value such as 1.0 that JSON parses to an integer is accepted.
 *  - Boolean fields require typeof === 'boolean' (consistent with the core). Python's
 *    non-strict bool fields accepted 0/1 ints for clickable/duplicateId/textTruncated/etc.
 *  - Numeric-text normalization only admits safe-integer JSON numbers; Python accepted
 *    arbitrary-precision ints for the `value`/`key` fields.
 *  - browserObservationDigest routes both the screenshot content block and the outer payload
 *    through the same digest callback over canonical (compact, sorted, strict) JSON. Python
 *    used default-separator json.dumps for the content block and compact separators for the
 *    payload, so hex values differ from the Python reference. The semantic invariants
 *    (excluded identity/timing fields, elementRef stripping, image identification) are preserved.
 */
import type { Json, ObjectValue, RunScope } from './contracts.mjs';
import { invariant, NativeError, isNativeError, scopeKey } from './values.mjs';

export const BROWSER_SESSION_SCHEMA = 'agentkit.browser-session/v1' as const;
export const BROWSER_OBSERVATION_SCHEMA = 'agentkit.browser-observation/v1' as const;

export type BrowserBackend = 'playwright';
export type BrowserActionKind = 'navigate' | 'click' | 'fill' | 'press' | 'move' | 'scroll' | 'screenshot' | 'close';
export type BrowserButton = 'left' | 'right' | 'middle';
export type BrowserObservationStatus = 'ok' | 'error' | 'uncertain';
export type BrowserRetryability = 'safe' | 'requires_reconcile' | 'forbidden';
export type BrowserRecoveryStatus = 'reconnected' | 'restarted' | 'lost';
export type BrowserSourceTrust = 'untrusted_page';

/** Stable browser-session identity bound to one scope/run/runtime/generation. */
export interface BrowserSessionRef {
  schemaVersion: typeof BROWSER_SESSION_SCHEMA;
  sessionId: string;
  scope: RunScope;
  runId: string;
  runtimeId: string;
  backend: BrowserBackend;
  workspaceRevision: string;
  generation: number;
  leaseEpoch: number;
}

/** A bounded, kind-bound browser action. One target for click/fill/press; strict coordinates. */
export interface BrowserAction {
  actionId: string;
  kind: BrowserActionKind;
  url: string | null;
  selector: string | null;
  elementRef: string | null;
  value: string | null;
  key: string | null;
  button: BrowserButton | null;
  x: number | null;
  y: number | null;
  steps: number | null;
  deltaX: number | null;
  deltaY: number | null;
  durationMs: number | null;
  timeoutMs: number;
}

/** Host-admitted image bytes; tool text and filesystem paths never promote into trusted data. */
export interface BrowserImage {
  contentRef: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  contentBlock: ObjectValue;
}

/** Bounded, untrusted DOM hint; never includes an input's current value. */
export interface BrowserControl {
  tag: string;
  role: string;
  label: string;
  selector: string | null;
  /** Opaque host reference to this DOM node; not a page-supplied selector. */
  elementRef: string | null;
  clickable: boolean;
  /** Current-viewport pointer hit test, not proof that a click will succeed. */
  hitTestReachable: boolean | null;
  duplicateId: boolean;
}

/** Observed browser state. Browser-derived text is untrusted data, never policy instructions. */
export interface BrowserObservation {
  schemaVersion: typeof BROWSER_OBSERVATION_SCHEMA;
  sessionRef: BrowserSessionRef;
  actionId: string;
  actionSeq: number;
  status: BrowserObservationStatus;
  errorCode: string | null;
  complete: boolean;
  retryability: BrowserRetryability;
  url: string;
  statusCode: number | null;
  title: string;
  viewport: [number, number];
  focus: string;
  /** Observed main-frame scroll offsets, not the requested wheel deltas. */
  scrollX: number | null;
  scrollY: number | null;
  lifecycle: string;
  /** Observed pointer-lock state, not a model-inferred explanation of a failed action. */
  pointerLockActive: boolean | null;
  text: string;
  textTruncated: boolean;
  /** Bounded DOM sample timing; False/None is not proof of atomic capture or visual stability. */
  domChangedDuringCapture: boolean | null;
  controls: BrowserControl[];
  console: string[];
  pageErrors: string[];
  pageErrorLocations: string[];
  networkFailures: string[];
  logsTruncated: boolean;
  screenshot: BrowserImage | null;
  sourceTrust: BrowserSourceTrust;
}

/** Host capability: a bound ToolPort rejects old actions and supports a fresh observation. */
export interface BrowserRecovery {
  status: BrowserRecoveryStatus;
  sessionRef: BrowserSessionRef;
  lastActionSeq: number;
  reason: string | null;
  reobserveAvailable: boolean;
}

/** A stable error code, without page contents, credentials or driver diagnostics.
 *  The contract validators below throw NativeError (via invariant) with stable codes; this
 *  class is provided for the runtime adapter (parent-owned) to raise operational error codes,
 *  mirroring Python's BrowserSessionError(RuntimeError). */
export class BrowserSessionError extends NativeError {
  constructor(code: string) { super(code); this.name = 'BrowserSessionError'; }
}

const SESSION_REF_KEYS = ['schemaVersion', 'sessionId', 'scope', 'runId', 'runtimeId', 'backend', 'workspaceRevision', 'generation', 'leaseEpoch'] as const;
const ACTION_KEYS = ['actionId', 'kind', 'url', 'selector', 'elementRef', 'value', 'key', 'button', 'x', 'y', 'steps', 'deltaX', 'deltaY', 'durationMs', 'timeoutMs'] as const;
const ACTION_KINDS = ['navigate', 'click', 'fill', 'press', 'move', 'scroll', 'screenshot', 'close'] as const;
const BUTTONS = ['left', 'right', 'middle'] as const;
const IMAGE_KEYS = ['contentRef', 'mimeType', 'width', 'height', 'contentBlock'] as const;
const CONTROL_KEYS = ['tag', 'role', 'label', 'selector', 'elementRef', 'clickable', 'hitTestReachable', 'duplicateId'] as const;
const OBSERVATION_KEYS = ['schemaVersion', 'sessionRef', 'actionId', 'actionSeq', 'status', 'errorCode', 'complete', 'retryability', 'url', 'statusCode', 'title', 'viewport', 'focus', 'scrollX', 'scrollY', 'lifecycle', 'pointerLockActive', 'text', 'textTruncated', 'domChangedDuringCapture', 'controls', 'console', 'pageErrors', 'pageErrorLocations', 'networkFailures', 'logsTruncated', 'screenshot', 'sourceTrust'] as const;
const RECOVERY_KEYS = ['status', 'sessionRef', 'lastActionSeq', 'reason', 'reobserveAvailable'] as const;
const STATUSES = ['ok', 'error', 'uncertain'] as const;
const RETRYABILITIES = ['safe', 'requires_reconcile', 'forbidden'] as const;
const RECOVERY_STATUSES = ['reconnected', 'restarted', 'lost'] as const;

function isRecord(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
/** Count Unicode code points, matching Pydantic's string length bounds. JS .length counts
 *  UTF-16 code units, so an astral character (e.g. '😀') would count as 2; this counts it as 1.
 *  A lone surrogate also counts as 1, matching Python len() over a surrogate string. */
function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length;) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { count++; i += 2; continue; }
    }
    count++; i++;
  }
  return count;
}
function get(input: ObjectValue, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
}
function hasOnlyKeys(input: ObjectValue, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) invariant(false, code);
}
function reqString(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== 'string') invariant(false, code);
  const length = codePointLength(value);
  if (length < min || length > max) invariant(false, code);
  return value;
}
function optString(value: unknown, max: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || codePointLength(value) > max) invariant(false, code);
  return value;
}
function optStringBounded(value: unknown, min: number, max: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invariant(false, code);
  const length = codePointLength(value);
  if (length < min || length > max) invariant(false, code);
  return value;
}
function reqInt(value: unknown, min: number, max: number, code: string): number {
  if (!isInt(value) || value < min || value > max) invariant(false, code);
  return value;
}
function optInt(value: unknown, min: number, max: number, code: string): number | null {
  if (value === undefined || value === null) return null;
  if (!isInt(value) || value < min || value > max) invariant(false, code);
  return value;
}
function reqBool(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') invariant(false, code);
  return value;
}
function optBool(value: unknown, code: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') invariant(false, code);
  return value;
}
function reqLiteral<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invariant(false, code);
  return value as T;
}
function optLiteral<T extends string>(value: unknown, allowed: readonly T[], code: string): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) invariant(false, code);
  return value as T;
}
/** Validate a dense tuple/list of strings. Array#every/map skip sparse holes, so each index is
 *  checked with hasOwnProperty; a hole or non-string is rejected, never silently coerced to null
 *  or dropped. Returns a fresh dense array (no caller-controlled references). */
function reqStringArray(value: unknown, code: string): string[] {
  invariant(Array.isArray(value), code);
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    invariant(Object.prototype.hasOwnProperty.call(value, i), code);
    const item = (value as unknown[])[i];
    invariant(typeof item === 'string', code);
    result.push(item);
  }
  return result;
}
function validateRunScope(value: unknown): RunScope {
  invariant(isRecord(value), 'invalid_scope');
  scopeKey(value as unknown as RunScope);
  const scope = value as unknown as RunScope;
  return { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId, agentId: scope.agentId };
}

/** Validate and normalize a BrowserSessionRef, applying defaults and rejecting extra fields. */
export function validateBrowserSessionRef(input: unknown): BrowserSessionRef {
  const code = 'invalid_browser_session_ref';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, SESSION_REF_KEYS, code);
  const schemaVersion = get(input, 'schemaVersion');
  if (schemaVersion !== undefined && schemaVersion !== BROWSER_SESSION_SCHEMA) invariant(false, code);
  const sessionId = reqString(get(input, 'sessionId'), 1, Number.MAX_SAFE_INTEGER, code);
  const scope = validateRunScope(get(input, 'scope'));
  const runId = reqString(get(input, 'runId'), 1, Number.MAX_SAFE_INTEGER, code);
  const runtimeId = reqString(get(input, 'runtimeId'), 1, Number.MAX_SAFE_INTEGER, code);
  const backend = get(input, 'backend');
  if (backend !== undefined && backend !== 'playwright') invariant(false, code);
  const workspaceRevision = reqString(get(input, 'workspaceRevision'), 1, Number.MAX_SAFE_INTEGER, code);
  const generationRaw = get(input, 'generation');
  const generation = generationRaw === undefined ? 1 : reqInt(generationRaw, 1, Number.MAX_SAFE_INTEGER, code);
  const leaseEpochRaw = get(input, 'leaseEpoch');
  const leaseEpoch = leaseEpochRaw === undefined ? 1 : reqInt(leaseEpochRaw, 1, Number.MAX_SAFE_INTEGER, code);
  return { schemaVersion: BROWSER_SESSION_SCHEMA, sessionId, scope, runId, runtimeId, backend: 'playwright', workspaceRevision, generation, leaseEpoch };
}

/** HTML fill and keyboard digit presses are text operations. Some model transports encode a
 *  digit-only argument as a JSON integer, so admit that value explicitly at this boundary while
 *  preserving every other argument's strict schema. Only actual JSON numbers (not booleans or
 *  whole floats) are admitted; Python accepted arbitrary-precision ints. */
function normalizeNumericText(field: 'value' | 'key', raw: unknown): unknown {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    if (field === 'value') return String(raw);
    if (raw >= 0 && raw <= 9) return String(raw);
  }
  return raw;
}
function normalizeOptionalText(field: 'value' | 'key', raw: unknown, max: number, code: string): string | null {
  if (raw === undefined || raw === null) return null;
  const normalized = normalizeNumericText(field, raw);
  if (typeof normalized !== 'string' || codePointLength(normalized) > max) invariant(false, code);
  return normalized;
}

/** Validate and normalize a BrowserAction, including the kind-bound argument contract. */
export function validateBrowserAction(input: unknown): BrowserAction {
  const code = 'invalid_browser_action';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, ACTION_KEYS, code);
  const actionId = reqString(get(input, 'actionId'), 1, 256, code);
  const kind = reqLiteral(get(input, 'kind'), ACTION_KINDS, code);
  const url = optString(get(input, 'url'), 8192, code);
  const selector = optString(get(input, 'selector'), 2048, code);
  const elementRef = optStringBounded(get(input, 'elementRef'), 1, 64, code);
  const value = normalizeOptionalText('value', get(input, 'value'), 65536, code);
  const key = normalizeOptionalText('key', get(input, 'key'), 128, code);
  const button = optLiteral(get(input, 'button'), BUTTONS, code);
  const x = optInt(get(input, 'x'), 0, 4096, code);
  const y = optInt(get(input, 'y'), 0, 4096, code);
  const steps = optInt(get(input, 'steps'), 1, 30, code);
  const deltaX = optInt(get(input, 'deltaX'), -10000, 10000, code);
  const deltaY = optInt(get(input, 'deltaY'), -10000, 10000, code);
  const durationMs = optInt(get(input, 'durationMs'), 0, 5000, code);
  const timeoutMsRaw = get(input, 'timeoutMs');
  const timeoutMs = timeoutMsRaw === undefined ? 30000 : reqInt(timeoutMsRaw, 1, 120000, code);
  const action: BrowserAction = { actionId, kind, url, selector, elementRef, value, key, button, x, y, steps, deltaX, deltaY, durationMs, timeoutMs };
  validateBrowserActionArguments(action);
  return action;
}

/** Enforce the kind-bound argument contract: one target for click/fill/press, required fields
 *  per kind, and the bounded allowed extras (durationMs for click/press, button for click,
 *  steps for move, scroll anchor x/y together). Mirrors browser_contract.py valid_arguments. */
function validateBrowserActionArguments(action: BrowserAction): void {
  const { kind, selector, elementRef, url, value, key, button, x, y, steps, deltaX, deltaY, durationMs } = action;
  if (kind === 'click' || kind === 'fill' || kind === 'press') {
    invariant((selector === null) !== (elementRef === null), 'browser_action_requires_one_target');
  }
  let required: Set<string>;
  switch (kind) {
    case 'navigate': required = new Set(['url']); break;
    case 'click': required = new Set(['selector']); break;
    case 'fill': required = new Set(['selector', 'value']); break;
    case 'press': required = new Set(['selector', 'key']); break;
    case 'move': required = new Set(['x', 'y']); break;
    case 'scroll': required = new Set(['deltaX', 'deltaY']); break;
    default: required = new Set<string>(); break;
  }
  if (elementRef !== null && (kind === 'click' || kind === 'fill' || kind === 'press')) {
    required.delete('selector');
    required.add('elementRef');
  }
  const supplied = new Set<string>();
  if (url !== null) supplied.add('url');
  if (selector !== null) supplied.add('selector');
  if (elementRef !== null) supplied.add('elementRef');
  if (value !== null) supplied.add('value');
  if (key !== null) supplied.add('key');
  if (button !== null) supplied.add('button');
  if (x !== null) supplied.add('x');
  if (y !== null) supplied.add('y');
  if (steps !== null) supplied.add('steps');
  if (deltaX !== null) supplied.add('deltaX');
  if (deltaY !== null) supplied.add('deltaY');
  if (durationMs !== null) supplied.add('durationMs');
  if (kind === 'click' || kind === 'press') supplied.delete('durationMs');
  if (kind === 'click') supplied.delete('button');
  if (kind === 'move') supplied.delete('steps');
  if (kind === 'scroll') {
    invariant((x === null) === (y === null), 'scroll_anchor_requires_both_coordinates');
    supplied.delete('x');
    supplied.delete('y');
  }
  if (supplied.size !== required.size || [...required].some(field => !supplied.has(field))) {
    invariant(false, 'invalid_browser_action_arguments');
  }
  // Required fields other than value/coordinates must be non-empty (url, selector, elementRef, key).
  for (const field of required) {
    if (field === 'value' || field === 'x' || field === 'y' || field === 'deltaX' || field === 'deltaY') continue;
    const current = field === 'url' ? url : field === 'selector' ? selector : field === 'elementRef' ? elementRef : field === 'key' ? key : null;
    if (!current) invariant(false, 'invalid_browser_action_arguments');
  }
}

/** Validate and normalize a BrowserControl, applying defaults and rejecting extra fields. */
export function validateBrowserControl(input: unknown): BrowserControl {
  const code = 'invalid_browser_control';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, CONTROL_KEYS, code);
  const tag = reqString(get(input, 'tag'), 1, 32, code);
  const roleRaw = get(input, 'role');
  const role = roleRaw === undefined ? '' : reqString(roleRaw, 0, 80, code);
  const labelRaw = get(input, 'label');
  const label = labelRaw === undefined ? '' : reqString(labelRaw, 0, 160, code);
  const selector = optStringBounded(get(input, 'selector'), 1, 512, code);
  const elementRef = optStringBounded(get(input, 'elementRef'), 1, 64, code);
  const clickableRaw = get(input, 'clickable');
  const clickable = clickableRaw === undefined ? false : reqBool(clickableRaw, code);
  const hitTestReachable = optBool(get(input, 'hitTestReachable'), code);
  const duplicateIdRaw = get(input, 'duplicateId');
  const duplicateId = duplicateIdRaw === undefined ? false : reqBool(duplicateIdRaw, code);
  return { tag, role, label, selector, elementRef, clickable, hitTestReachable, duplicateId };
}

function validateControls(value: unknown): BrowserControl[] {
  invariant(Array.isArray(value) && value.length <= 40, 'invalid_browser_observation');
  // Array#map skips sparse holes; require every index present so a malformed tuple is rejected,
  // not silently truncated. Returns fresh controls (no caller-controlled references).
  const result: BrowserControl[] = [];
  for (let i = 0; i < value.length; i++) {
    invariant(Object.prototype.hasOwnProperty.call(value, i), 'invalid_browser_observation');
    result.push(validateBrowserControl((value as unknown[])[i]));
  }
  return result;
}

/** Recursively validate and snapshot a plain JSON value for an image content block.
 *  Rejects non-JSON values (functions, symbols, bigint, undefined), non-finite numbers, cycles,
 *  inappropriate prototypes and sparse array holes; returns an independent clone so later mutation
 *  of the caller's object cannot corrupt the validated observation. Throws NativeError(code) for
 *  every failure, never a raw TypeError/RangeError/SyntaxError (e.g. from a getter or Proxy trap). */
function cloneJson(input: unknown, active: Set<object>, code: string): Json {
  if (input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'string') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) invariant(false, code);
    return input;
  }
  if (typeof input !== 'object') invariant(false, code); // function, symbol, bigint, undefined
  if (active.has(input)) invariant(false, code); // cycle
  active.add(input);
  let result: Json;
  if (Array.isArray(input)) {
    const array: Json[] = [];
    for (let i = 0; i < input.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(input, i)) { active.delete(input); invariant(false, code); }
      array.push(cloneJson(input[i], active, code));
    }
    result = array;
  } else {
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      active.delete(input);
      invariant(false, code);
    }
    const object: ObjectValue = {};
    for (const key of Object.keys(input)) Object.defineProperty(object, key, {
      value: cloneJson((input as ObjectValue)[key], active, code), enumerable: true, writable: true, configurable: true,
    });
    result = object;
  }
  active.delete(input);
  return result;
}

/** Validate and normalize a BrowserImage. The content block is a trusted host object, not text. */
export function validateBrowserImage(input: unknown): BrowserImage {
  const code = 'invalid_browser_image';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, IMAGE_KEYS, code);
  const contentRef = reqString(get(input, 'contentRef'), 1, Number.MAX_SAFE_INTEGER, code);
  const mimeType = get(input, 'mimeType');
  if (mimeType !== undefined && mimeType !== 'image/png') invariant(false, code);
  const width = reqInt(get(input, 'width'), 1, Number.MAX_SAFE_INTEGER, code);
  const height = reqInt(get(input, 'height'), 1, Number.MAX_SAFE_INTEGER, code);
  const contentBlockRaw = get(input, 'contentBlock');
  invariant(isRecord(contentBlockRaw), code); // dict[str, JsonValue]: top-level must be an object
  let contentBlock: ObjectValue;
  try {
    contentBlock = cloneJson(contentBlockRaw, new Set(), code) as ObjectValue;
  } catch (error) {
    if (isNativeError(error)) throw error;
    throw new NativeError(code);
  }
  return { contentRef, mimeType: 'image/png', width, height, contentBlock };
}

/** Validate and normalize a BrowserObservation, applying defaults and rejecting extra fields. */
export function validateBrowserObservation(input: unknown): BrowserObservation {
  const code = 'invalid_browser_observation';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, OBSERVATION_KEYS, code);
  const schemaVersion = get(input, 'schemaVersion');
  if (schemaVersion !== undefined && schemaVersion !== BROWSER_OBSERVATION_SCHEMA) invariant(false, code);
  const sessionRef = validateBrowserSessionRef(get(input, 'sessionRef'));
  const actionId = reqString(get(input, 'actionId'), 0, Number.MAX_SAFE_INTEGER, code);
  const actionSeq = reqInt(get(input, 'actionSeq'), 0, Number.MAX_SAFE_INTEGER, code);
  const status = reqLiteral(get(input, 'status'), STATUSES, code);
  const errorCode = optString(get(input, 'errorCode'), Number.MAX_SAFE_INTEGER, code);
  const complete = reqBool(get(input, 'complete'), code);
  const retryability = reqLiteral(get(input, 'retryability'), RETRYABILITIES, code);
  const urlRaw = get(input, 'url');
  const url = urlRaw === undefined ? '' : reqString(urlRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const statusCodeRaw = get(input, 'statusCode');
  const statusCode = statusCodeRaw === undefined || statusCodeRaw === null ? null : reqInt(statusCodeRaw, 100, 599, code);
  const titleRaw = get(input, 'title');
  const title = titleRaw === undefined ? '' : reqString(titleRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const viewportRaw = get(input, 'viewport');
  invariant(Array.isArray(viewportRaw) && viewportRaw.length === 2, code);
  const viewportWidth = viewportRaw[0];
  const viewportHeight = viewportRaw[1];
  if (!isInt(viewportWidth) || !isInt(viewportHeight)) invariant(false, code);
  const viewport: [number, number] = [viewportWidth, viewportHeight];
  const focusRaw = get(input, 'focus');
  const focus = focusRaw === undefined ? '' : reqString(focusRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const scrollX = optInt(get(input, 'scrollX'), Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, code);
  const scrollY = optInt(get(input, 'scrollY'), Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, code);
  const lifecycleRaw = get(input, 'lifecycle');
  const lifecycle = lifecycleRaw === undefined ? 'unknown' : reqString(lifecycleRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const pointerLockActive = optBool(get(input, 'pointerLockActive'), code);
  const textRaw = get(input, 'text');
  const text = textRaw === undefined ? '' : reqString(textRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const textTruncatedRaw = get(input, 'textTruncated');
  const textTruncated = textTruncatedRaw === undefined ? false : reqBool(textTruncatedRaw, code);
  const domChangedDuringCapture = optBool(get(input, 'domChangedDuringCapture'), code);
  const controlsRaw = get(input, 'controls');
  const controls = controlsRaw === undefined ? [] : validateControls(controlsRaw);
  const consoleRaw = get(input, 'console');
  const consoleList = consoleRaw === undefined ? [] : reqStringArray(consoleRaw, code);
  const pageErrorsRaw = get(input, 'pageErrors');
  const pageErrors = pageErrorsRaw === undefined ? [] : reqStringArray(pageErrorsRaw, code);
  const pageErrorLocationsRaw = get(input, 'pageErrorLocations');
  const pageErrorLocations = pageErrorLocationsRaw === undefined ? [] : reqStringArray(pageErrorLocationsRaw, code);
  const networkFailuresRaw = get(input, 'networkFailures');
  const networkFailures = networkFailuresRaw === undefined ? [] : reqStringArray(networkFailuresRaw, code);
  const logsTruncatedRaw = get(input, 'logsTruncated');
  const logsTruncated = logsTruncatedRaw === undefined ? false : reqBool(logsTruncatedRaw, code);
  const screenshotRaw = get(input, 'screenshot');
  const screenshot = screenshotRaw === undefined || screenshotRaw === null ? null : validateBrowserImage(screenshotRaw);
  const sourceTrust = get(input, 'sourceTrust');
  if (sourceTrust !== undefined && sourceTrust !== 'untrusted_page') invariant(false, code);
  return {
    schemaVersion: BROWSER_OBSERVATION_SCHEMA, sessionRef, actionId, actionSeq, status, errorCode, complete, retryability,
    url, statusCode, title, viewport, focus, scrollX, scrollY, lifecycle, pointerLockActive, text, textTruncated,
    domChangedDuringCapture, controls, console: consoleList, pageErrors, pageErrorLocations, networkFailures,
    logsTruncated, screenshot, sourceTrust: 'untrusted_page',
  };
}

/** Validate and normalize a BrowserRecovery. Cross-instance recovery invariants (scope match,
 *  count match, generation/leaseEpoch increment on restart) are owned by the parent runtime
 *  (browser_recovery.py); this validator enforces only the struct shape. */
export function validateBrowserRecovery(input: unknown): BrowserRecovery {
  const code = 'invalid_browser_recovery';
  invariant(isRecord(input), code);
  hasOnlyKeys(input, RECOVERY_KEYS, code);
  const status = reqLiteral(get(input, 'status'), RECOVERY_STATUSES, code);
  const sessionRef = validateBrowserSessionRef(get(input, 'sessionRef'));
  const lastActionSeqRaw = get(input, 'lastActionSeq');
  const lastActionSeq = lastActionSeqRaw === undefined ? 0 : reqInt(lastActionSeqRaw, 0, Number.MAX_SAFE_INTEGER, code);
  const reason = optString(get(input, 'reason'), Number.MAX_SAFE_INTEGER, code);
  const reobserveAvailableRaw = get(input, 'reobserveAvailable');
  const reobserveAvailable = reobserveAvailableRaw === undefined ? false : reqBool(reobserveAvailableRaw, code);
  return { status, sessionRef, lastActionSeq, reason, reobserveAvailable };
}

/** Hash captured state without action identities or artifact locations.
 *
 *  Actual page timestamps, errors, focus and controls remain meaningful data. An image's
 *  bytes/model block identify it, rather than the artifact sink's path or URI. The digest
 *  excludes sessionRef/actionId/actionSeq (identity), domChangedDuringCapture (timing, not
 *  progress) and elementRef from each control (allocation metadata). This is observation
 *  novelty, never task completion evidence.
 *
 *  The `digest` callback receives a JSON value and must return its lowercase hex SHA-256 over
 *  the core's canonical JSON, matching the hook-contract digest convention. Returns
 *  "sha256:" + hex, mirroring the Python reference. */
export function browserObservationDigest(observation: BrowserObservation, digest: (value: unknown) => string): string {
  const payload: Record<string, unknown> = {
    schemaVersion: observation.schemaVersion,
    status: observation.status,
    errorCode: observation.errorCode,
    complete: observation.complete,
    retryability: observation.retryability,
    url: observation.url,
    statusCode: observation.statusCode,
    title: observation.title,
    viewport: observation.viewport,
    focus: observation.focus,
    scrollX: observation.scrollX,
    scrollY: observation.scrollY,
    lifecycle: observation.lifecycle,
    pointerLockActive: observation.pointerLockActive,
    text: observation.text,
    textTruncated: observation.textTruncated,
    controls: observation.controls.map(control => ({
      tag: control.tag, role: control.role, label: control.label, selector: control.selector,
      clickable: control.clickable, hitTestReachable: control.hitTestReachable, duplicateId: control.duplicateId,
    })),
    console: observation.console,
    pageErrors: observation.pageErrors,
    pageErrorLocations: observation.pageErrorLocations,
    networkFailures: observation.networkFailures,
    logsTruncated: observation.logsTruncated,
    sourceTrust: observation.sourceTrust,
  };
  if (observation.screenshot !== null) {
    const screenshot = observation.screenshot;
    payload.screenshot = {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
      imageDigest: digest(screenshot.contentBlock),
    };
  }
  return 'sha256:' + digest(payload);
}
