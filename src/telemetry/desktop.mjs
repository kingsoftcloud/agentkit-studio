import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  calendarDay, desktopTelemetryExample, eventCategory, isEventId, maxBatchRecords, maxBodyBytes, replayAgeMs, schemaVersion,
  telemetryBatch, telemetryCategories, telemetryEndpoint, validEvent, validEventProps,
} from './contract.mjs';

const maxQueueRecords = 2048;
const maxQueueBytes = 5 * 1024 * 1024;
const normalDelay = 30_000;
const retryStatuses = new Set([429, 502, 503, 504]);
const blankChoices = () => ({ basic: null, crash: null, run: null });
const blankDiagnostics = () => ({ send_failed: 0, queue_drop: 0, rejected: 0, storage: 0, export: 0 });
const digest = value => createHash('sha256').update(value).digest('hex');
const newState = () => ({
  version: 1, receiver: '', policy: '', notice: false, choices: blankChoices(),
  installId: null, firstOpen: false, lastDay: null, launch: null, update: null, finishedRuns: {}, retryAt: 0,
});

/** Apply release defaults only to packaged builds with a first-party policy. */
export function resolveDesktopTelemetryConfig({ release, selfHosted, disabled, packaged }) {
  const endpoint = telemetryEndpoint(selfHosted || release?.endpoint);
  const overridden = Boolean(selfHosted);
  const defaultEnabled = Boolean(endpoint && packaged && !overridden
    && typeof release?.policyRevision === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(release.policyRevision));
  return {
    endpoint,
    disabled: Boolean(disabled) || release?.buildOff === true,
    defaultEnabled,
    defaultBasic: defaultEnabled && release.defaultBasic === true,
    selfHosted: overridden,
    noticeVersion: typeof release?.policyRevision === 'string' ? release.policyRevision.slice(0, 64) : '1',
  };
}

async function loadJournal(path, now) {
  try {
    if ((await stat(path)).size > maxQueueBytes + 512 * 1024) return undefined;
    const input = await readFile(path, 'utf8');
    const lines = input.slice(0, input.lastIndexOf('\n')).split('\n');
    const state = JSON.parse(lines.shift());
    if (state?.version !== 1 || !state.choices || typeof state.policy !== 'string') return undefined;
    const queued = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (validEvent(event) && event.install_id === state.installId && event.occurred_at >= now - replayAgeMs) queued.push(event);
      } catch { /* A malformed record is never forwarded. */ }
    }
    return { state, queued };
  } catch (error) {
    // An unreadable journal may contain opt-outs. Only a missing file is a fresh install.
    return error.code === 'ENOENT' ? null : undefined;
  }
}

