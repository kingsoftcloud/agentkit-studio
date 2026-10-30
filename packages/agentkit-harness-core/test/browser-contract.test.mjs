import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../dist/values.mjs';
import {
  BROWSER_OBSERVATION_SCHEMA, BROWSER_SESSION_SCHEMA, BrowserSessionError,
  browserObservationDigest, validateBrowserAction, validateBrowserControl, validateBrowserImage,
  validateBrowserObservation, validateBrowserRecovery, validateBrowserSessionRef,
} from '../dist/browser-contract.mjs';

// The contract's digest convention matches the core hook-contract digest: the callback
// canonicalizes via the core's canonical JSON and returns lowercase hex (no prefix).
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const rejects = (fn, re) => assert.throws(fn, re instanceof RegExp ? re : undefined);

function refInput(overrides = {}) {
  return { sessionId: 'page', scope, runId: 'run', runtimeId: 'host', workspaceRevision: 'w1', ...overrides };
}
function ref(overrides = {}) { return validateBrowserSessionRef(refInput(overrides)); }
function actionInput(overrides = {}) { return { actionId: 'a1', kind: 'screenshot', ...overrides }; }
function act(overrides = {}) { return validateBrowserAction(actionInput(overrides)); }
function imageInput(overrides = {}) {
  return { contentRef: 'artifact:image', width: 1, height: 1,
    contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }, ...overrides };
}
function controlInput(overrides = {}) { return { tag: 'button', label: 'Save', selector: '#save', ...overrides }; }
function observationInput(overrides = {}) {
  return {
    sessionRef: ref(), actionId: 'action-1', actionSeq: 1, status: 'error', errorCode: 'selector_not_visible',
    complete: true, retryability: 'safe', url: 'http://localhost/board', viewport: [1280, 720], text: 'Current page',
    controls: [controlInput()], screenshot: imageInput(), ...overrides,
  };
}
function observation(overrides = {}) { return validateBrowserObservation(observationInput(overrides)); }
function recoveryInput(overrides = {}) {
  return { status: 'reconnected', sessionRef: ref(), ...overrides };
}

test('BrowserSessionRef applies defaults and rejects scope/identity violations', () => {
  const minimal = validateBrowserSessionRef({ sessionId: 'page', scope, runId: 'run', runtimeId: 'host', workspaceRevision: 'w1' });
  assert.strictEqual(minimal.schemaVersion, BROWSER_SESSION_SCHEMA);
  assert.strictEqual(minimal.backend, 'playwright');
  assert.strictEqual(minimal.generation, 1);
  assert.strictEqual(minimal.leaseEpoch, 1);
  assert.deepStrictEqual(minimal.scope, scope);
  assert.strictEqual(ref({ generation: 2, leaseEpoch: 3 }).generation, 2);
  // Required non-empty identity strings.
  for (const key of ['sessionId', 'runId', 'runtimeId', 'workspaceRevision']) {
    rejects(() => ref({ [key]: '' }), /invalid_browser_session_ref/);
    ref({ [key]: 'x' }); // min length 1 accepts a single character without throwing
  }
  // Generation/leaseEpoch are safe-positive integers; booleans and whole floats are rejected.
  rejects(() => ref({ generation: 0 }), /invalid_browser_session_ref/);
  rejects(() => ref({ generation: true }), /invalid_browser_session_ref/);
  rejects(() => ref({ generation: 1.5 }), /invalid_browser_session_ref/);
  rejects(() => ref({ leaseEpoch: 0 }), /invalid_browser_session_ref/);
  // Backend is a fixed literal; schemaVersion is a fixed literal with a default.
  rejects(() => ref({ backend: 'webdriver' }), /invalid_browser_session_ref/);
  rejects(() => ref({ schemaVersion: 'ksadk.browser-session/v1' }), /invalid_browser_session_ref/);
  rejects(() => ref({ extra: 1 }), /invalid_browser_session_ref/);
  rejects(() => validateBrowserSessionRef(null), /invalid_browser_session_ref/);
  // Scope binding: the core's scopeKey rejects blank components and extra keys.
  rejects(() => ref({ scope: { ...scope, tenantId: ' ' } }), /invalid_scope/);
  rejects(() => ref({ scope: { tenantId: 't', workspaceId: 'w', userId: 'u' } }), /invalid_scope/);
  rejects(() => ref({ scope: { ...scope, extra: 1 } }), /invalid_scope/);
  rejects(() => ref({ scope: { ...scope, agentId: '' } }), /invalid_scope/);
});

