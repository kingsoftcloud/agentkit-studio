import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { createManagedNativeKernel } from '../../src/providers/native-managed-kernel.mjs';
import { createNativeKernelPermitVerifier } from '../../src/providers/native-kernel-permit.mjs';
import { binding, response, target, tool } from './native-managed-kernel.mjs';

const send = data => new Promise((resolve, reject) => process.send(data, error => error ? reject(error) : resolve()));
const hold = async boundary => { await send({ type: 'boundary', boundary, pid: process.pid });
  await new Promise(resolve => process.once('message', message => { if (message.type === 'continue') resolve(); })); };
process.once('message', async message => {
  let runtime;
  try {
    runtime = createManagedNativeKernel({ directory: message.directory, target, autoStart: message.autoStart === true, assertCurrent: () => true,
      ...(message.structuredInput ? { authorizeInteraction: ({ command }) => command.payload.token_ref === 'original-token' } : {}),
      permitVerifier: createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: message.publicKeyPem }) }),
      beforeProjection: async snapshot => {
        if (message.boundary === 'before-projection' && snapshot.phase === 'completed') await hold(message.boundary);
        if (message.boundary === 'paused' && snapshot.phase === 'paused') await send({ type: 'boundary', boundary: 'paused', pid: process.pid });
      },
      resolveBinding: ({ command }) => ({ ...binding(command, { model: { generate: async request => {
        appendFileSync(join(message.directory, 'models.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
        return request.messages.some(row => row.role === 'tool') ? response() : response({ kind: 'tool_calls', text: '',
          toolCalls: [{ callId: 'write-one', name: message.structuredInput ? 'call_a2a_agent' : 'write', arguments: {} }] });
      } }, tools: { execute: async request => {
        request.signal.throwIfAborted(); appendFileSync(join(message.directory, 'effects.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
        if (message.boundary === 'after-effect') await hold(message.boundary);
        if (message.structuredInput) return { status: 'uncertain', content: 'Original remote input pending' };
        return { status: 'ok', content: 'Written exactly once' };
      }, ...(message.structuredInput ? { observeReceipt: async request => ({ contract: request.contract,
        originalOperationKey: request.originalOperationKey, callId: request.call.callId,
        result: { status: 'ok', content: 'Original structured response consumed' } }) } : {}) } }, {
        tools: [tool(message.structuredInput ? { name: 'call_a2a_agent', recoveryPolicy: 'receipt-observation/v1' } : {})], limits: { leaseMs: 1000 } }),
      ...(message.structuredInput ? { withExecution: ({ identity, execute }) => execute({ onIdle: async (snapshot, context) => {
        const question = { contract: 'agentkit.a2a-question-wait/v1', interactionId: 'remote-original-question', continuationId: 'original-continuation',
          request: { request_type: 'structured_input', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'integer' } } } },
          deadlineAt: message.interactionDeadline, scopeId: 'original-scope', taskId: 'original-task',
          target: { local_name: 'remote', target_agent_id: 'remote-agent' }, pauseDigest: 'original-pause' };
        const answer = await runtime.presentA2aInteraction({ query: { scope: identity.scope, sessionId: identity.sessionId,
          runId: identity.runId, sourceRunId: identity.runId }, snapshot, ...context,
          wait: { ...question, questionDigest: createHash('sha256').update(canonical(question)).digest('hex') } });
        context.assertCurrent();
        if (message.boundary === 'structured-after-answer') await hold(message.boundary);
        appendFileSync(join(message.directory, 'delivered-answers.jsonl'), JSON.stringify({ pid: process.pid, answer }) + '\n');
        return { commandId: 'original-receipt-read', kind: 'reconcile_tool', payload: { originalOperationKey: snapshot.toolReconciliation.operationKey } };
      } }) } : message.withExecution ? { withExecution: ({ execute }) => execute() } : {}) }),
    });
    if (message.command) {
      const receipt = await runtime.receive(message.command, message.permit); await send({ type: 'receipt', receipt });
      if (message.boundary === 'before-start') await hold(message.boundary);
    }
    for (const control of message.controls ?? []) await runtime.receive(control.command, control.permit);
    if (message.receiveOnly) { await runtime.close(); process.disconnect(); return; }
    if (message.observeAutomatic) {
      const deadline = Date.now() + 8000;
      for (;;) {
        const status = await runtime.getStatus(message.query, message.readPermit);
        if (status.runs.length && ['completed', 'interrupted', 'canceled', 'failed'].includes(status.runs[0].phase)) break;
        if (Date.now() > deadline) throw new Error('Automatic recovery did not finish');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } else await runtime.drain(message.sessionId);
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