async function replaceJournal(directory, path, data) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `outbox-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function retryDelay(response, now, attempt, random) {
  const retryAfter = response?.headers.get('retry-after');
  const parsed = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  const interval = Math.min(15 * 60_000, 5000 * (2 ** Math.min(attempt, 8)));
  return Math.max(Number.isFinite(parsed) ? Math.min(parsed, replayAgeMs) : 0, Math.round(interval * (0.8 + random() * 0.2)));
}

async function readAcknowledgment(response, expected) {
  if (!response.body) return null;
  const cursor = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await cursor.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32 * 1024) return null;
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'partialSuccess')) return null;
    const partial = body.partialSuccess;
    const rejected = partial?.rejectedLogRecords;
    if (partial !== undefined && (partial === null || typeof partial !== 'object' || Array.isArray(partial))) return null;
    if (rejected === undefined) return 0;
    return /^(?:0|[1-9][0-9]*)$/.test(String(rejected)) && Number(rejected) <= expected ? Number(rejected) : null;
  } catch { return null; }
  finally { await cursor.cancel().catch(() => {}); }
}

class DesktopTelemetry {
  constructor(options) {
    this.directory = options.directory;
    this.path = join(this.directory, 'outbox.jsonl');
    this.config = options.config;
    this.dimensions = options.dimensions;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.batchDelay = options.batchDelay ?? normalDelay;
    this.onDiagnostic = options.onDiagnostic;
    this.diagnostics = blankDiagnostics();
    this.state = newState();
    this.queue = [];
    this.writes = Promise.resolve();
    this.pendingRuns = new Map();
    this.revision = this.persisted = this.retryCount = this.retryAt = 0;
  }

  get available() { return Boolean(this.config.endpoint) && !this.config.disabled; }

  enabled(category) {
    const choice = this.state.choices[category];
    return this.available && this.state.notice && (choice ?? (category === 'basic' && this.config.defaultBasic)) === true;
  }

  status() {
    return {
      available: this.available, endpoint: this.config.endpoint, noticePending: this.available && !this.state.notice,
      defaultBasic: this.config.defaultBasic, selfHosted: this.config.selfHosted,
      enabled: Object.fromEntries(telemetryCategories.map(key => [key, this.enabled(key)])),
      installId: this.state.installId, queued: this.queue.length, diagnostics: { ...this.diagnostics },
    };
  }

  report(reason, count = 1) {
    this.diagnostics[reason] = Math.min(Number.MAX_SAFE_INTEGER, this.diagnostics[reason] + count);
    this.onDiagnostic?.(reason, count);
  }

  async load() {
    const saved = await loadJournal(this.path, this.now());
    const receiver = this.config.endpoint ? digest(this.config.endpoint) : '';
    const policy = digest(JSON.stringify([receiver, this.config.defaultBasic, this.config.noticeVersion]));
    if (saved?.state.policy === policy && saved.state.receiver === receiver) {
      this.state = { ...newState(), ...saved.state, installId: isEventId(saved.state.installId) ? saved.state.installId : null };
      this.state.choices = Object.fromEntries(telemetryCategories.map(key => [key,
        typeof saved.state.choices[key] === 'boolean' ? saved.state.choices[key] : null]));
      if (!this.state.finishedRuns || Object.getPrototypeOf(this.state.finishedRuns) !== Object.prototype) this.state.finishedRuns = {};
      this.queue = saved.queued.filter(event => this.enabled(eventCategory(event.event_name)));
      this.retryAt = this.queue.length && Number.isSafeInteger(this.state.retryAt)
        ? Math.min(this.state.retryAt, this.now() + replayAgeMs) : 0;
      if (!this.available) {
        this.state.launch = this.state.update = null;
        this.state.finishedRuns = {};
      }
    } else if (saved) {
      if (saved.state.receiver === receiver && isEventId(saved.state.installId)) {
        this.state.installId = saved.state.installId;
        this.state.firstOpen = saved.state.firstOpen === true;
        this.state.lastDay = saved.state.lastDay;
      }
      for (const key of telemetryCategories) if (saved.state.choices[key] === false) this.state.choices[key] = false;
    }
    this.state.receiver = receiver;
    this.state.policy = policy;
    this.firstQueuedAt = this.queue[0]?.occurred_at ?? 0;
    if (saved === null && this.available && this.config.defaultEnabled) {
      this.state.notice = true;
      this.state.choices = { basic: true, crash: true, run: true };
      this.ensureId();
      try { await this.save(); }
      catch {
        this.state.notice = false;
        this.state.choices = blankChoices();
        this.state.installId = null;
      }
    } else if (saved) {
      await this.save().catch(() => {});
    }
    this.schedule();
  }

  save() {
    this.state.retryAt = this.retryAt;
    const revision = ++this.revision;
    const snapshot = [JSON.stringify(this.state), ...this.queue.map(event => JSON.stringify(event)), ''].join('\n');
    const writing = this.writes.then(async () => {
      await replaceJournal(this.directory, this.path, snapshot);
      this.persisted = revision;
    });
    this.writes = writing.catch(() => this.report('storage'));
    void writing.then(() => this.schedule(), () => {});
    return writing;
  }

  ensureId() {
    if (!this.state.installId && telemetryCategories.some(key => this.enabled(key))) this.state.installId = randomUUID();
  }

  async setPreference(category, enabled) {
    if (!this.available || !telemetryCategories.includes(category) || typeof enabled !== 'boolean') return this.status();
    if (!this.state.notice) {
      if (!enabled) return this.status();
      // A first opt-in applies only to the category the user enabled.
      this.state.choices.basic = false;
      this.state.notice = true;
    }
    this.state.choices[category] = enabled;
    if (!enabled) this.discard([category]);
    this.ensureId();
    await this.save();
    return this.status();
  }

  discard(categories) {
    this.flight?.controller.abort();
    this.queue = this.queue.filter(event => !categories.includes(eventCategory(event.event_name)));
    clearTimeout(this.timer);
    this.timer = undefined;
    this.retryAt = this.retryCount = this.firstQueuedAt = 0;
    if (categories.includes('basic')) this.state.launch = this.state.update = null;
    if (categories.includes('run')) {
      this.pendingRuns.clear();
      this.state.finishedRuns = {};
    }
  }

  async stopAll({ clear = false } = {}) {
    this.discard(telemetryCategories);
    this.state.choices = { basic: false, crash: false, run: false };
    if (clear) {
      this.state.installId = this.state.lastDay = null;
      this.state.firstOpen = false;
      this.diagnostics = blankDiagnostics();
    }
    await this.save();
    return this.status();
  }

  enqueue(name, props) {
    if (!this.enabled(eventCategory(name)) || this.closed || !this.state.installId) return false;
    const occurredAt = this.now();
    const event = { event_id: randomUUID(), event_name: name, schema_version: schemaVersion,
      occurred_at: occurredAt, install_id: this.state.installId, ...this.dimensions, props };
    if (!validEvent(event)) return false;
    this.firstQueuedAt ||= occurredAt;
    this.queue.push(event);
    this.trimQueue();
    return true;
  }

  trimQueue() {
    const previous = this.queue.length;
    const minimum = this.now() - replayAgeMs;
    this.queue = this.queue.filter(event => event.occurred_at >= minimum).slice(-maxQueueRecords);
    let bytes = 0;
    let index = this.queue.length;
    while (index > 0) {
      bytes += Buffer.byteLength(JSON.stringify(this.queue[index - 1])) + 1;
      if (bytes > maxQueueBytes) break;
      index -= 1;
    }
    if (index > 0) this.queue = this.queue.slice(index);
    if (this.queue.length < previous) this.report('queue_drop', previous - this.queue.length);
  }

  track(name, props) {
    if (this.enqueue(name, props)) void this.save().catch(() => {});
  }

  activity() {
    if (!this.enabled('basic')) return;
    const day = calendarDay(this.now());
    if (this.state.lastDay && this.state.lastDay >= day) return;
    if (!this.state.firstOpen) this.state.firstOpen = this.enqueue('app_install', {});
    if (this.enqueue('desktop_active_day', {})) {
      this.state.lastDay = day;
      void this.save().catch(() => {});
    }
  }

  beginLaunch() {
    if (!this.enabled('basic')) return;
    if (isEventId(this.state.launch)) this.enqueue('app_launch_result', { attempt_id: this.state.launch, outcome: 'unknown' });
    const attemptId = randomUUID();
    if (this.enqueue('app_launch_started', { attempt_id: attemptId })) {
      this.state.launch = attemptId;
      void this.save().catch(() => {});
    }
  }

  finishLaunch(outcome, duration) {
    const attemptId = this.state.launch;
    if (!isEventId(attemptId)) return;
    const props = { attempt_id: attemptId, outcome, ...(duration === undefined ? {} : { duration_ms: duration }) };
    if (this.enqueue('app_launch_result', props)) {
      this.state.launch = null;
      void this.save().catch(() => {});
    }
  }

  async startUpdate(targetVersion) {
    const attemptId = randomUUID();
    if (this.enqueue('update_install_started', { attempt_id: attemptId, target_version: targetVersion })) {
      this.state.update = { attemptId, version: targetVersion, time: this.now() };
      await this.save();
    }
  }

  finishUpdate(outcome) {
    const update = this.state.update;
    if (!update || this.now() - update.time > replayAgeMs) return;
    if (outcome === 'applied' && update.version !== this.dimensions.app_version) return;
    if (this.enqueue('update_install_result', { attempt_id: update.attemptId, outcome })) {
      this.state.update = null;
      void this.save().catch(() => {});
    }
  }

  localRun({ kind, id, engine, props }) {
    if (!this.enabled('run') || typeof id !== 'string' || !id.length || id.length > 512
      || !['studio-local', 'codex', 'native-harness'].includes(engine)) return;
    const key = digest(JSON.stringify([engine, id]));
    const cutoff = this.now() - replayAgeMs;
    if (kind === 'start') {
      if (this.pendingRuns.size >= maxQueueRecords) this.pendingRuns.delete(this.pendingRuns.keys().next().value);
      this.pendingRuns.set(key, this.now());
    } else if (kind === 'finish' && this.pendingRuns.delete(key) && (this.state.finishedRuns[key] ?? 0) < cutoff
      && validEventProps('run_summary', props) && props.engine === engine && this.enqueue('run_summary', props)) {
      const recent = Object.entries(this.state.finishedRuns).filter(([, value]) => value >= cutoff);
      this.state.finishedRuns = Object.fromEntries(recent.slice(-(maxQueueRecords - 1)));
      this.state.finishedRuns[key] = this.now();
      void this.save().catch(() => {});
    }
  }

  nextBatch() {
    return telemetryBatch(this.queue.filter(event => this.enabled(eventCategory(event.event_name))
      && event.occurred_at >= this.now() - replayAgeMs));
  }

  preview(mode) { return mode === 'example' ? desktopTelemetryExample : this.nextBatch().body; }

  schedule() {
    if (this.closed || this.draining || this.flight || !this.queue.length || !this.available || this.persisted !== this.revision) return;
    const now = this.now();
    this.firstQueuedAt ||= now;
    const batch = this.nextBatch();
    const full = this.queue.length >= maxBatchRecords || this.queue.length > batch.count || Buffer.byteLength(batch.body) >= maxBodyBytes;
    const due = Math.max(this.retryAt, full ? now : this.firstQueuedAt + this.batchDelay);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, Math.max(0, due - now));
    this.timer.unref();
  }

  flush() {
    if (this.flight) return this.flight.promise;
    if (this.closed || !this.available || this.persisted !== this.revision || this.now() < this.retryAt) return Promise.resolve();
    const count = this.queue.length;
    this.trimQueue();
    if (count !== this.queue.length) {
      void this.save().catch(() => {});
      return Promise.resolve();
    }
    const events = this.queue.filter(event => this.enabled(eventCategory(event.event_name)));
    const batch = telemetryBatch(events);
    if (!batch.count) return Promise.resolve();
    const flight = { controller: new AbortController() };
    this.flight = flight;
    flight.promise = this.send(flight.controller, batch, events.slice(0, batch.count))
      .catch(() => this.report('export'))
      .finally(() => { this.flight = undefined; this.schedule(); });
    return flight.promise;
  }

  async send(controller, batch, events) {
    const deadline = setTimeout(() => controller.abort('timeout'), 15_000);
    deadline.unref();
    let response;
    let rejected = null;
    try {
      response = await this.fetch(this.config.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'content-type': 'application/json' }, body: batch.body, signal: controller.signal });
      if (response.status === 200) rejected = await readAcknowledgment(response, batch.count);
      else await response.body?.cancel();
    } catch { /* An unavailable collector leaves the batch on disk. */ }
    finally { clearTimeout(deadline); }
    if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
    if (rejected !== null || (response && response.status >= 400 && !retryStatuses.has(response.status))) {
      if (rejected === null || rejected > 0) this.report('rejected', rejected ?? batch.count);
      const ids = new Set(events.map(event => event.event_id));
      this.queue = this.queue.filter(event => !ids.has(event.event_id));
      this.retryAt = this.retryCount = 0;
      this.firstQueuedAt = this.queue.length ? Math.min(this.firstQueuedAt, this.now()) : 0;
      await this.save();
    } else {
      this.report('send_failed');
      this.retryAt = this.now() + retryDelay(response, this.now(), this.retryCount++, this.random);
      await this.save();
    }
  }

  async drain() {
    clearTimeout(this.timer);
    this.draining = true;
    let timer;
    try {
      await Promise.race([
        this.writes.then(() => this.flush()),
        new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
      ]);
    } finally {
      clearTimeout(timer);
      this.closed = true;
      this.flight?.controller.abort();
    }
  }
}

export async function createDesktopTelemetry(options) {
  const service = new DesktopTelemetry(options);
  await service.load();
  return service;
}