test('BrowserAction normalizes numeric text for fill value and press key only', () => {
  assert.strictEqual(act({ kind: 'fill', selector: '#count', value: 42 }).value, '42');
  assert.strictEqual(act({ kind: 'fill', selector: '#count', value: 0 }).value, '0');
  assert.strictEqual(act({ kind: 'fill', selector: '#count', value: -5 }).value, '-5');
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: 7 }).key, '7');
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: 0 }).key, '0');
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: 9 }).key, '9');
  // Booleans are not numbers: they stay un-normalized and fail the strict string schema.
  rejects(() => act({ kind: 'fill', selector: '#x', value: true }), /invalid_browser_action/);
  rejects(() => act({ kind: 'press', selector: 'body', key: true }), /invalid_browser_action/);
  // Keys outside 0-9 are not admitted as digits and fail the string schema.
  rejects(() => act({ kind: 'press', selector: 'body', key: 13 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'press', selector: 'body', key: false }), /invalid_browser_action/);
  // Non-integer floats are not normalized.
  rejects(() => act({ kind: 'fill', selector: '#x', value: 1.5 }), /invalid_browser_action/);
  // Empty fill value is a valid text operation.
  assert.strictEqual(act({ kind: 'fill', selector: '#title', value: '' }).value, '');
});

test('BrowserAction navigate requires a non-empty url and rejects extras', () => {
  assert.strictEqual(act({ kind: 'navigate', url: 'http://127.0.0.1:8080/' }).url, 'http://127.0.0.1:8080/');
  rejects(() => act({ kind: 'navigate', url: '' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'navigate' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'navigate', url: 'http://x/', selector: '#x' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'navigate', url: 'http://x/', elementRef: 'r' }), /invalid_browser_action_arguments/);
});

test('BrowserAction click requires exactly one target and allows button/durationMs', () => {
  assert.strictEqual(act({ kind: 'click', selector: '#start' }).selector, '#start');
  assert.strictEqual(act({ kind: 'click', selector: '#start', button: 'right' }).button, 'right');
  assert.strictEqual(act({ kind: 'click', selector: '#start', durationMs: 300 }).durationMs, 300);
  assert.strictEqual(act({ kind: 'click', elementRef: 'r' }).elementRef, 'r');
  assert.strictEqual(act({ kind: 'click', elementRef: 'r', button: 'right' }).button, 'right');
  // Exactly one of selector/elementRef.
  rejects(() => act({ kind: 'click' }), /browser_action_requires_one_target/);
  rejects(() => act({ kind: 'click', selector: '#s', elementRef: 'r' }), /browser_action_requires_one_target/);
  rejects(() => act({ kind: 'click', selector: '#s', key: 'w' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'click', selector: '#s', value: 'v' }), /invalid_browser_action_arguments/);
  // selector has no field-level min length (only max 2048); an empty selector is rejected by the
  // arguments check, mirroring the Python valid_arguments truthy rule, not the field validator.
  rejects(() => act({ kind: 'click', selector: '' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'navigate', url: 'http://x/', selector: '' }), /invalid_browser_action_arguments/);
});

