import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createManagedNativeKernel } from '../../src/providers/native-managed-kernel.mjs';
import { createNativeKernelPermitVerifier } from '../../src/providers/native-kernel-permit.mjs';
import { binding, response, target, tool } from './native-managed-kernel.mjs';

const send = data => new Promise((resolve, reject) => process.send(data, error => error ? reject(error) : resolve()));
const hold = async boundary => { await send({ type: 'boundary', boundary, pid: process.pid });
  await new Promise(resolve => process.once('message', message => { if (message.type === 'continue') resolve(); })); };
process.once('message', async message => {
  let runtime;
  try {
    runtime = createManagedNativeKernel({ directory: message.directory, target, autoStart: false, assertCurrent: () => true,
      permitVerifier: createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: message.publicKeyPem }) }),
      beforeProjection: async snapshot => {
        if (message.boundary === 'before-projection' && snapshot.phase === 'completed') await hold(message.boundary);
        if (message.boundary === 'paused' && snapshot.phase === 'paused') await send({ type: 'boundary', boundary: 'paused', pid: process.pid });
      },
      resolveBinding: ({ command }) => ({ ...binding(command, { model: { generate: async request => {
        appendFileSync(join(message.directory, 'models.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
        return request.messages.some(row => row.role === 'tool') ? response() : response({ kind: 'tool_calls', text: '',
          toolCalls: [{ callId: 'write-one', name: 'write', arguments: {} }] });
      } }, tools: { execute: async request => {
        request.signal.throwIfAborted(); appendFileSync(join(message.directory, 'effects.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
        if (message.boundary === 'after-effect') await hold(message.boundary);
        return { status: 'ok', content: 'Written exactly once' };
      } } }, { tools: [tool()], limits: { leaseMs: 1000 } }),
      ...(message.withExecution ? { withExecution: ({ execute }) => execute() } : {}) }),
    });
    if (message.command) {
      const receipt = await runtime.receive(message.command, message.permit); await send({ type: 'receipt', receipt });
      if (message.boundary === 'before-start') await hold(message.boundary);
    }
    for (const control of message.controls ?? []) await runtime.receive(control.command, control.permit);
    if (message.receiveOnly) { await runtime.close(); process.disconnect(); return; }
    await runtime.drain(message.sessionId);
    const status = await runtime.getStatus(message.query, message.readPermit);
    const stream = await runtime.subscribe(message.subscription, message.subscribePermit), facts = [];
    for await (const fact of stream) { facts.push(fact); if (fact.event_type === 'control.run_transition'
      && ['completed', 'cancelled', 'failed', 'interrupted'].includes(fact.payload.state)) break; }
    await send({ type: 'result', status, facts, pid: process.pid }); await runtime.close(); process.disconnect();
  } catch (error) {
    await send({ type: 'failure', code: error.code, message: error.message, stack: error.stack });
    await runtime?.close(); process.exitCode = 1; process.disconnect();
  }
});
