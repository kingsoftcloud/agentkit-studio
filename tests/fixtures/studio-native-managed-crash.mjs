/** Fault injection only: wraps actual public SDK methods, never replaces the
 * Native binding, execution loop, tools, persistence or recovery policy. */
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installManagedNativeCrashFaults(ctx, { root, sessionId, boundary }) {
  const checkpoint = join(root, 'managed-crash-checkpoint.json');
  const engine = 'agentkit.native-managed-dsh-turn/v1';
  const selected = session => session.id === sessionId;
  const record = (session, extra = {}) => {
    assert.equal(existsSync(checkpoint), false);
    const fd = openSync(checkpoint, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ boundary, pid: process.pid, sessionId, history: session.snapshotEvents(), ...extra })); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  const hold = (session, extra) => {
    record(session, extra);
    // A second asynchronous flush must not advance execution after the marker.
    // Freeze the actual event loop at the exact boundary until the parent kills.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000);
    throw new Error('Verifier failed to SIGKILL the stopped Host');
  };
  const active = session => selected(session) && !existsSync(checkpoint);
  ctx.on('agent/created', ({ agent }) => {
    if (!selected(agent.session)) return;
    if (boundary === 'before-owner') {
      const start = agent.externalTurns.start.bind(agent.externalTurns);
      agent.externalTurns.start = (prepare, execute) => start(async payload => {
        const owner = await prepare(payload);
        if (active(agent.session)) {
          assert.equal(await ctx.get('sessions').flush(agent.session), true);
          await hold(agent.session, { owner, durable: true });
        }
        return owner;
      }, execute);
    }
    if (boundary === 'before-turn-end') {
      const append = agent.session.append.bind(agent.session);
      agent.session.append = (type, data, options) => {
        if (active(agent.session) && type === 'turn/end'
          && agent.session.snapshotEvents().some(event => event.type === 'turn/owner' && event.data.engine === engine)) {
          record(agent.session, { ending: data });
          // append is synchronous; freeze precisely before the real append.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000);
          throw new Error('Verifier failed to SIGKILL before turn/end');
        }
        return append(type, data, options);
      };
    }
  });
  const sessions = ctx.get('sessions'), flush = sessions.flush.bind(sessions);
  sessions.flush = async session => {
    const durable = await flush(session);
    if (durable === true && active(session)) {
      const events = session.snapshotEvents();
      const owner = events.find(event => event.type === 'turn/owner' && event.data.engine === engine);
      const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
      const ended = events.some(event => event.type === 'turn/end' && event.data.turn === owner?.data.turn);
      if (owner && (boundary === 'after-owner-flush' && !user
        || boundary === 'after-input-flush' && user || boundary === 'after-terminal-flush' && ended))
        await hold(session, { durable: true });
    }
    return durable;
  };
  const tools = ctx.get('tools'), execute = tools.execute.bind(tools);
  tools.execute = async request => {
    if (selected(request.agent.session) && request.name === 'write_workspace_file')
      // Count dispatches across PIDs, including a mistakenly repeated same-byte write.
      appendFileSync(join(root, 'managed-tool-dispatches.jsonl'), JSON.stringify({ pid: process.pid, callId: request.callId }) + '\n');
    const result = await execute(request);
    if (boundary === 'after-tool-effect' && active(request.agent.session) && request.name === 'write_workspace_file') {
      assert.equal(result.isError, false);
      await hold(request.agent.session, { tool: { callId: request.callId, name: request.name } });
    }
    return result;
  };
  ctx.effect(() => () => { sessions.flush = flush; tools.execute = execute; }, 'managed crash verifier wrappers');
}