test('BrowserAction fill/press require selector+value/selector+key and bind durationMs to press', () => {
  assert.strictEqual(act({ kind: 'fill', selector: '#name', value: 'player' }).value, 'player');
  rejects(() => act({ kind: 'fill', selector: '#name' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'fill', selector: '#name', value: 'v', durationMs: 1 }), /invalid_browser_action_arguments/);
  assert.strictEqual(act({ kind: 'fill', elementRef: 'r', value: 'v' }).elementRef, 'r');
  rejects(() => act({ kind: 'fill', elementRef: 'r' }), /invalid_browser_action_arguments/);
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: 'w' }).key, 'w');
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: 'w', durationMs: 300 }).durationMs, 300);
  rejects(() => act({ kind: 'press', selector: 'body', key: 'w', button: 'left' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'press', selector: 'body', key: '' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'press', selector: 'body' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'press', elementRef: 'r' }), /invalid_browser_action_arguments/);
});

test('BrowserAction move requires both coordinates and binds steps; scroll requires deltas and anchors together', () => {
  // steps is allowed (not an extra) for move but its value is still carried on the action.
  assert.strictEqual(act({ kind: 'move', x: 0, y: 0 }).steps, null);
  assert.strictEqual(act({ kind: 'move', x: 0, y: 360, steps: 5 }).steps, 5);
  rejects(() => act({ kind: 'move', x: 12 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'move', x: 2, y: 3, button: 'right' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'move', x: 2, y: 3, durationMs: 1 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'move', x: 4097, y: 0 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'move', x: -1, y: 0 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'move', x: true, y: 0 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'move', x: 1.5, y: 0 }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'scroll', deltaX: -12, deltaY: 300 }).deltaY, 300);
  assert.strictEqual(act({ kind: 'scroll', deltaX: 0, deltaY: 0 }).deltaY, 0);
  assert.strictEqual(act({ kind: 'scroll', deltaX: -12, deltaY: 300, x: 200, y: 150 }).x, 200);
  rejects(() => act({ kind: 'scroll', deltaX: 0 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: 10001 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: 3, x: 2 }), /scroll_anchor_requires_both_coordinates/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: 3, x: 2, y: 4, selector: 'body' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'scroll', deltaX: true, deltaY: 3 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: '3' }), /invalid_browser_action/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: 3.5 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'scroll', deltaX: 0, deltaY: 3, selector: 'body' }), /invalid_browser_action_arguments/);
});

test('BrowserAction screenshot/close take no arguments; durationMs is only valid for click and press', () => {
  assert.strictEqual(act({ kind: 'screenshot' }).kind, 'screenshot');
  assert.strictEqual(act({ kind: 'close' }).kind, 'close');
  rejects(() => act({ kind: 'screenshot', durationMs: 1 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'screenshot', url: 'http://x/' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'close', url: 'http://x/' }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'fill', selector: '#name', value: 'a', durationMs: 1 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'move', x: 0, y: 0, durationMs: 1 }), /invalid_browser_action_arguments/);
  rejects(() => act({ kind: 'press', selector: 'body', key: 'w', durationMs: 5001 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'click', selector: '#x', durationMs: 5001 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'click', selector: '#x', durationMs: -1 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'click', selector: '#x', durationMs: true }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'click', selector: '#x', durationMs: 5000 }).durationMs, 5000);
});

