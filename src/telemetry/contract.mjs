import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('./schema-v1.json', import.meta.url), 'utf8'));
export const schemaVersion = schema.version;
export const maxBatchRecords = schema.maxBatchRecords;
export const maxBodyBytes = schema.maxBodyBytes;
export const telemetryCategories = Object.freeze(['basic', 'crash', 'run']);
export const replayAgeMs = 7 * 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const version = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/;
const usageKeys = ['input_tokens', 'output_tokens', 'total_tokens'];
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const isRecord = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

export function eventCategory(name) {
  return Object.hasOwn(schema.events, name) ? schema.events[name].category : undefined;
}

export function calendarDay(time) {
  return dayFormat.format(time);
}

export function telemetryEndpoint(input) {
  if (typeof input !== 'string' || input.length > 512 || /[?#]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && url.pathname === '/v1/logs' && !url.username && !url.password) return url.href;
  } catch { /* Configuration may be absent or invalid. */ }
  return null;
}

function matches(rule, value) {
  if (Array.isArray(rule)) return rule.includes(value);
  switch (rule) {
    case 'uuid': return typeof value === 'string' && uuid.test(value);
    case 'event': return typeof value === 'string' && Boolean(eventCategory(value));
    case 'version': return typeof value === 'string' && value.length <= 64 && version.test(value);
    case 'schemaVersion': return value === schemaVersion;
    case 'time':
    case 'count': return Number.isSafeInteger(value) && value >= 0;
    case 'duration': return Number.isSafeInteger(value) && value >= 0 && value <= replayAgeMs;
    default: return Object.hasOwn(schema.enums, rule) && schema.enums[rule].includes(value);
  }
}

export function knownRunError(value) {
  return matches('runError', value) ? value : 'OTHER';
}

export function isEventId(value) {
  return matches('uuid', value);
}

function fieldsMatch(fields, required, optional) {
  return isRecord(fields)
    && Object.entries(required).every(([key, rule]) => Object.hasOwn(fields, key) && matches(rule, fields[key]))
    && Object.entries(fields).every(([key, value]) =>
      Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && matches(optional[key], value)));
}

export function validEventProps(name, props) {
  if (!eventCategory(name)) return false;
  const { required = {}, optional = {} } = schema.events[name];
  if (!fieldsMatch(props, required, optional)) return false;
  if (name === 'app_launch_result' && props.outcome === 'ready') return Object.hasOwn(props, 'duration_ms');
  if (name !== 'run_summary') return true;
  const usageFields = usageKeys.filter(key => Object.hasOwn(props, key)).length;
  if (usageFields && (usageFields !== usageKeys.length || props.total_tokens !== props.input_tokens + props.output_tokens)) return false;
  return !Object.hasOwn(props, 'error_code') || ['failed', 'interrupted'].includes(props.status);
}

export function validEvent(event) {
  if (!isRecord(event)) return false;
  const { props, ...envelope } = event;
  return fieldsMatch(envelope, schema.envelope, {}) && validEventProps(envelope.event_name, props);
}

function attribute(key, value) {
  return { key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } };
}

function logRecord(event) {
  const { event_name, occurred_at, props, ...attributes } = event;
  return JSON.stringify({
    timeUnixNano: String(BigInt(occurred_at) * 1000000n),
    body: { stringValue: event_name },
    attributes: [
      ...Object.entries(attributes).map(([key, value]) => attribute(key, value)),
      ...Object.entries(props).map(([key, value]) => attribute(`props.${key}`, value)),
    ],
  });
}

const frame = JSON.stringify({ resourceLogs: [{
  resource: { attributes: [attribute('service.name', schema.service)] },
  scopeLogs: [{ scope: { name: schema.scope }, logRecords: [] }],
}] });
const listStart = frame.indexOf('[]');
const prefix = frame.slice(0, listStart + 1);
const suffix = frame.slice(listStart + 1);

/** Produce the next ordered batch from validated records. Used by preview and transport. */
export function telemetryBatch(events) {
  const records = [];
  let size = Buffer.byteLength(frame);
  for (const event of events) {
    if (records.length === maxBatchRecords) break;
    const record = logRecord(event);
    size += Buffer.byteLength(record) + (records.length ? 1 : 0);
    if (size > maxBodyBytes) break;
    records.push(record);
  }
  return { body: prefix + records.join(',') + suffix, count: records.length };
}
