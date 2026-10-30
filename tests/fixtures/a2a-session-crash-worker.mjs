// Actual independent process and maintained Session implementation. The only
// persistence double is an explicitly fsynced file carrier with fault gates.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { createStudioA2aSessionSink, A2A_SESSION_CONTRACT } from '../../src/host/services/a2a-session-events.mjs';
import { prepareNativeA2AHost, prepareDshA2AHost } from '../../src/providers/native-a2a-host.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { spec, scope } from './native-a2a-internal-peer.mjs';

process.once('message', async input => {
  let ctx, sink, factory;
  try {
    const require = createRequire(join(input.source, 'packages/core/session/package.json'));
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const { default: Store } = await import(pathToFileURL(join(input.source, 'packages/core/session/lib/index.js')).href);
    const { default: Projections } = await import(pathToFileURL(join(input.source, 'packages/session/session-projection/lib/index.js')).href);
    const { agentPresetProjectionDefinition } = await import(pathToFileURL(join(input.source, 'packages/preset/agent-preset-registry/lib/index.js')).href);
    ctx = new Context(); await ctx.plugin(Store); await ctx.plugin(Projections);
    ctx.sessionProjections.register(agentPresetProjectionDefinition);
    ctx.sessionProjections.register({ key: 'verificationLog', stateVersion: 1, init: () => [],
      apply: (state, event) => [...state, event], stateSchema: { parse: value => value } });
    const path = join(input.root, 'session-durable.json'), previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const session = ctx.sessions.create('session', previous ? { seed: previous.events, eventState: 'detached',
      meta: previous.header, inheritedEventCount: 0 } : { meta: { agentPreset: dshPresetId('agent', 1) } });
    const log = () => ctx.sessionProjections.stateOf(session, 'verificationLog');
    const hold = () => { process.send({ type: 'boundary', boundary: input.boundary, pid: process.pid }); return new Promise(() => {}); };
    ctx.on('session/flush', () => {
      if (input.action === 'dispatch' && input.boundary === 'before-flush') return hold();
      const temporary = path + '.' + process.pid;
      writeFileSync(temporary, JSON.stringify({ header: session.header, events: log() }), { mode: 0o600 });
      const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path); const directory = openSync(input.root, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      if (input.action === 'dispatch' && input.boundary === 'after-flush') return hold();
    });
    sink = createStudioA2aSessionSink({ ctx }); const writer = sink.forPreset({ agentId: 'agent' });
    let available = input.action !== 'dispatch';
    factory = (input.dsh ? prepareDshA2AHost : prepareNativeA2AHost)({ env: input.env, bindings: [spec],
      sessionEvents: { contract: A2A_SESSION_CONTRACT, write(args) {
        if (!available) throw new Error('delivery intentionally deferred until original task completes');
        return writer.write(args);
      } } });
    const fields = input.dsh ? { agentId: 'agent', agentRevision: 1, buildId: null } : { scope };
    const admission = { ...fields, sessionId: 'session', destinationSessionId: 'session', workspaceRoot: input.workspaceRoot,
      stateRoot: join(input.root, 'state'), assertCurrent: () => true };
    let restored = 0;
    if (input.action !== 'dispatch') restored = factory.restoreEvents({ stateRoot: admission.stateRoot, workspaceRoot: input.workspaceRoot });
    const port = factory.forSession(admission), signal = new AbortController().signal;
    if (input.action === 'dispatch') {
      const request = await port.invocation.resolve({ agent: 'research', message: 'hello', signal,
        [input.dsh ? 'dshRequest' : 'nativeRequest']: { ...fields, sessionId: 'session', ...(input.dsh ? {} : { runId: 'run' }),
          operationKey: 'operation', call: { callId: 'call' } } });
      const result = await port.invocation.dispatch({ request, signal });
      if (result.state !== 'completed') throw new Error('original dispatch failed');
      await port.eventDelivery.flush(); available = true;
    }
    const receipt = await port.eventDelivery.flushSession();
    process.send({ type: 'restored', pid: process.pid, restored, receipt, events: log() });
  } catch (error) {
    process.send({ type: 'error', code: error.code, message: error.message, stack: error.stack }); process.exitCode = 1;
  } finally {
    await factory?.close(); await sink?.close(); await ctx?.fiber.dispose(); process.disconnect();
  }
});