test('BrowserAction enforces length bounds, timeoutMs range, kind literal and rejects extras', () => {
  assert.strictEqual(act({ actionId: 'x'.repeat(256), kind: 'screenshot' }).actionId.length, 256);
  rejects(() => act({ actionId: '', kind: 'screenshot' }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x'.repeat(257), kind: 'screenshot' }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'navigate', url: 'x'.repeat(8193) }), /invalid_browser_action/);
  assert.strictEqual(act({ actionId: 'x', kind: 'navigate', url: 'x'.repeat(8192) }).url.length, 8192);
  rejects(() => act({ actionId: 'x', kind: 'fill', selector: 'x'.repeat(2049), value: 'v' }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'click', elementRef: 'x'.repeat(65) }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'fill', selector: 's', value: 'x'.repeat(65537) }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'press', selector: 's', key: 'x'.repeat(129) }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'screenshot', timeoutMs: 30000 }).timeoutMs, 30000);
  assert.strictEqual(act({ kind: 'screenshot', timeoutMs: 1 }).timeoutMs, 1);
  assert.strictEqual(act({ kind: 'screenshot', timeoutMs: 120000 }).timeoutMs, 120000);
  rejects(() => act({ kind: 'screenshot', timeoutMs: 0 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'screenshot', timeoutMs: 120001 }), /invalid_browser_action/);
  rejects(() => act({ kind: 'screenshot', timeoutMs: 1.5 }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'hover' }), /invalid_browser_action/);
  rejects(() => act({ actionId: 'x', kind: 'screenshot', extra: 1 }), /invalid_browser_action/);
  rejects(() => validateBrowserAction(null), /invalid_browser_action/);
  rejects(() => validateBrowserAction([]), /invalid_browser_action/);
});

test('BrowserAction does not enforce URI schemes; the runtime network policy owns that boundary', () => {
  // The contract treats url as a bounded non-empty string. Scheme/origin enforcement lives in the
  // host adapter's network policy, not the serializable contract.
  for (const url of ['http://127.0.0.1:8080/', 'https://example.test/', 'file:///etc/passwd',
    'about:blank', 'ws://127.0.0.1:8000/socket', 'javascript:void(0)', 'data:text/plain,hello']) {
    assert.strictEqual(act({ kind: 'navigate', url }).url, url);
  }
});

test('BrowserImage admits only host image blocks with positive integer dimensions', () => {
  assert.strictEqual(validateBrowserImage(imageInput()).mimeType, 'image/png');
  assert.strictEqual(validateBrowserImage({ contentRef: 'r', width: 1280, height: 720, contentBlock: { type: 'image_url' } }).width, 1280);
  rejects(() => validateBrowserImage({ ...imageInput(), contentRef: '' }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), mimeType: 'image/jpeg' }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), width: 0 }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), height: -1 }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), width: 1.5 }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), width: true }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), contentBlock: [] }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), contentBlock: null }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), contentBlock: 'data:image/png;base64,QQ==' }), /invalid_browser_image/);
  rejects(() => validateBrowserImage({ ...imageInput(), extra: 1 }), /invalid_browser_image/);
});

test('BrowserControl applies defaults and enforces bounded untrusted hints without input values', () => {
  const minimal = validateBrowserControl({ tag: 'button' });
  assert.strictEqual(minimal.role, '');
  assert.strictEqual(minimal.label, '');
  assert.strictEqual(minimal.selector, null);
  assert.strictEqual(minimal.elementRef, null);
  assert.strictEqual(minimal.clickable, false);
  assert.strictEqual(minimal.hitTestReachable, null);
  assert.strictEqual(minimal.duplicateId, false);
  assert.strictEqual(validateBrowserControl({ tag: 'button', hitTestReachable: true }).hitTestReachable, true);
  rejects(() => validateBrowserControl({ tag: '' }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x'.repeat(33) }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', role: 'x'.repeat(81) }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', label: 'x'.repeat(161) }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', selector: 'x'.repeat(513) }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', selector: '' }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', elementRef: 'x'.repeat(65) }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', clickable: 1 }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', hitTestReachable: 0 }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', duplicateId: 1 }), /invalid_browser_control/);
  rejects(() => validateBrowserControl({ tag: 'x', extra: 1 }), /invalid_browser_control/);
});

