import { createDshNodeCommandTools } from '../../src/providers/dsh-node-command-tools.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandStateRoot, DshNodeCommandLedger } from '../../src/providers/dsh-node-command-ledger.mjs';
const [workspaceRoot, stateDir, mode] = process.argv.slice(2);
if (mode === 'before') {
  const state = commandStateRoot(stateDir, workspaceRoot, 'bound-agent');
  const ledger = new DshNodeCommandLedger({ root: state.root, agentId: 'bound-agent', sessionId: 'session', assertRoot: state.guard });
  const signal = new AbortController().signal;
  await ledger.execute({ request: { agentId: 'bound-agent', sessionId: 'session',
    call: { callId: 'pending', name: 'run_command', arguments: { command: 'echo once' } }, operationKey: 'owned-key', signal },
    binding: { digest: 'fixed' }, taskId: 'a'.repeat(64),
    assertCurrent: () => { state.guard(); signal.throwIfAborted(); return true; },
    dispatch: async () => {
      writeFileSync(join(workspaceRoot, 'before-ready'), String(process.pid));
      // This process has committed the production intent but not performed an
      // external command. Keep the real owner lock until the test kills it.
      await new Promise(resolve => setInterval(resolve, 60000));
      writeFileSync(join(workspaceRoot, 'forbidden'), 'must not execute');
    } });
  process.exit(0);
}
const args = { command: mode === 'after'
  ? 'printf x >> counter; printf ready > ready; sleep 1; printf done'
  : 'printf x >> counter; printf done' };
const port = createDshNodeCommandTools({ workspaceRoot, stateDir, agentId: 'bound-agent', settings: { wallSeconds: 5 },
  env: { PATH: '/bin:/usr/bin', KSADK_PYTHON: '/python-unavailable' },
  ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
const exec = { agent: { session: { id: 'session' } }, name: 'run_command', callId: 'crash-call', arguments: args,
  signal: new AbortController().signal };
await port.execute('run_command', args, exec);
port.close();
