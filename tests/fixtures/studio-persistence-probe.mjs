/** Loader fixture exercising actual Session persistence and installed Studio resource producers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence';

export const name = 'studio-persistence-probe';
export const inject = ['sessions', 'sessionPersistence'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function stored(ctx, id, work) {
  const reader = await ctx.sessionPersistence.open(SessionId(id), 'read');
  try { return await work(reader, await reader.read()); }
  finally { await reader.close(); }
}

async function useResource(session, spec) {
  const load = file => import(pathToFileURL(join(spec.studio, file)).href);
  const { checkedResource } = await load('packages/agentkit-harness/src/resource-checks.mjs');
  const { createLocalResourceAdapters } = await load('src/local-resource-adapters.mjs');
  const adapter = createLocalResourceAdapters({ serverClient: { async skillAction(action, params) {
    const response = await fetch(spec.resourceOrigin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, params }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Object.assign(new Error('Controlled Skill Service request failed'), { code: 'SKILL_SERVICE_FAILED', status: response.status });
    return response.json();
  } } });
  try {
    const work = () => checkedResource({ kind: 'skill-space', resourceId: spec.resourceId, action: 'load', agent: { session } }, () => adapter.loadSkill(spec.resourceId));
    if (spec.phase === 'create') await assert.rejects(work, { code: 'SKILL_SPACE_NOT_FOUND' });
    else assert.equal((await work()).content, '');
  } finally { await adapter.close(); }
}

/** Run once per fresh Host process; the parent owns the isolated profile and input file. */
async function verify(ctx, spec) {
  const id = SessionId('studio-persistence-proof');
  if (spec.phase === 'create') {
    const session = ctx.sessions.prepare(id);
    const writer = await ctx.sessionPersistence.create(session.header);
    ctx.effect(() => ctx.sessions.enter(session));
    ctx.sessions.announce(session);
    try {
      session.append('turn/start', { turn: 1 });
      session.append('user/message', { id: 'persistence-user', role: 'user', content: [{ type: 'text', text: 'Preserve this fixture message.' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
      await useResource(session, spec);
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await ctx.sessions.flush(session);
    } finally { await writer.close(); }
  } else if (spec.phase === 'resume') {
    const writer = await ctx.sessionPersistence.open(id, 'write');
    try {
      const read = await writer.read();
      assert.equal(digest(read.events), spec.expected.eventSha256);
      const session = Session.fromRestore(id, read.events, writer.header, writer.inheritedEventCount, read.eventState);
      // Restore adds its lifecycle marker before publication, as in agent-loop.
      await writer.append(session.snapshotEvents(read.events.length));
      ctx.effect(() => ctx.sessions.enter(session));
      ctx.sessions.announce(session);
      await useResource(session, spec);
      await ctx.sessions.flush(session);
    } finally { await writer.close(); }
  }
  const result = await stored(ctx, id, (reader, read) => {
    const session = Session.fromRestore(id, read.events, reader.header, reader.inheritedEventCount, read.eventState);
    const checks = read.events.filter(event => event.type === 'studio/resource-check');
    assert.equal(checks.length, spec.phase === 'resume' || spec.expected?.resourceChecks === 2 ? 2 : 1);
    assert.ok(checks.every(event => event.ignorable === true));
    assert.equal(checks[0].data.code, 'SKILL_SPACE_NOT_FOUND');
    if (checks.length === 2) assert.equal(checks[1].data.status, 'succeeded');
    const messages = session.deriveMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const snapshot = { events: read.events.length, eventSha256: digest(read.events), modelSha256: digest(messages), resourceChecks: checks.length };
    if (spec.expected) {
      assert.equal(snapshot.modelSha256, spec.expected.modelSha256);
      if (spec.phase !== 'resume') assert.equal(snapshot.eventSha256, spec.expected.eventSha256);
    }
    return snapshot;
  });
  await stored(ctx, 'studio-legacy-proof', (reader, read) => {
    const session = Session.fromRestore(SessionId('studio-legacy-proof'), read.events, reader.header, reader.inheritedEventCount, read.eventState);
    assert.equal(session.deriveMessages().length, 1);
    assert.equal(read.events.length, 3);
  });
  await assert.rejects(() => stored(ctx, 'studio-required-proof', () => assert.fail('Unknown required event must not be adopted')), error => error instanceof SessionFormatUnsupportedError);
  return { ...result, legacyReopened: true, requiredUnknownRefused: true, passed: true };
}

/** Publish a content-free result after the Loader-owned persistence proof settles. */
export async function apply(ctx) {
  const spec = JSON.parse(await readFile(process.env.STUDIO_PERSISTENCE_PROBE_INPUT, 'utf8'));
  try { await writeFile(spec.output, JSON.stringify(await verify(ctx, spec)) + '\n'); }
  catch (error) {
    await writeFile(spec.output, JSON.stringify({ passed: false, code: error.code, name: error.name, message: String(error.message).split('\n')[0].slice(0, 200) }) + '\n');
    throw error;
  }
}