test('BrowserObservation applies defaults, validates nested refs and rejects extra fields', () => {
  const full = observation();
  assert.strictEqual(full.schemaVersion, BROWSER_OBSERVATION_SCHEMA);
  assert.strictEqual(full.sourceTrust, 'untrusted_page');
  assert.strictEqual(full.url, 'http://localhost/board');
  assert.deepStrictEqual(full.viewport, [1280, 720]);
  assert.strictEqual(full.controls.length, 1);
  const minimal = validateBrowserObservation({
    sessionRef: ref(), actionId: '', actionSeq: 0, status: 'ok', complete: true, retryability: 'safe', viewport: [1, 1],
  });
  assert.strictEqual(minimal.errorCode, null);
  assert.strictEqual(minimal.url, '');
  assert.strictEqual(minimal.title, '');
  assert.strictEqual(minimal.lifecycle, 'unknown');
  assert.strictEqual(minimal.scrollX, null);
  assert.strictEqual(minimal.pointerLockActive, null);
  assert.strictEqual(minimal.domChangedDuringCapture, null);
  assert.deepStrictEqual(minimal.console, []);
  assert.strictEqual(minimal.screenshot, null);
  // actionId has no min-length on observations (unlike BrowserAction.actionId).
  assert.strictEqual(minimal.actionId, '');
  rejects(() => validateBrowserObservation({ ...observationInput(), schemaVersion: 'ksadk.browser-observation/v1' }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), sourceTrust: 'system' }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), status: 'failed' }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), retryability: 'unsafe' }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), actionSeq: -1 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), actionSeq: 1.5 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), complete: 1 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), complete: undefined }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), viewport: [1280] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), viewport: [1280, 720, 1] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), viewport: ['1280', 720] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), statusCode: 99 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), statusCode: 600 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), statusCode: 1.5 }), /invalid_browser_observation/);
  assert.strictEqual(validateBrowserObservation({ ...observationInput(), statusCode: null }).statusCode, null);
  rejects(() => validateBrowserObservation({ ...observationInput(), scrollX: 1.5 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), scrollX: true }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), domChangedDuringCapture: 1 }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), console: ['ok', 1] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), console: 'log' }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), controls: new Array(41).fill(controlInput()) }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...observationInput(), controls: [{ tag: '' }] }), /invalid_browser_control/);
  rejects(() => validateBrowserObservation({ ...observationInput(), screenshot: { contentRef: 'r' } }), /invalid_browser_image/);
  rejects(() => validateBrowserObservation({ ...observationInput(), sessionRef: { ...refInput(), scope: { ...scope, tenantId: ' ' } } }), /invalid_scope/);
  rejects(() => validateBrowserObservation({ ...observationInput(), extra: 1 }), /invalid_browser_observation/);
});

test('BrowserRecovery validates the struct shape; transition invariants are parent-owned', () => {
  assert.strictEqual(validateBrowserRecovery(recoveryInput()).lastActionSeq, 0);
  assert.strictEqual(validateBrowserRecovery(recoveryInput()).reobserveAvailable, false);
  assert.strictEqual(validateBrowserRecovery({ ...recoveryInput(), status: 'restarted', lastActionSeq: 5, reason: 'crashed', reobserveAvailable: true }).status, 'restarted');
  // The contract admits only reconnected/restarted/lost; "unbound" is a runtime-only state.
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), status: 'unbound' }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), status: 'ok' }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), lastActionSeq: -1 }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), lastActionSeq: 1.5 }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), reobserveAvailable: 1 }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), reason: 1 }), /invalid_browser_recovery/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), sessionRef: { ...refInput(), runId: '' } }), /invalid_browser_session_ref/);
  rejects(() => validateBrowserRecovery({ ...recoveryInput(), extra: 1 }), /invalid_browser_recovery/);
});

