import { createDshNodeA2aTools } from '../../src/providers/dsh-node-a2a-tools.mjs';
process.once('message', async ({ args, ...options }) => {
  const port = createDshNodeA2aTools({ ...options, ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
  try {
    const result = await port.execute('call_a2a_agent', args, { name: 'call_a2a_agent', arguments: args, callId: 'original-call',
      agent: { session: { id: 'session' } }, signal: new AbortController().signal });
    process.send({ pid: process.pid, result });
  } finally { await port.close(); process.disconnect(); }
});
