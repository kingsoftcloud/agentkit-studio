/** Fault injection only: production Host, Kernel, tool dispatcher and Session remain intact. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { parseNativeJson } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { sessionKeyFor } from '../../packages/agentkit-harness/src/native/workspace-state.mjs';

export async function installWorkspaceRepairFault(ctx, options, agentRecord) {
  const origin = ctx.webServer.getOrigin();
  const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (login.status !== 302) throw Error('Workspace repair proof authentication failed');
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  writeFileSync(join(options.directory, 'mounted-host-connection.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
  const marker = join(options.directory, 'workspace-repair-crash.json');
  if (existsSync(marker)) return;
  let timer, stopping = false;
  ctx.effect(() => () => clearTimeout(timer), 'Workspace repair proof fault observer');
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id !== 'native-studio-session' || exec.name !== 'apply_workspace_patch') return next();
    const readState = join(options.directory, 'studio/native-harness/workspace-state',
      createHash('sha256').update(agentRecord.metadata.id).digest('hex'), sessionKeyFor(exec.agent.session.id), 'read-state.json');
    // The first real file publication succeeds; persisting its read-state then fails.
    // No replacement tool, forged tool result or patched production kernel is used.
    mkdirSync(readState, { recursive: true });
    const observe = async () => {
      if (stopping) return;
      try {
        const session = exec.agent.session;
        const owner = session.snapshotEvents().findLast(event => event.type === 'turn/owner');
        if (owner) {
          const admission = parseNativeJson(owner.data.binding);
          const store = new SqliteRunStore(join(options.directory, 'studio/native-harness/runs.sqlite'));
          let record;
          try { record = store.load(admission.identity.scope, admission.identity.runId); } finally { store.close(); }
          if (record.snapshot.phase === 'awaiting_reconciliation') {
            stopping = true;
            if (await ctx.sessions.flush(session) !== true) throw Error('Workspace repair crash Session was not durable');
            writeFileSync(marker, JSON.stringify({ pid: process.pid, readState, admission, record, events: session.snapshotEvents() }));
            const fd = openSync(marker, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
            process.kill(process.pid, 'SIGSTOP'); // Parent confirms the live PID and sends SIGKILL.
            return;
          }
        }
        timer = setTimeout(observe, 20);
      } catch (error) {
        writeFileSync(join(options.directory, 'workspace-repair-fault-error.json'), JSON.stringify({ message: error.message, stack: error.stack }));
      }
    };
    timer = setTimeout(observe, 20);
    return next();
  });
}