test('browserObservationDigest excludes identity, timing and allocation fields so evidence cannot be forged', () => {
  const base = observation();
  assert.match(browserObservationDigest(base, digest), /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(browserObservationDigest(base, digest), browserObservationDigest(base, digest));
  // Identity fields are excluded: renaming the action or moving to another session/run does not
  // manufacture new progress evidence.
  assert.strictEqual(browserObservationDigest(base, digest),
    browserObservationDigest(observation({ sessionRef: ref({ sessionId: 'other', runId: 'other-run' }), actionId: 'forged', actionSeq: 99 }), digest));
  // The capture timing flag alone is not task progress.
  assert.strictEqual(browserObservationDigest(base, digest),
    browserObservationDigest(observation({ domChangedDuringCapture: false }), digest));
  assert.strictEqual(browserObservationDigest(observation({ domChangedDuringCapture: false }), digest),
    browserObservationDigest(observation({ domChangedDuringCapture: true }), digest));
  assert.strictEqual(browserObservationDigest(observation({ domChangedDuringCapture: null }), digest),
    browserObservationDigest(observation({ domChangedDuringCapture: false }), digest));
  // A stale or substituted elementRef (allocation metadata) does not change observed state.
  assert.strictEqual(browserObservationDigest(observation({ controls: [controlInput({ elementRef: 'ref-a' })] }), digest),
    browserObservationDigest(observation({ controls: [controlInput({ elementRef: 'ref-b' })] }), digest));
});

test('browserObservationDigest changes when observed state changes', () => {
  const base = observation();
  const different = mutation => browserObservationDigest(observation(mutation), digest);
  assert.notStrictEqual(different({ url: 'http://localhost/other' }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ text: 'Different observed page state' }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ title: 'Changed' }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ errorCode: 'selector_not_clickable' }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ status: 'ok' }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ viewport: [800, 600] }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ controls: [controlInput({ label: 'Load', selector: '#load' })] }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ scrollY: 12 }), browserObservationDigest(base, digest));
  assert.notStrictEqual(different({ console: ['message'] }), browserObservationDigest(base, digest));
  // Control order is observed state, not allocation metadata.
  const a = controlInput({ label: 'A', selector: '#a' });
  const b = controlInput({ label: 'B', selector: '#b' });
  assert.notStrictEqual(browserObservationDigest(observation({ controls: [a, b] }), digest),
    browserObservationDigest(observation({ controls: [b, a] }), digest));
});

