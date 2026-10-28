/** Studio's public snake_case tool protocol, validated before opening any page. */
import { validateBrowserAction } from '@kingsoftcloud/agentkit-harness-core/browser-contract';

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const text = value => typeof value === 'string' && value.length > 0;
const allowed = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const target = ['selector', 'element_ref'];

export function browserInspectParameters({ maxActions = 20 } = {}) {
  const fields = { selector: { type: 'string', minLength: 1 }, element_ref: { type: 'string', minLength: 1, maxLength: 64 },
    value: { type: 'string' }, key: { type: 'string', minLength: 1 }, button: { enum: ['left', 'right', 'middle'] },
    duration_ms: { type: 'integer', minimum: 0, maximum: 5000 }, x: { type: 'integer', minimum: 0, maximum: 1279 },
    y: { type: 'integer', minimum: 0, maximum: 719 }, steps: { type: 'integer', minimum: 1, maximum: 30 },
    delta_x: { type: 'integer', minimum: -10000, maximum: 10000 }, delta_y: { type: 'integer', minimum: -10000, maximum: 10000 },
    ms: { type: 'integer', minimum: 0, maximum: 10000 } };
  const variant = (type, required = [], optional = []) => ({ type: 'object',
    properties: { type: { const: type }, ...Object.fromEntries([...required, ...optional].map(key => [key, fields[key]])) },
    required: ['type', ...required], additionalProperties: false,
    ...(['click', 'fill'].includes(type) ? { oneOf: target.map(key => ({ required: [key] })) }
      : type === 'press' ? { not: { required: target } } : {}),
    ...(type === 'scroll' ? { dependentRequired: { x: ['y'], y: ['x'] } } : {}) });
  return { type: 'object', properties: {
    path: { type: 'string', minLength: 1 }, screenshot_path: { type: 'string', minLength: 1 },
    wait_ms: { type: 'integer', minimum: 0, maximum: 30000 }, actions: { type: 'array', maxItems: maxActions, items: { oneOf: [
      variant('click', [], [...target, 'button', 'duration_ms']), variant('fill', ['value'], target),
      variant('press', ['key'], [...target, 'duration_ms']), variant('move', ['x', 'y'], ['steps']),
      variant('scroll', ['delta_x', 'delta_y'], ['x', 'y']), variant('reload'), variant('wait', [], ['ms']),
    ] } },
  }, required: ['path'], additionalProperties: false };
}

export function studioBrowserDefinition() {
  return { name: 'browser_inspect_workspace', description: 'Inspect and interact with a local HTML workspace page in a run-owned browser.',
    parameters: browserInspectParameters(), readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 110000,
    contextRole: 'none', observationRole: 'browser', progressObservation: true, contextRetention: 'normal' };
}

function relativePath(value, code) {
  if (!text(value) || value.startsWith('/') || value.includes('\\') || value.includes('\0')
    || value.split('/').includes('..')) fail(code);
  return value;
}

export function parseWorkspaceBrowserInput(value, operationKey, { maxActions = 20 } = {}) {
  if (!text(operationKey)) fail('browser_operation_key_invalid');
  if (!allowed(value, ['path', 'actions', 'wait_ms', 'screenshot_path']) || !Object.hasOwn(value, 'path')) fail('browser_input_invalid');
  const path = relativePath(value.path, 'workspace_path_invalid');
  const screenshotPath = relativePath(value.screenshot_path === undefined ? '.artifacts/browser-check.png' : value.screenshot_path, 'screenshot_path_invalid');
  if (!screenshotPath.toLowerCase().endsWith('.png')) fail('screenshot_path_invalid');
  const waitMs = value.wait_ms === undefined ? 1000 : value.wait_ms;
  if (!integer(waitMs, 0, 30000)) fail('browser_wait_invalid');
  const raw = value.actions === undefined ? [] : value.actions;
  if (!integer(maxActions, 1, 50) || !Array.isArray(raw) || raw.length > maxActions) fail('browser_actions_invalid');
  const actions = []; let explicitWait = waitMs;
  for (let index = 0; index < raw.length; index++) {
    if (!Object.hasOwn(raw, index)) fail('browser_action_invalid');
    const row = raw[index], type = row?.type;
    const keys = { click: ['type', ...target, 'button', 'duration_ms'], fill: ['type', ...target, 'value'],
      press: ['type', ...target, 'key', 'duration_ms'], move: ['type', 'x', 'y', 'steps'],
      scroll: ['type', 'delta_x', 'delta_y', 'x', 'y'], reload: ['type'], wait: ['type', 'ms'] };
    if (typeof type !== 'string' || !Object.hasOwn(keys, type) || !allowed(row, keys[type])) fail('browser_action_invalid');
    if (['click', 'fill', 'press'].includes(type)) {
      const supplied = target.filter(key => Object.hasOwn(row, key));
      if (supplied.length > 1 || type !== 'press' && supplied.length !== 1
        || supplied.some(key => !text(row[key])) || row.element_ref !== undefined && [...row.element_ref].length > 64) fail('browser_action_invalid');
    }
    if (type === 'fill' && typeof row.value !== 'string' || type === 'press' && !text(row.key)) fail('browser_action_invalid');
    if (type === 'move' && (!integer(row.x, 0, 1279) || !integer(row.y, 0, 719) || !integer(row.steps === undefined ? 1 : row.steps, 1, 30))) fail('browser_action_invalid');
    if (type === 'scroll' && (!integer(row.delta_x, -10000, 10000) || !integer(row.delta_y, -10000, 10000)
      || Object.hasOwn(row, 'x') !== Object.hasOwn(row, 'y')
      || row.x !== undefined && (!integer(row.x, 0, 1279) || !integer(row.y, 0, 719)))) fail('browser_action_invalid');
    if (Object.hasOwn(row, 'duration_ms')) {
      if (!integer(row.duration_ms, 0, 5000)) fail('browser_action_invalid');
      explicitWait += row.duration_ms;
    }
    if (type === 'wait') {
      const ms = row.ms === undefined ? 0 : row.ms;
      if (!integer(ms, 0, 10000)) fail('browser_action_invalid');
      explicitWait += ms; actions.push({ kind: 'wait', ms }); continue;
    }
    if (type === 'reload') { actions.push({ kind: 'reload' }); continue; }
    const action = { actionId: `${operationKey}:${index + 1}`, kind: type,
      timeoutMs: type === 'scroll' ? 20000 : 30000 };
    const mapping = { selector: 'selector', element_ref: 'elementRef', value: 'value', key: 'key', button: 'button',
      duration_ms: 'durationMs', x: 'x', y: 'y', steps: 'steps', delta_x: 'deltaX', delta_y: 'deltaY' };
    for (const [external, internal] of Object.entries(mapping)) if (Object.hasOwn(row, external)) action[internal] = row[external];
    if (type === 'press' && !target.some(key => Object.hasOwn(row, key))) action.selector = 'body';
    try { actions.push(validateBrowserAction(action)); } catch { fail('browser_action_invalid'); }
  }
  if (explicitWait > 30000) fail('browser_action_time_budget_exceeded');
  return { path, screenshotPath, waitMs, actions };
}