test('browserObservationDigest identifies images by their content block, not the artifact sink path', () => {
  const withImage = observation();
  const noImage = observation({ screenshot: null });
  assert.notStrictEqual(browserObservationDigest(withImage, digest), browserObservationDigest(noImage, digest));
  const otherImage = observation({ screenshot: imageInput({ contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,Qg==' } } }) });
  assert.notStrictEqual(browserObservationDigest(withImage, digest), browserObservationDigest(otherImage, digest));
  // Different contentRef (artifact location) with the same bytes is the same image identity.
  const relocated = observation({ screenshot: imageInput({ contentRef: 'artifact:image-relocated' }) });
  assert.strictEqual(browserObservationDigest(withImage, digest), browserObservationDigest(relocated, digest));
  // The image content block is canonicalized, so key order does not affect the digest.
  assert.strictEqual(browserObservationDigest(observation({ screenshot: imageInput({ contentBlock: { image_url: { url: 'data:image/png;base64,QQ==' }, type: 'image_url' } }) }), digest),
    browserObservationDigest(withImage, digest));
});

test('String length bounds count Unicode code points, not UTF-16 code units (Pydantic parity)', () => {
  // '😀' is one code point but two UTF-16 code units; the pinned Python max_length counts code points.
  const emoji = '😀';
  assert.strictEqual([...emoji].length, 1);
  assert.strictEqual(emoji.length, 2);
  // actionId max 256 code points: 256 emoji admitted, 257 rejected (would be 512/514 UTF-16 units).
  assert.strictEqual(act({ actionId: emoji.repeat(256), kind: 'screenshot' }).actionId.length, 512);
  rejects(() => act({ actionId: emoji.repeat(257), kind: 'screenshot' }), /invalid_browser_action/);
  // value max 65536 code points, key max 128, selector max 2048, elementRef max 64.
  assert.strictEqual(act({ kind: 'fill', selector: '#x', value: emoji.repeat(65536) }).value.length, 131072);
  rejects(() => act({ kind: 'fill', selector: '#x', value: emoji.repeat(65537) }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'press', selector: 'body', key: emoji.repeat(128) }).key.length, 256);
  rejects(() => act({ kind: 'press', selector: 'body', key: emoji.repeat(129) }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'click', selector: emoji.repeat(2048) }).selector.length, 4096);
  rejects(() => act({ kind: 'click', selector: emoji.repeat(2049) }), /invalid_browser_action/);
  assert.strictEqual(act({ kind: 'click', elementRef: emoji.repeat(64) }).elementRef.length, 128);
  rejects(() => act({ kind: 'click', elementRef: emoji.repeat(65) }), /invalid_browser_action/);
  // Control bounds: tag 1-32, role max 80, label max 160, selector 1-512, elementRef 1-64.
  assert.strictEqual(validateBrowserControl({ tag: emoji.repeat(32) }).tag.length, 64);
  rejects(() => validateBrowserControl({ tag: emoji.repeat(33) }), /invalid_browser_control/);
  assert.strictEqual(validateBrowserControl({ tag: 'b', role: emoji.repeat(80) }).role.length, 160);
  rejects(() => validateBrowserControl({ tag: 'b', role: emoji.repeat(81) }), /invalid_browser_control/);
  assert.strictEqual(validateBrowserControl({ tag: 'b', label: emoji.repeat(160) }).label.length, 320);
  rejects(() => validateBrowserControl({ tag: 'b', label: emoji.repeat(161) }), /invalid_browser_control/);
  assert.strictEqual(validateBrowserControl({ tag: 'b', selector: emoji.repeat(512) }).selector.length, 1024);
  rejects(() => validateBrowserControl({ tag: 'b', selector: emoji.repeat(513) }), /invalid_browser_control/);
  // A BMP character that is one code unit is unaffected; the boundary is astral code points.
  assert.strictEqual(act({ actionId: 'x'.repeat(256), kind: 'screenshot' }).actionId.length, 256);
  rejects(() => act({ actionId: 'x'.repeat(257), kind: 'screenshot' }), /invalid_browser_action/);
});

test('BrowserImage contentBlock is recursively validated and snapshotted, not a caller reference', () => {
  const base = { contentRef: 'r', width: 1, height: 1, contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } } };
  // Plain nested JSON is admitted and returned as an independent snapshot.
  const src = { contentRef: 'r', width: 1, height: 1, contentBlock: { type: 't', nested: { v: 1 } } };
  const image = validateBrowserImage(src);
  src.contentBlock.nested.v = 999;
  assert.strictEqual(image.contentBlock.nested.v, 1);
  assert.notStrictEqual(image.contentBlock, src.contentBlock);
  assert.notStrictEqual(image.contentBlock.nested, src.contentBlock.nested);
  // Recursively reject non-JSON values, non-finite numbers, bigint, functions, symbols, cycles
  // and inappropriate prototypes — all with a stable NativeError code, never a raw TypeError.
  const rejectBlock = block => assert.throws(() => validateBrowserImage({ ...base, contentBlock: block }),
    err => err instanceof Error && err.code === 'invalid_browser_image' && !(err instanceof TypeError) && !(err instanceof RangeError));
  rejectBlock({ nested: { invalid: undefined } });
  rejectBlock({ ...base.contentBlock, callback() {} });
  rejectBlock({ ...base.contentBlock, method: function () {} });
  rejectBlock({ ...base.contentBlock, arrow: () => {} });
  rejectBlock({ ...base.contentBlock, s: Symbol('x') });
  rejectBlock({ ...base.contentBlock, b: BigInt(5) });
  rejectBlock({ ...base.contentBlock, n: Infinity });
  rejectBlock({ ...base.contentBlock, n: -Infinity });
  rejectBlock({ ...base.contentBlock, n: NaN });
  const cyclic = { type: 'image_url' }; cyclic.self = cyclic;
  rejectBlock(cyclic);
  rejectBlock(new Map());
  rejectBlock(new Set([1]));
  rejectBlock({ ...base.contentBlock, d: new Date() });
  // Top-level contentBlock must be a dict (object), not an array or scalar.
  rejectBlock(['not', 'a', 'dict']);
  rejectBlock('data:image/png;base64,QQ==');
  rejectBlock(null);
  // Nested arrays must be dense; sparse holes are rejected, not silently dropped to null.
  rejectBlock({ list: ['x', , 'y'] });
  rejectBlock({ list: [, 'y'] });
  // Nested arrays of plain JSON values are admitted.
  assert.deepStrictEqual(validateBrowserImage({ ...base, contentBlock: { list: [1, 'a', true, null, { k: [2, 3] }] } }).contentBlock.list,
    [1, 'a', true, null, { k: [2, 3] }]);
});

test('BrowserObservation rejects sparse arrays for logs and controls, not silently coercing holes', () => {
  const minimal = { sessionRef: ref(), actionId: 'a', actionSeq: 0, status: 'ok', complete: true, retryability: 'safe', viewport: [1, 1] };
  const ctrl = controlInput();
  // A sparse string list is not a valid tuple; Array#every would skip the hole, so each index is checked.
  rejects(() => validateBrowserObservation({ ...minimal, console: ['ok', ,] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...minimal, pageErrors: [, 'err'] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...minimal, pageErrorLocations: ['loc', ,] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...minimal, networkFailures: ['fail', ,] }), /invalid_browser_observation/);
  // A sparse controls tuple is rejected; Array#map would skip the hole and shrink the result.
  rejects(() => validateBrowserObservation({ ...minimal, controls: [ctrl, ,] }), /invalid_browser_observation/);
  rejects(() => validateBrowserObservation({ ...minimal, controls: [, ctrl] }), /invalid_browser_observation/);
  // Non-string entries are rejected (not coerced), and dense arrays are admitted and snapshotted.
  rejects(() => validateBrowserObservation({ ...minimal, console: ['a', 1] }), /invalid_browser_observation/);
  const dense = validateBrowserObservation({ ...minimal, console: ['a', 'b'], controls: [ctrl, { tag: 'input' }] });
  assert.deepStrictEqual(dense.console, ['a', 'b']);
  assert.strictEqual(dense.controls.length, 2);
  // The validated arrays are independent of the caller's arrays.
  const srcControls = [ctrl];
  const observed = validateBrowserObservation({ ...minimal, controls: srcControls });
  srcControls.push({ tag: 'injected' });
  assert.strictEqual(observed.controls.length, 1);
  // A sparse-nested array inside an image content block is also rejected (covered by the image test);
  // here the observation-level screenshot path is checked end to end.
  rejects(() => validateBrowserObservation({ ...minimal, screenshot: { contentRef: 'r', width: 1, height: 1, contentBlock: { list: ['x', ,] } } }), /invalid_browser_image/);
});

test('BrowserSessionError carries a stable code without page contents or diagnostics', () => {
  const error = new BrowserSessionError('network_denied');
  assert.ok(error instanceof Error);
  assert.strictEqual(error.code, 'network_denied');
  assert.strictEqual(error.message, 'network_denied');
  assert.strictEqual(error.name, 'BrowserSessionError');
});
test('image JSON preserves __proto__ data keys without changing the snapshot prototype', () => {
  const contentBlock = JSON.parse('{"__proto__":{"inherited":true},"nested":{"__proto__":"data"}}');
  const result = validateBrowserImage({ contentRef: 'host:png', width: 1, height: 1, contentBlock });
  assert.equal(Object.getPrototypeOf(result.contentBlock), Object.prototype);
  assert.equal(Object.hasOwn(result.contentBlock, '__proto__'), true);
  assert.equal(result.contentBlock.inherited, undefined);
  assert.deepEqual(result.contentBlock, contentBlock);
  result.contentBlock.__proto__.inherited = false;
  assert.equal(contentBlock.__proto__.inherited, true);
});
